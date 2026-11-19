import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Spec for the migration TLS bug. These tests fail while the scheduled migrate
// and reconcile jobs, and the manual migration script, accept an untrusted
// Postgres certificate. They pass once those sessions refuse it before sending
// a startup message, the database password, or any SQL.
//
// The peer speaks the Postgres frontend/backend protocol that pg 8.21.0 sends
// (SSLRequest, startup, cleartext password, simple Query, extended Parse/Bind).
// Messages are framed the way pg-protocol 1.14.0 parses and serializes them.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER_PASSWORD = "placeholder-not-a-secret";
const PLACEHOLDER_CRON_SECRET = "placeholder-cron-secret";

const SSL_REQUEST_CODE = 80877103;

type Capture = {
  sslRequests: number;
  plaintextChunks: number;
  appBytes: number;
  startups: number;
  passwords: string[];
  queries: number;
};

function emptyCapture(): Capture {
  return {
    sslRequests: 0,
    plaintextChunks: 0,
    appBytes: 0,
    startups: 0,
    passwords: [],
    queries: 0,
  };
}

function backend(code: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(1 + 4 + payload.length);
  out.write(code, 0, "ascii");
  out.writeInt32BE(4 + payload.length, 1);
  payload.copy(out, 5);
  return out;
}

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

function readCString(buf: Buffer, offset: number): { value: string; next: number } {
  const end = buf.indexOf(0, offset);
  if (end < 0) return { value: buf.toString("utf8", offset), next: buf.length };
  return { value: buf.toString("utf8", offset, end), next: end + 1 };
}

function authentication(code: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(code, 0);
  return backend("R", payload);
}

function readyForQuery(): Buffer {
  return backend("Z", Buffer.from("I", "ascii"));
}

function commandComplete(tag: string): Buffer {
  return backend("C", cstring(tag));
}

function rowDescription(): Buffer {
  const name = cstring("result");
  const field = Buffer.alloc(18);
  field.writeUInt32BE(0, 0);
  field.writeInt16BE(0, 4);
  field.writeUInt32BE(25, 6);
  field.writeInt16BE(-1, 10);
  field.writeInt32BE(-1, 12);
  field.writeInt16BE(0, 16);
  const count = Buffer.alloc(2);
  count.writeInt16BE(1, 0);
  return backend("T", Buffer.concat([count, name, field]));
}

function dataRow(value: string | null): Buffer {
  const count = Buffer.alloc(2);
  count.writeInt16BE(1, 0);
  if (value === null) {
    const len = Buffer.alloc(4);
    len.writeInt32BE(-1, 0);
    return backend("D", Buffer.concat([count, len]));
  }
  const bytes = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeInt32BE(bytes.length, 0);
  return backend("D", Buffer.concat([count, len, bytes]));
}

function isSelect(sql: string): boolean {
  const stripped = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)*/g, "").trim();
  return /^select\b/i.test(stripped);
}

function makeCertificate(): { key: Buffer; cert: Buffer; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untrusted-pg-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=untrusted.example",
    ],
    { stdio: "pipe" },
  );
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    dir,
  };
}

function attachSession(socket: net.Socket, secureContext: tls.SecureContext, capture: Capture) {
  const pending: Buffer[] = [];
  let taken = 0;

  const takePlain = (chunk: Buffer) => {
    pending.push(chunk);
    taken += chunk.length;
    if (taken < 8) return;
    socket.off("data", takePlain);
    socket.pause();
    const buf = Buffer.concat(pending);
    const length = buf.readInt32BE(0);
    const code = buf.readInt32BE(4);
    if (length !== 8 || code !== SSL_REQUEST_CODE) {
      capture.plaintextChunks += 1;
      socket.destroy();
      return;
    }
    capture.sslRequests += 1;
    const extra = buf.subarray(8);
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext,
    });
    secure.on("error", () => undefined);
    socket.on("error", () => undefined);
    if (extra.length > 0) socket.unshift(extra);
    socket.write("S");
    speakPostgres(secure, capture);
    socket.resume();
  };

  socket.on("data", takePlain);
  socket.on("error", () => undefined);
}

function speakPostgres(secure: tls.TLSSocket, capture: Capture) {
  let phase: "startup" | "ready" = "startup";
  let buffer = Buffer.alloc(0);
  let describedSql = "";

  const send = (frame: Buffer) => {
    if (!secure.destroyed) secure.write(frame);
  };

  const onStartup = (body: Buffer) => {
    capture.startups += 1;
    phase = "ready";
    send(authentication(3));
    void body;
  };

  const answerSimpleQuery = (sql: string) => {
    capture.queries += 1;
    if (isSelect(sql)) {
      send(rowDescription());
      if (/schema_migrations/i.test(sql) && /filename/i.test(sql)) {
        send(commandComplete("SELECT 0"));
      } else if (/to_regclass/i.test(sql)) {
        send(dataRow(null));
        send(commandComplete("SELECT 1"));
      } else {
        send(commandComplete("SELECT 0"));
      }
    } else {
      send(commandComplete("OK"));
    }
    send(readyForQuery());
  };

  const onMessage = (code: number, body: Buffer) => {
    if (code === 0x70) {
      capture.passwords.push(readCString(body, 0).value);
      const pid = Buffer.alloc(4);
      pid.writeInt32BE(1, 0);
      const secret = Buffer.alloc(4);
      secret.writeInt32BE(2, 0);
      send(authentication(0));
      send(backend("K", Buffer.concat([pid, secret])));
      send(readyForQuery());
      return;
    }
    if (code === 0x51) {
      answerSimpleQuery(readCString(body, 0).value);
      return;
    }
    if (code === 0x50) {
      const name = readCString(body, 0);
      const sql = readCString(body, name.next);
      describedSql = sql.value;
      capture.queries += 1;
      send(backend("1", Buffer.alloc(0)));
      return;
    }
    if (code === 0x42) {
      send(backend("2", Buffer.alloc(0)));
      return;
    }
    if (code === 0x44) {
      if (isSelect(describedSql)) send(rowDescription());
      else send(backend("n", Buffer.alloc(0)));
      return;
    }
    if (code === 0x45) {
      if (isSelect(describedSql)) send(commandComplete("SELECT 0"));
      else send(commandComplete("INSERT 0 1"));
      return;
    }
    if (code === 0x53) {
      send(readyForQuery());
      return;
    }
    if (code === 0x58) {
      secure.end();
    }
  };

  secure.on("data", (chunk: Buffer) => {
    capture.appBytes += chunk.length;
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (phase === "startup") {
        if (buffer.length < 4) return;
        const length = buffer.readInt32BE(0);
        if (length < 8 || buffer.length < length) return;
        const body = buffer.subarray(4, length);
        buffer = buffer.subarray(length);
        onStartup(body);
        continue;
      }
      if (buffer.length < 5) return;
      const code = buffer[0]!;
      const length = buffer.readInt32BE(1);
      if (length < 4 || buffer.length < 1 + length) return;
      const body = buffer.subarray(5, 1 + length);
      buffer = buffer.subarray(1 + length);
      onMessage(code, body);
    }
  });
}

async function listenUntrusted(): Promise<{
  port: number;
  capture: Capture;
  close: () => Promise<void>;
}> {
  const material = makeCertificate();
  const secureContext = tls.createSecureContext({ key: material.key, cert: material.cert });
  const capture = emptyCapture();
  const server = net.createServer((socket) => attachSession(socket, secureContext, capture));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return {
    port: address.port,
    capture,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          fs.rmSync(material.dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function databaseUrl(port: number): string {
  return `postgresql://migrator:${PLACEHOLDER_PASSWORD}@127.0.0.1:${port}/hiring`;
}

function scrubbedEnv(url: string, which: "database" | "supabase"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.PGSSLMODE;
  delete env.PGSSLROOTCERT;
  delete env.MIGRATION_TLS_ENTRY;
  delete env.WORKABLE_TOKEN;
  delete env.WORKABLE_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_KEY;
  delete env.SUPABASE_ANON_KEY;
  if (which === "database") {
    env.DATABASE_URL = url;
    delete env.SUPABASE_DB_URL;
  } else {
    delete env.DATABASE_URL;
    env.SUPABASE_DB_URL = url;
  }
  env.CRON_SECRET = PLACEHOLDER_CRON_SECRET;
  return env;
}

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 20000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function assertSessionRefused(capture: Capture) {
  const summary = `sslRequests=${capture.sslRequests} startups=${capture.startups} passwords=${capture.passwords.length} queries=${capture.queries} appBytes=${capture.appBytes}`;
  assert.ok(
    capture.sslRequests >= 1,
    `the client never asked to upgrade the database connection to TLS (${summary}, plaintext chunks: ${capture.plaintextChunks})`,
  );
  assert.equal(capture.plaintextChunks, 0, `the database session was sent without TLS (${summary})`);
  assert.equal(
    capture.appBytes,
    0,
    `the untrusted certificate received database session data (${summary})`,
  );
  assert.equal(capture.startups, 0, "a startup message was sent to the untrusted certificate");
  assert.equal(
    capture.passwords.length,
    0,
    "the database password was sent to the untrusted certificate",
  );
  assert.equal(
    capture.queries,
    0,
    `${capture.queries} SQL statements were sent to the untrusted certificate`,
  );
}

async function exercise(
  entry: string,
  which: "database" | "supabase",
): Promise<void> {
  const server = await listenUntrusted();
  try {
    const env = scrubbedEnv(databaseUrl(server.port), which);
    env.MIGRATION_TLS_ENTRY = entry;
    const result = await runProcess(process.execPath, ["--import", "tsx", path.join(REPO_ROOT, "tests/migration-tls.test.ts")], env);
    assertSessionRefused(server.capture);
    assert.notEqual(result.code, null, "the database client hung against the untrusted certificate");
  } finally {
    await server.close();
  }
}

async function exerciseScript(which: "database" | "supabase"): Promise<void> {
  const server = await listenUntrusted();
  try {
    const env = scrubbedEnv(databaseUrl(server.port), which);
    delete env.MIGRATION_TLS_ENTRY;
    const result = await runProcess(process.execPath, [path.join(REPO_ROOT, "scripts/apply-migrations.mjs")], env);
    assertSessionRefused(server.capture);
    assert.notEqual(result.code, null, "the migration script hung against the untrusted certificate");
  } finally {
    await server.close();
  }
}

async function runEntry(entry: string): Promise<void> {
  const certificateFailure = /self-signed certificate|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|unable to verify the first certificate|certificate/i;
  if (entry === "apply") {
    const { applyPendingMigrations } = await import("../src/lib/db/apply-migrations.ts");
    try {
      await applyPendingMigrations();
    } catch (error) {
      const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
      if (!certificateFailure.test(message)) {
        console.error(message);
        process.exit(1);
      }
      process.exit(0);
    }
    process.exit(2);
  }

  const { NextRequest } = await import("next/server");
  const route =
    entry === "migrate"
      ? await import("../src/app/api/cron/migrate/route.ts")
      : await import("../src/app/api/cron/reconcile/route.ts");
  const request = new NextRequest(`http://127.0.0.1/api/cron/${entry}`, {
    headers: { authorization: `Bearer ${PLACEHOLDER_CRON_SECRET}` },
  });
  const response = await route.GET(request);
  await response.text();
  process.exit(0);
}

if (process.env.MIGRATION_TLS_ENTRY) {
  void runEntry(process.env.MIGRATION_TLS_ENTRY).catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    console.error(message);
    process.exit(1);
  });
} else {
  test("applyPendingMigrations refuses an untrusted certificate for DATABASE_URL", async () => {
    await exercise("apply", "database");
  });

  test("applyPendingMigrations refuses an untrusted certificate for SUPABASE_DB_URL", async () => {
    await exercise("apply", "supabase");
  });

  test("the scheduled migrate route refuses an untrusted certificate", async () => {
    await exercise("migrate", "database");
  });

  test("the scheduled reconcile route refuses an untrusted certificate", async () => {
    await exercise("reconcile", "database");
  });

  test("the manual migration script refuses an untrusted certificate for DATABASE_URL", async () => {
    await exerciseScript("database");
  });

  test("the manual migration script refuses an untrusted certificate for SUPABASE_DB_URL", async () => {
    await exerciseScript("supabase");
  });
}
