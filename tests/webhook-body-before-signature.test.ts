import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { NextRequest } from "next/server";

/**
 * Spec for the public webhook body handling.
 *
 * These tests call the real route handlers. They fail while a handler buffers
 * an oversized body before rejecting it, or writes an event before both the
 * size check and the signature check have passed.
 *
 * Secure behavior:
 * - WORKABLE_WEBHOOK_SECRET and VIDEOASK_WEBHOOK_SECRET are required. A blank
 *   or unset secret is a 401 and writes nothing.
 * - When Content-Length is greater than 64KB, respond 413 before pulling any
 *   body byte, and write nothing. A valid signature does not waive the limit.
 * - When Content-Length is missing or smaller than the bytes the client sends,
 *   pull at most 64KB (the body is delivered in 1024-byte chunks; do not pull
 *   a chunk that would pass 64KB), respond 413, and write nothing.
 * - A body of at most 64KB with a valid signature is still enqueued, and the
 *   stored payload is the object that was signed.
 *
 * Calendly (`src/app/api/hooks/calendly/route.ts`), Fireflies
 * (`src/app/api/ingest/fireflies/route.ts`), and Gmail
 * (`src/app/api/ingest/gmail/route.ts`) also accept a public body and call
 * `recordEvent`, but they have no signature check. They are not covered here.
 */

const MAX_BODY_BYTES = 64 * 1024;
const WORKABLE_SECRET = "test-webhook-secret";
const VIDEOASK_SECRET = "test-videoask-secret";
const EVENT_ROW_ID = "11111111-1111-4111-8111-111111111111";

type CapturedInsert = {
  bytes: number;
  source?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

const inserts: CapturedInsert[] = [];
let server: http.Server | undefined;

let env: {
  WORKABLE_WEBHOOK_SECRET?: string;
  VIDEOASK_WEBHOOK_SECRET?: string;
};
let workablePost: (request: NextRequest) => Promise<Response>;
let videoaskPost: (request: NextRequest) => Promise<Response>;

test.before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = req.url ?? "";
      if (req.method === "POST" && path.includes("/rest/v1/events")) {
        let parsed: Record<string, unknown> | null = null;
        if (raw.length <= MAX_BODY_BYTES * 2) {
          try {
            parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
        }
        const head = raw.subarray(0, 160).toString("utf8");
        const payload = parsed?.payload;
        inserts.push({
          bytes: raw.length,
          source:
            typeof parsed?.source === "string"
              ? parsed.source
              : head.match(/"source":"([^"]+)"/)?.[1],
          type:
            typeof parsed?.type === "string"
              ? parsed.type
              : head.match(/"type":"([^"]+)"/)?.[1],
          payload:
            payload && typeof payload === "object"
              ? (payload as Record<string, unknown>)
              : undefined,
        });
      }
      const body = JSON.stringify([{ id: EVENT_ROW_ID }]);
      res.writeHead(req.method === "POST" ? 201 : 200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
      });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_KEY = "test-service-key";
  delete process.env.WORKABLE_WEBHOOK_SECRET;
  delete process.env.VIDEOASK_WEBHOOK_SECRET;

  const envModule = await import("../src/lib/env.ts");
  env = envModule.env;
  const workable = await import("../src/app/api/hooks/workable/route.ts");
  const videoask = await import("../src/app/api/hooks/videoask/route.ts");
  workablePost = workable.POST;
  videoaskPost = videoask.POST;
});

test.after(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
});

test.beforeEach(() => {
  inserts.length = 0;
  env.WORKABLE_WEBHOOK_SECRET = WORKABLE_SECRET;
  env.VIDEOASK_WEBHOOK_SECRET = VIDEOASK_SECRET;
});

function byteStream(payload: Uint8Array | number, chunkBytes = 1024): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
} {
  const source = typeof payload === "number" ? new Uint8Array(payload).fill(0x61) : payload;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= source.byteLength) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, source.byteLength - sent);
      controller.enqueue(source.subarray(sent, sent + size));
      sent += size;
    },
  });
  return { stream, pulled: () => sent };
}

function jsonOfSize(bytes: number, eventType: string): string {
  const prefix = `{"event_type":${JSON.stringify(eventType)},"note":"`;
  const suffix = '"}';
  const fill = bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(fill > 0, `size ${bytes} is too small for the JSON envelope`);
  return prefix + "x".repeat(fill) + suffix;
}

function workableSignature(rawBody: string, secret = WORKABLE_SECRET): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function videoaskSignature(rawBody: string, secret = VIDEOASK_SECRET): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function webhookRequest(
  path: string,
  body: BodyInit,
  headers: Record<string, string>,
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body,
    duplex: "half",
    headers,
  });
}

async function call(
  handler: (request: NextRequest) => Promise<Response>,
  request: NextRequest,
  pulled: () => number,
): Promise<Response> {
  try {
    return await handler(request);
  } catch (error) {
    assert.fail(
      `handler threw after pulling ${pulled()} bytes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function queuedSummary(): string {
  return inserts
    .map((row) => {
      const marker = row.payload?.marker;
      return `queued ${row.source ?? "?"}/${row.type ?? "?"} (${row.bytes} bytes${
        typeof marker === "string" ? `, marker=${marker}` : ""
      })`;
    })
    .join("; ");
}

function assertRefused(
  response: Response,
  pulled: number,
  mode: "unread" | "capped",
  minPulled = 0,
): void {
  const problems: string[] = [];
  const overCap = pulled > MAX_BODY_BYTES;
  const stoppedAtDeclaredLength = minPulled > 0 && pulled <= minPulled;
  const tooMuch = mode === "unread" ? pulled !== 0 : overCap || stoppedAtDeclaredLength;
  if (tooMuch) {
    problems.push(`pulled ${pulled} bytes`);
  }
  if (inserts.length) problems.push(queuedSummary());
  if (response.status !== 413) problems.push(`status ${response.status}`);
  assert.equal(problems.length, 0, problems.join("; "));
}

function assertUnauthorized(response: Response): void {
  const problems: string[] = [];
  if (inserts.length) problems.push(queuedSummary());
  if (response.status !== 401) problems.push(`status ${response.status}`);
  assert.equal(problems.length, 0, problems.join("; "));
}

test("workable: content-length over 64KB is rejected before the body is read, even with a valid signature", async () => {
  const raw = jsonOfSize(2 * 1024 * 1024, "candidate_created");
  const encoded = new TextEncoder().encode(raw);
  const { stream, pulled } = byteStream(encoded);
  // The signature covers the bytes the client sends. The handler must still
  // refuse on Content-Length before it pulls those bytes.
  const signature = workableSignature(raw);
  const response = await call(
    workablePost,
    webhookRequest("/api/hooks/workable", stream, {
      "content-type": "application/json",
      "content-length": String(encoded.byteLength),
      "x-workable-signature": signature,
    }),
    pulled,
  );
  assertRefused(response, pulled(), "unread");
});

test("workable: an invalid signature on an oversized content-length still pulls no body bytes", async () => {
  const total = 2 * 1024 * 1024;
  const { stream, pulled } = byteStream(total);
  const response = await call(
    workablePost,
    webhookRequest("/api/hooks/workable", stream, {
      "content-type": "application/json",
      "content-length": String(total),
      "x-workable-signature": "not-a-valid-signature",
    }),
    pulled,
  );
  assertRefused(response, pulled(), "unread");
});

test("workable: a missing content-length cannot grow the buffer past 64KB", async () => {
  const total = MAX_BODY_BYTES + 32 * 1024;
  const { stream, pulled } = byteStream(total);
  const response = await call(
    workablePost,
    webhookRequest("/api/hooks/workable", stream, {
      "content-type": "application/json",
      "x-workable-signature": "not-a-valid-signature",
    }),
    pulled,
  );
  assertRefused(response, pulled(), "capped");
});

test("workable: a lying content-length cannot grow the buffer past 64KB", async () => {
  const total = MAX_BODY_BYTES + 32 * 1024;
  const { stream, pulled } = byteStream(total);
  const response = await call(
    workablePost,
    webhookRequest("/api/hooks/workable", stream, {
      "content-type": "application/json",
      "content-length": "16",
      "x-workable-signature": "not-a-valid-signature",
    }),
    pulled,
  );
  assertRefused(response, pulled(), "capped", 16);
});

test("workable: a blank webhook secret does not enqueue an unsigned body", async () => {
  env.WORKABLE_WEBHOOK_SECRET = "";
  const raw = JSON.stringify({
    event_type: "not_a_candidate_event",
    marker: "unsigned-blank-secret",
  });
  const response = await call(
    workablePost,
    webhookRequest("/api/hooks/workable", raw, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
    }),
    () => 0,
  );
  assertUnauthorized(response);
});

test("workable: an unset webhook secret does not enqueue an unsigned body", async () => {
  env.WORKABLE_WEBHOOK_SECRET = undefined;
  const raw = JSON.stringify({
    event_type: "not_a_candidate_event",
    marker: "unsigned-unset-secret",
  });
  const response = await call(
    workablePost,
    webhookRequest("/api/hooks/workable", raw, {
      "content-type": "application/json",
    }),
    () => 0,
  );
  assertUnauthorized(response);
});

test("workable: an invalid signature on a small body does not enqueue it", async () => {
  const raw = JSON.stringify({
    event_type: "not_a_candidate_event",
    marker: "bad-signature",
  });
  const response = await call(
    workablePost,
    webhookRequest("/api/hooks/workable", raw, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
      "x-workable-signature": "not-a-valid-signature",
    }),
    () => 0,
  );
  assertUnauthorized(response);
});

test("workable: a signed body of exactly 64KB is enqueued as the object that was signed", async () => {
  const raw = jsonOfSize(MAX_BODY_BYTES, "healthcheck");
  const response = await call(
    workablePost,
    webhookRequest("/api/hooks/workable", raw, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
      "x-workable-signature": workableSignature(raw),
    }),
    () => 0,
  );
  assert.equal(response.status, 200);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].source, "workable");
  assert.equal(inserts[0].type, "healthcheck");
  assert.deepEqual(inserts[0].payload, JSON.parse(raw));
});

test("workable: one byte over 64KB is not enqueued even when the signature matches the whole body", async () => {
  const raw = jsonOfSize(MAX_BODY_BYTES + 1, "healthcheck");
  const { stream, pulled } = byteStream(new TextEncoder().encode(raw));
  const response = await call(
    workablePost,
    webhookRequest("/api/hooks/workable", stream, {
      "content-type": "application/json",
      "x-workable-signature": workableSignature(raw),
    }),
    pulled,
  );
  assertRefused(response, pulled(), "capped");
});

test("videoask: content-length over 64KB is rejected before the body is read", async () => {
  const raw = jsonOfSize(2 * 1024 * 1024, "response");
  const encoded = new TextEncoder().encode(raw);
  const { stream, pulled } = byteStream(encoded);
  const response = await call(
    videoaskPost,
    webhookRequest("/api/hooks/videoask", stream, {
      "content-type": "application/json",
      "content-length": String(encoded.byteLength),
      "x-videoask-signature": videoaskSignature(raw),
    }),
    pulled,
  );
  assertRefused(response, pulled(), "unread");
});

test("videoask: a missing content-length cannot grow the buffer past 64KB", async () => {
  const total = MAX_BODY_BYTES + 32 * 1024;
  const { stream, pulled } = byteStream(total);
  const response = await call(
    videoaskPost,
    webhookRequest("/api/hooks/videoask", stream, {
      "content-type": "application/json",
    }),
    pulled,
  );
  assertRefused(response, pulled(), "capped");
});

test("videoask: a lying content-length cannot grow the buffer past 64KB", async () => {
  const total = MAX_BODY_BYTES + 32 * 1024;
  const { stream, pulled } = byteStream(total);
  const response = await call(
    videoaskPost,
    webhookRequest("/api/hooks/videoask", stream, {
      "content-type": "application/json",
      "content-length": "16",
    }),
    pulled,
  );
  assertRefused(response, pulled(), "capped", 16);
});

test("videoask: a blank webhook secret does not enqueue an unsigned body", async () => {
  env.VIDEOASK_WEBHOOK_SECRET = "";
  const raw = JSON.stringify({ marker: "videoask-unsigned", event: "response" });
  const response = await call(
    videoaskPost,
    webhookRequest("/api/hooks/videoask", raw, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
    }),
    () => 0,
  );
  assertUnauthorized(response);
});

test("videoask: an invalid signature on a small body does not enqueue it", async () => {
  const raw = JSON.stringify({ marker: "videoask-bad-signature" });
  const response = await call(
    videoaskPost,
    webhookRequest("/api/hooks/videoask", raw, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
      "x-videoask-signature": "not-a-valid-signature",
    }),
    () => 0,
  );
  assertUnauthorized(response);
});

test("videoask: a signed body under the cap is enqueued as the object that was signed", async () => {
  const raw = JSON.stringify({ marker: "videoask-signed", event: "response" });
  const response = await call(
    videoaskPost,
    webhookRequest("/api/hooks/videoask", raw, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
      "x-videoask-signature": videoaskSignature(raw),
    }),
    () => 0,
  );
  assert.equal(response.status, 200);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].source, "videoask");
  assert.equal(inserts[0].type, "response");
  assert.deepEqual(inserts[0].payload, JSON.parse(raw));
});
