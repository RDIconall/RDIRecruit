/**
 * Spec for the App Router server-action reply decoder shipped with next.
 *
 * Run:
 *   node --conditions=react-server --test tests/server-action-reply-cpu.test.mjs
 *
 * `npm test` runs tests/server-action-reply-cpu.runner.test.ts, which spawns
 * that command. The assertions fail while the installed next decoder burns
 * the event loop on a crafted multipart reply, and pass once that decoder
 * handles the same reply cheaply.
 *
 * The body stays at or under the default 1 MiB server-action limit in
 * next/dist/server/app-render/action-handler.js (1024 * 1024). Field names
 * are the Flight reply encoding of one FormData argument (`$K1` plus `_1_*`
 * entries). Referenced fields are sent before chunk "0", which is the order
 * that makes decodeReplyFromBusboy parse them.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

const require = createRequire(import.meta.url);

const BODY_LIMIT_BYTES = 1024 * 1024;
const FIELD_COUNT = 12000;
// Vulnerable next 16.2.9 spends well above this on the payload below.
// next 16.4.1 decodes the same payload well under it.
const MAX_EVENT_LOOP_BLOCK_MS = 200;

function craftedMultipart(fieldCount) {
  const boundary = "----rdi";
  const parts = [];
  for (let i = 0; i < fieldCount; i++) {
    const name = `_1_${i.toString(36)}`;
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nx\r\n`,
    );
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="0"\r\n\r\n"$K1"\r\n--${boundary}--\r\n`,
  );
  return {
    body: Buffer.from(parts.join("")),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function loadDecoder(kind) {
  return require(
    `next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-server.node.${kind}.js`,
  );
}

async function decodeThroughBusboy(decodeReplyFromBusboy, body, contentType) {
  const Busboy = require("next/dist/compiled/busboy");
  const busboy = Busboy({
    headers: { "content-type": contentType },
    defParamCharset: "utf8",
    limits: { fieldSize: BODY_LIMIT_BYTES },
  });
  const started = performance.now();
  const pending = decodeReplyFromBusboy(busboy, {});
  await pipeline(Readable.from(body), busboy);
  const decoded = await pending;
  return { elapsedMs: performance.now() - started, decoded };
}

function countFormFields(formData) {
  let count = 0;
  formData.forEach(() => {
    count += 1;
  });
  return count;
}

test("the app still exposes server actions for the reply decoder to attach to", () => {
  const { readdirSync, readFileSync } = require("node:fs");
  const modules = readdirSync("src/app/actions").filter((name) => name.endsWith(".ts"));
  assert.ok(modules.length >= 1);
  for (const name of modules) {
    const source = readFileSync(`src/app/actions/${name}`, "utf8");
    assert.match(source, /^"use server";/);
  }
});

test("a multipart POST with next-action is a fetch server action", () => {
  const { getServerActionRequestMetadata } = require("next/dist/server/lib/server-action-request-meta.js");
  const metadata = getServerActionRequestMetadata({
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=----rdi",
      "next-action": "0".repeat(42),
    },
  });
  assert.equal(metadata.isMultipartAction, true);
  assert.equal(metadata.isFetchAction, true);
  assert.equal(metadata.isPossibleServerAction, true);
  assert.equal(metadata.isURLEncodedAction, false);
});

for (const kind of ["production", "development"]) {
  test(`${kind} server-action reply decoder does not stall on a crafted FormData argument`, async () => {
    const { body, contentType } = craftedMultipart(FIELD_COUNT);
    assert.ok(
      body.length <= BODY_LIMIT_BYTES,
      `crafted body is ${body.length} bytes, over the default server-action limit`,
    );

    const { decodeReplyFromBusboy } = loadDecoder(kind);
    const { elapsedMs, decoded } = await decodeThroughBusboy(
      decodeReplyFromBusboy,
      body,
      contentType,
    );
    assert.equal(countFormFields(decoded), FIELD_COUNT);
    assert.ok(
      elapsedMs < MAX_EVENT_LOOP_BLOCK_MS,
      `${kind} decodeReplyFromBusboy blocked for ${elapsedMs.toFixed(0)}ms ` +
        `(limit ${MAX_EVENT_LOOP_BLOCK_MS}ms) on ${body.length} bytes`,
    );
  });
}

test("production decodeReply does not stall on the same FormData argument", async () => {
  const { body } = craftedMultipart(FIELD_COUNT);
  assert.ok(body.length <= BODY_LIMIT_BYTES);

  const form = new FormData();
  for (let i = 0; i < FIELD_COUNT; i++) {
    form.append(`_1_${i.toString(36)}`, "x");
  }
  form.append("0", '"$K1"');

  const { decodeReply } = loadDecoder("production");
  const started = performance.now();
  const decoded = await decodeReply(form, {});
  const elapsedMs = performance.now() - started;
  assert.equal(countFormFields(decoded), FIELD_COUNT);
  assert.ok(
    elapsedMs < MAX_EVENT_LOOP_BLOCK_MS,
    `decodeReply blocked for ${elapsedMs.toFixed(0)}ms (limit ${MAX_EVENT_LOOP_BLOCK_MS}ms)`,
  );
});
