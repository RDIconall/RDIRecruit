import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = path.join(root, "node_modules/next/dist/bin/next");

// Outside host a browser would use after DNS rebinding onto the dev port.
// Same-origin for that page, and not on the dev server's allowlist.
const outsideHost = "outside.example";

type DevServer = {
  port: number;
  child: ChildProcess;
  stop: () => Promise<void>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function startDevServer(): Promise<DevServer> {
  return freePort().then(
    (port) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [nextBin, "dev", "--turbopack", "-p", String(port), "-H", "127.0.0.1"],
          {
            cwd: root,
            env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let log = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(probe);
          if (error) {
            void stopChild(child);
            reject(error);
            return;
          }
          resolve({ port, child, stop: () => stopChild(child) });
        };
        const onData = (chunk: Buffer) => {
          log += chunk.toString();
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("exit", (code) => {
          finish(new Error(`next dev exited ${code} before it accepted requests\n${log}`));
        });
        const probe = setInterval(() => {
          fetch(`http://127.0.0.1:${port}/_next/mcp`, {
            method: "POST",
            headers: {
              origin: `http://${outsideHost}:${port}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: "{}",
          })
            .then((response) => {
              if (response.status === 403 || response.status === 200) finish();
              return response.arrayBuffer();
            })
            .catch(() => undefined);
        }, 100);
        const timer = setTimeout(() => {
          finish(new Error(`next dev did not accept requests\n${log}`));
        }, 60_000);
      }),
  );
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill("SIGTERM");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function crossSite(
  port: number,
  requestPath: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
) {
  return fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method: init.method ?? "GET",
    body: init.body,
    redirect: "manual",
    headers: {
      origin: `http://${outsideHost}:${port}`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      ...(init.headers ?? {}),
    },
  });
}

async function assertRefused(
  port: number,
  requestPath: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  forbidden: string[] = [],
) {
  const response = await crossSite(port, requestPath, init);
  const body = await response.text();
  const preview = body.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "?").slice(0, 240);
  assert.equal(
    response.status,
    403,
    `${init.method ?? "GET"} ${requestPath} returned ${response.status}: ${preview}`,
  );
  assert.equal(body, "Unauthorized");
  for (const marker of forbidden) {
    assert.equal(body.includes(marker), false, `response leaked ${marker}`);
  }
}

function mcpCall(name: string, args: Record<string, unknown> = {}) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  };
}

function websocketUpgrade(port: number, requestPath: string) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          Origin: `http://${outsideHost}:${port}`,
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-Fetch-Site": "same-origin",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, body: "upgraded" });
    });
    request.setTimeout(5_000, () => {
      request.destroy();
      reject(new Error("websocket upgrade timed out"));
    });
    request.on("error", (error) => {
      resolve({ status: undefined, body: String(error) });
    });
    request.end();
  });
}

test("cross-site requests cannot read the dev server MCP endpoint or sibling dev endpoints", { timeout: 120_000 }, async () => {
  const dev = await startDevServer();
  const failures: string[] = [];
  const projectPath = root;
  const devtoolsConfig = path.join(root, ".next/dev/cache/next-devtools-config.json");
  const devtoolsBefore = fs.existsSync(devtoolsConfig) ? fs.readFileSync(devtoolsConfig) : null;

  async function check(name: string, run: () => Promise<void>) {
    try {
      await run();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await check("canonical MCP path stays refused", () =>
      assertRefused(dev.port, "/_next/mcp", mcpCall("get_project_metadata"), [projectPath]),
    );

    const exemptions = ["x=/_next/image", "x=/_next/static/media"];

    for (const query of exemptions) {
      await check(`get_project_metadata ?${query}`, () =>
        assertRefused(dev.port, `/_next/mcp?${query}`, mcpCall("get_project_metadata"), [projectPath]),
      );
    }

    await check("get_routes", () =>
      assertRefused(dev.port, "/_next/mcp?x=/_next/image", mcpCall("get_routes"), ["/api/health", "/preview/pool"]),
    );
    await check("get_logs", () =>
      assertRefused(dev.port, "/_next/mcp?x=/_next/image", mcpCall("get_logs"), [
        "next-development.log",
        projectPath,
      ]),
    );
    await check("get_errors", () =>
      assertRefused(dev.port, "/_next/mcp?x=/_next/image", mcpCall("get_errors")),
    );
    await check("get_page_metadata", () =>
      assertRefused(dev.port, "/_next/mcp?x=/_next/image", mcpCall("get_page_metadata")),
    );
    await check("get_server_action_by_id", () =>
      assertRefused(
        dev.port,
        "/_next/mcp?x=/_next/image",
        mcpCall("get_server_action_by_id", { actionId: "not-a-real-action" }),
        ["server-reference-manifest.json"],
      ),
    );
    await check("MCP path prefix", () =>
      assertRefused(dev.port, "/_next/mcp-extra?x=/_next/image", mcpCall("get_project_metadata"), [projectPath]),
    );

    const chunksDir = path.join(root, ".next/dev/static/chunks");
    const warm = await fetch(`http://127.0.0.1:${dev.port}/preview/pool`);
    await warm.arrayBuffer();
    const chunk = fs.existsSync(chunksDir)
      ? fs.readdirSync(chunksDir).find((name) => name.startsWith("src_") && name.endsWith(".js"))
      : undefined;
    assert.ok(chunk, `expected a compiled app chunk after warming /preview/pool (status ${warm.status})`);
    const chunkPath = path.join(chunksDir, chunk);

    await check("source map", () =>
      assertRefused(
        dev.port,
        `/__nextjs_source-map?filename=${encodeURIComponent(chunkPath)}&x=/_next/image`,
        {},
        ["sourcesContent", "preview/pool/page.tsx"],
      ),
    );
    await check("original stack frames", () =>
      assertRefused(dev.port, "/__nextjs_original-stack-frames?x=/_next/image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frames: [{ file: "src/middleware.ts", methodName: "fn", line1: 1, column1: 1 }],
          isServer: true,
          isEdgeServer: false,
          isAppDirectory: true,
        }),
      }),
    );
    await check("server status", () =>
      assertRefused(dev.port, "/__nextjs_server_status?x=/_next/image", {}, ["executionId"]),
    );
    await check("devtools config is not written", async () => {
      await assertRefused(dev.port, "/__nextjs_devtools_config?x=/_next/image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: "dark" }),
      });
      const after = fs.existsSync(devtoolsConfig) ? fs.readFileSync(devtoolsConfig) : null;
      assert.deepEqual(after, devtoolsBefore);
    });
    await check("disable dev indicator", () =>
      assertRefused(dev.port, "/__nextjs_disable_dev_indicator?x=/_next/image", { method: "POST" }),
    );
    await check("error feedback", () =>
      assertRefused(
        dev.port,
        "/__nextjs_error_feedback?errorCode=E1&wasHelpful=true&x=/_next/image",
      ),
    );
    await check("launch editor", () =>
      assertRefused(
        dev.port,
        "/__nextjs_launch-editor?file=missing-file-for-cross-site-test.ts&isAppRelativePath=1&x=/_next/image",
      ),
    );
    await check("attach inspector", () =>
      assertRefused(dev.port, "/__nextjs_attach-nodejs-inspector?x=/_next/image", {}, ["devtools"]),
    );
    await check("dev overlay font", () =>
      assertRefused(dev.port, "/__nextjs_font/geist-latin.woff2?x=/_next/image"),
    );
    await check("hmr websocket", async () => {
      const upgrade = await websocketUpgrade(dev.port, "/_next/webpack-hmr?x=/_next/image");
      assert.notEqual(upgrade.status, 101, `websocket upgraded: ${upgrade.body}`);
      // A refusal written to the raw upgrade socket is not a valid HTTP response,
      // so the client reports a parse error instead of status 403.
      const refused =
        upgrade.status === 403 ||
        upgrade.body.includes("Unauthorized") ||
        upgrade.body.includes("HPE_INVALID_CONSTANT");
      assert.ok(refused, `websocket was not refused: status ${upgrade.status} body ${upgrade.body}`);
    });
    await check("restart dev server", async () => {
      const response = await crossSite(dev.port, "/__nextjs_restart_dev?x=/_next/image", { method: "POST" });
      const body = await response.text();
      assert.equal(response.status, 403, body.slice(0, 300));
      assert.equal(body, "Unauthorized");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(dev.child.exitCode, null);
    });
  } finally {
    await dev.stop();
  }

  assert.equal(failures.length, 0, failures.join("\n\n"));
});
