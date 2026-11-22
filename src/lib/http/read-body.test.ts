import assert from "node:assert/strict";
import test from "node:test";
import { readBodyWithLimit } from "./read-body.ts";

const CAP = 4096;

function streamOf(total: number, chunkBytes = 256) {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, total - sent);
      controller.enqueue(new Uint8Array(size).fill(0x61));
      sent += size;
    },
  });
  return { stream, pulled: () => sent };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/hook", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
}

test("returns the body when Content-Length is honest and within the cap", async () => {
  const text = "x".repeat(CAP);
  const result = await readBodyWithLimit(post(text, { "content-length": String(CAP) }), CAP);
  assert.deepEqual(result, { ok: true, text });
});

test("returns a small body sent without Content-Length", async () => {
  const { stream } = streamOf(1000);
  const result = await readBodyWithLimit(post(stream), CAP);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.text.length, 1000);
});

test("refuses a declared length over the cap without pulling the body", async () => {
  const { stream, pulled } = streamOf(CAP * 10);
  const result = await readBodyWithLimit(
    post(stream, { "content-length": String(CAP * 10) }),
    CAP,
  );
  assert.deepEqual(result, { ok: false, status: 413, error: "Payload too large" });
  assert.equal(pulled(), 0);
});

test("refuses a body without Content-Length once it reaches the cap", async () => {
  const { stream, pulled } = streamOf(CAP * 10);
  const result = await readBodyWithLimit(post(stream), CAP);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 413);
  assert.ok(pulled() <= CAP, `pulled ${pulled()} bytes`);
});

test("refuses a body that runs past an understated Content-Length", async () => {
  const { stream, pulled } = streamOf(CAP * 10);
  const result = await readBodyWithLimit(post(stream, { "content-length": "16" }), CAP);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 413);
  assert.ok(pulled() <= CAP, `pulled ${pulled()} bytes`);
});

test("refuses a malformed Content-Length", async () => {
  const { stream, pulled } = streamOf(100);
  const result = await readBodyWithLimit(post(stream, { "content-length": "1e9" }), CAP);
  assert.deepEqual(result, { ok: false, status: 400, error: "Invalid Content-Length" });
  assert.equal(pulled(), 0);
});

test("treats a missing body as empty", async () => {
  const result = await readBodyWithLimit(post(null), CAP);
  assert.deepEqual(result, { ok: true, text: "" });
});
