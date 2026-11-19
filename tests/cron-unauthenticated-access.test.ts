/**
 * Spec for the cron fail-open authentication bug.
 *
 * These tests fail while a cron handler treats a missing or empty CRON_SECRET
 * as permission to read or change applicant reviews. They pass when every cron
 * route returns 401 before any of that work, including when the secret is
 * removed after the module is loaded. A configured secret still has to be
 * compared against the bearer token on that request.
 *
 * Run:
 *   node --conditions=react-server --import tsx --test tests/cron-unauthenticated-access.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RouteResult = {
  name: string;
  path: string;
  status: number;
  body: string;
  includesName: boolean;
  includesRole: boolean;
  includesCompany: boolean;
  includesRationale: boolean;
  includesProfile: boolean;
  includesJob: boolean;
};

type OpenResult = {
  routes: RouteResult[];
  alternateBearer: RouteResult | null;
  delivered: Array<{ to: string; includesRationale: boolean }>;
  tcpConnections: number;
  mutations: Array<{ method: string; table: string }>;
  outbound: string[];
};

function run(scenario: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = ["--import", "tsx", path.join("tests", "helpers", "cron-attack-harness.ts"), scenario];
    // Route handlers import `server-only`, which resolves to an empty module
    // only under the react-server condition. Middleware loads Next's client
    // runtime, which needs the default React build instead.
    if (scenario !== "middleware") args.unshift("--conditions=react-server");
    const child = spawn(
      process.execPath,
      args,
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME ?? "/tmp",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          NODE_ENV: "production",
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`harness ${scenario} exited ${code}\n${stderr}\n${stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`harness ${scenario} did not return JSON\n${stderr}\n${stdout}\n${error}`));
      }
    });
  });
}

function route(result: OpenResult, name: string): RouteResult {
  const found = result.routes.find((item) => item.name === name);
  assert.ok(found, `missing route result ${name}`);
  return found;
}

function assertClosed(result: RouteResult, label: string) {
  assert.equal(result.status, 401, `${label} returned ${result.status}: ${result.body.slice(0, 300)}`);
  assert.equal(result.includesName, false, label);
  assert.equal(result.includesRole, false, label);
  assert.equal(result.includesCompany, false, label);
  assert.equal(result.includesRationale, false, label);
  assert.equal(result.includesProfile, false, label);
  assert.equal(result.includesJob, false, label);
}

function assertNoEffects(result: OpenResult, label: string) {
  assert.equal(result.tcpConnections, 0, `${label} opened a database connection`);
  assert.deepEqual(result.mutations, [], `${label} wrote applicant data`);
  assert.deepEqual(result.outbound, [], `${label} called an external service`);
  assert.deepEqual(result.delivered, [], `${label} sent mail`);
}

test("middleware matches every cron path and does not apply Clerk protection there", async () => {
  const result = (await run("middleware")) as {
    matched: Record<string, boolean>;
    cron: { status: number | null; location: string | null; rewrite: string | null; next: string | null };
    guarded: { status: number | null; location: string | null; rewrite: string | null; next: string | null };
  };
  for (const [pathname, matched] of Object.entries(result.matched)) {
    assert.equal(matched, true, pathname);
  }
  assert.equal(result.cron.location, null);
  assert.equal(result.cron.status, 200);
  // NextResponse.next() carries a rewrite to the same path. Clerk's protect()
  // path instead rewrites to a generated /clerk_<timestamp> not-found URL.
  assert.equal(result.cron.rewrite ? new URL(result.cron.rewrite).pathname : null, "/api/cron/daily-summary");
  assert.match(result.guarded.rewrite ?? "", /\/clerk_\d+$/);
  assert.equal(result.guarded.location, null);
});

test("unset CRON_SECRET still refuses every cron route before any read, send, or write", async () => {
  const result = (await run("open")) as OpenResult;
  for (const item of result.routes) assertClosed(item, item.name);
  assert.ok(result.alternateBearer);
  assertClosed(result.alternateBearer, "bearer undefined");
  assertNoEffects(result, "unset CRON_SECRET");
});

test("empty CRON_SECRET still refuses every cron route before any read, send, or write", async () => {
  const result = (await run("empty")) as OpenResult;
  for (const item of result.routes) assertClosed(item, item.name);
  assertNoEffects(result, "empty CRON_SECRET");
});

test("blank bearer is refused when CRON_SECRET is unset", async () => {
  const result = (await run("blank-bearer")) as OpenResult;
  assertClosed(route(result, "daily-summary-dry"), "blank bearer");
  assertClosed(route(result, "daily-summary-send"), "blank bearer send");
  assertNoEffects(result, "blank bearer");
});

test("a secret captured at import is still required if the environment variable is cleared before the request", async () => {
  const result = (await run("reread")) as OpenResult;
  for (const item of result.routes) assertClosed(item, item.name);
  assertNoEffects(result, "cleared CRON_SECRET");
});

test("a configured secret rejects the wrong bearer and still allows the matching bearer", async () => {
  const result = (await run("closed")) as {
    wrong: RouteResult[];
    afterWrong: { delivered: number; tcpConnections: number; mutations: number; outbound: number };
    right: RouteResult[];
  };
  for (const item of result.wrong) assertClosed(item, item.name);
  assert.equal(result.afterWrong.delivered, 0);
  assert.equal(result.afterWrong.tcpConnections, 0);
  assert.equal(result.afterWrong.mutations, 0);
  assert.equal(result.afterWrong.outbound, 0);
  const preview = result.right.find((item) => item.name === "daily-summary-dry");
  assert.ok(preview);
  assert.notEqual(preview.status, 401);
  assert.equal(preview.includesName, true);
  assert.equal(preview.includesRole, true);
  assert.equal(preview.includesCompany, true);
  assert.equal(preview.includesRationale, true);
  assert.equal(preview.includesProfile, true);
  assert.equal(preview.includesJob, true);
  const sent = result.right.find((item) => item.name === "daily-summary-send");
  assert.ok(sent);
  assert.notEqual(sent.status, 401);
});
