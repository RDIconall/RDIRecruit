import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Spec for GHSA-m99w-x7hq-7vfj / CVE-2026-64641 (Next.js 16.0.0–16.2.10).
 *
 * An unauthenticated multipart POST, with no `next-action` header, is treated as
 * a possible MPA Server Action. `areAllActionIdsValid` calls `FormData.getAll`
 * once per `$ACTION_REF_` field. Each `getAll` scans the whole body. A valid
 * action id — published in the public client bundle — keeps that loop going for
 * every duplicate field, up to the 1 MB Server Action body limit. The loop is
 * synchronous, so other requests on the same process wait.
 *
 * These tests fail while `next` is inside 16.0.0–16.2.10 and pass on 16.2.11+,
 * which stops after two `$ACTION_REF_` fields. They are the patch spec; delete
 * them in the pull request that upgrades Next.js.
 *
 * Every `src/app/actions/*.ts` module is reached through this one Next.js
 * handler. There is no separate parser per action file.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOUNDARY = "rdi";
const BODY_BUDGET = 1_000_000;

// Obvious placeholder. Not a credential. Production-shaped so Clerk treats a
// cookieless request as signed out instead of starting a dev handshake.
const PUBLISHABLE_KEY = "pk_live_" + Buffer.from("example.com$").toString("base64");
const SECRET_KEY = "sk_live_placeholder";

const ROUTES: { path: string; worker: string }[] = [
  { path: "/sign-in", worker: "app/sign-in/[[...sign-in]]/page" },
  { path: "/sign-up", worker: "app/sign-up/[[...sign-up]]/page" },
  { path: "/preview/pool", worker: "app/preview/pool/page" },
  { path: "/preview/workflow", worker: "app/preview/workflow/page" },
  // Clerk's not-found rewrite still renders an App Router page that registers
  // the same Server Actions, so a protected path is the same handler.
  { path: "/", worker: "app/page" },
];

type ActionEntry = {
  workers?: Record<string, { moduleId?: string | number }>;
};

function nextVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "node_modules/next/package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

function manifest(): { node: Record<string, ActionEntry> } {
  return JSON.parse(
    fs.readFileSync(
      path.join(ROOT, ".next/server/server-reference-manifest.json"),
      "utf8",
    ),
  ) as { node: Record<string, ActionEntry> };
}

async function ensureBuild() {
  const version = nextVersion();
  const stampPath = path.join(ROOT, ".next/cache/server-action-cpu-next-version");
  const manifestPath = path.join(ROOT, ".next/server/server-reference-manifest.json");
  const stamped = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf8").trim() : "";
  if (fs.existsSync(manifestPath) && stamped === version) return;

  const build = spawn("npx", ["next", "build"], {
    cwd: ROOT,
    env: serverEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  build.stdout?.on("data", (chunk) => {
    log += chunk.toString();
  });
  build.stderr?.on("data", (chunk) => {
    log += chunk.toString();
  });
  const code = await exitCode(build);
  if (code !== 0) {
    throw new Error(`next build exited ${code}\n${log.slice(-4000)}`);
  }
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, version);
}

function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    CLERK_SECRET_KEY: SECRET_KEY,
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
  };
}

function part(name: string, value: string): string {
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

function attackBody(actionId: string): string {
  const descriptor = part(`$ACTION_s:0`, `{"id":"${actionId}","bound":null}`);
  const ref = part("$ACTION_REF_s", "");
  const end = `--${BOUNDARY}--\r\n`;
  const copies = Math.floor((BODY_BUDGET - descriptor.length - end.length) / ref.length);
  assert.ok(copies > 2, `expected many $ACTION_REF_ fields, got ${copies}`);
  return descriptor + ref.repeat(copies) + end;
}

function controlBody(byteLength: number): string {
  const junk = part("note", "");
  const end = `--${BOUNDARY}--\r\n`;
  const copies = Math.max(1, Math.floor((byteLength - end.length) / junk.length));
  return junk.repeat(copies) + end;
}

async function discoverActionId(origin: string, worker: string): Promise<string> {
  const html = await (await fetch(origin + "/sign-in")).text();
  const srcs = [
    ...new Set([...html.matchAll(/\/_next\/static\/[^"'\s>]+\.js/g)].map((match) => match[0])),
  ];
  const published = new Set<string>();
  for (const src of srcs) {
    const js = await (await fetch(origin + src)).text();
    for (const match of js.matchAll(/createServerReference\)\("([0-9a-f]{42})"/g)) {
      published.add(match[1]);
    }
  }
  assert.ok(published.size > 0, "public /sign-in scripts did not expose a server action id");

  const nodeActions = manifest().node;
  for (const id of published) {
    if (nodeActions[id]?.workers?.[worker]) return id;
  }
  throw new Error(`no public server action id is registered for ${worker}`);
}

async function healthStallDuring(
  origin: string,
  pathname: string,
  body: string,
): Promise<{ status: number; maxHealthMs: number }> {
  let done = false;
  let status = 0;
  const pending = fetch(origin + pathname, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body,
    signal: AbortSignal.timeout(20_000),
  }).then(async (response) => {
    status = response.status;
    await response.arrayBuffer();
    done = true;
  });

  const samples: number[] = [];
  const probe = (async () => {
    while (samples.length < 12) {
      const started = performance.now();
      const response = await fetch(origin + "/api/health", {
        signal: AbortSignal.timeout(20_000),
      });
      await response.arrayBuffer();
      samples.push(performance.now() - started);
      if (done) break;
    }
  })();

  await pending;
  await probe;
  assert.ok(samples.length > 0, `no health sample overlapped POST ${pathname}`);
  return { status, maxHealthMs: Math.max(...samples) };
}

function bounded(attackMs: number, controlMs: number): boolean {
  return attackMs <= controlMs * 2 + 40;
}

let server: ChildProcess | undefined;
let origin = "";

test("unauthenticated server-action posts do not stall the process", { timeout: 180_000 }, async () => {
  await ensureBuild();

  const port = 20000 + Math.floor(Math.random() * 20000);
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port)], {
    cwd: ROOT,
    env: serverEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout?.on("data", (chunk) => {
    log += chunk.toString();
  });
  server.stderr?.on("data", (chunk) => {
    log += chunk.toString();
  });

  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    if (server.exitCode != null) {
      throw new Error(`next start exited ${server.exitCode}\n${log.slice(-4000)}`);
    }
    try {
      const response = await fetch(origin + "/api/health");
      if (response.ok) {
        up = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(up, `server did not become ready\n${log.slice(-4000)}`);

  const actionId = await discoverActionId(origin, ROUTES[0].worker);
  const attack = attackBody(actionId);
  assert.ok(attack.length <= 1024 * 1024, `attack body ${attack.length} exceeds 1 MB`);
  const control = controlBody(attack.length);

  // Warm the route so the control sample is not a cold compile.
  await healthStallDuring(origin, "/sign-in", control.slice(0, 2000));

  const baseline = await healthStallDuring(origin, "/sign-in", control);
  const failures: string[] = [];
  for (const route of ROUTES) {
    const id = await discoverActionId(origin, route.worker);
    const body = attackBody(id);
    const result = await healthStallDuring(origin, route.path, body);
    if (!bounded(result.maxHealthMs, baseline.maxHealthMs)) {
      failures.push(
        `${route.path} stalled /api/health for ${result.maxHealthMs.toFixed(0)}ms ` +
          `(control ${baseline.maxHealthMs.toFixed(0)}ms, status ${result.status})`,
      );
    }
  }
  assert.deepEqual(
    failures,
    [],
    `Unbounded $ACTION_REF_ validation is still running.\n${failures.join("\n")}`,
  );
});

test.after(() => {
  if (!server || server.exitCode != null) return;
  server.kill("SIGKILL");
  server.stdout?.destroy();
  server.stderr?.destroy();
});
