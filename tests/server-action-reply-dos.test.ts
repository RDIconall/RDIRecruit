import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Next's action handler accepts a Server Action body up to this size when
// `serverActions.bodySizeLimit` is unset (next/dist/server/app-render/action-handler.js).
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

const CHILD_FLAG = "SERVER_ACTION_DOS_CHILD";
const thisFile = fileURLToPath(import.meta.url);

if (process.env[CHILD_FLAG] !== "1") {
  test("a crafted Server Action reply under the default body limit does not stall the process", () => {
    const result = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", thisFile],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          [CHILD_FLAG]: "1",
          NODE_ENV: "production",
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(
      result.status,
      0,
      `decoder probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });
} else {
  const require = createRequire(import.meta.url);
  const { decodeReply, decodeReplyFromBusboy } = require(
    "next/dist/compiled/react-server-dom-webpack/server.node.js",
  );
  const Busboy = require("next/dist/compiled/busboy");

  // One referenced FormData with `count` fields. The root model is last so
  // every entry is already stored when "$K" decoding scans them. Wire size
  // stays under the default Server Action body limit.
  function multipartReply(count: number): { body: Buffer; boundary: string } {
    const boundary = "----server-action-reply";
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="_1_${i}"\r\n\r\nx\r\n`,
      );
    }
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="0"\r\n\r\n["$K1"]\r\n`,
    );
    parts.push(`--${boundary}--\r\n`);
    return { body: Buffer.from(parts.join("")), boundary };
  }

  function formDataReply(count: number): FormData {
    const form = new FormData();
    for (let i = 0; i < count; i++) form.append(`_1_${i}`, "x");
    form.append("0", '["$K1"]');
    return form;
  }

  async function eventLoopLagDuring(work: () => Promise<unknown>): Promise<number> {
    const started = performance.now();
    let resumed = 0;
    const lag = new Promise<number>((resolve) => {
      setImmediate(() => {
        resumed = performance.now();
        resolve(resumed - started);
      });
    });
    await work();
    return lag;
  }

  async function decodeWithBusboy(body: Buffer, boundary: string): Promise<unknown> {
    const busboy = Busboy({
      defParamCharset: "utf8",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      limits: { fieldSize: DEFAULT_BODY_LIMIT_BYTES },
    });
    const decoded = decodeReplyFromBusboy(busboy, {});
    await Promise.all([pipeline(Readable.from(body), busboy), decoded]);
    return decoded;
  }

  function fieldCount(value: unknown): number {
    assert.ok(Array.isArray(value));
    const form = value[0];
    assert.ok(form instanceof FormData);
    let count = 0;
    form.forEach(() => {
      count += 1;
    });
    return count;
  }

  const smallCount = 2_000;
  const largeCount = 12_000;

  async function main(): Promise<void> {
    const small = multipartReply(smallCount);
    const large = multipartReply(largeCount);
    assert.ok(
      large.body.length <= DEFAULT_BODY_LIMIT_BYTES,
      `probe body is ${large.body.length} bytes, over the default Server Action limit`,
    );

    // Warm the decoder so the ratio measures parsing, not module init.
    await decodeWithBusboy(multipartReply(100).body, multipartReply(100).boundary);

    const smallBusboy = await eventLoopLagDuring(() =>
      decodeWithBusboy(small.body, small.boundary),
    );
    const largeBusboyValue = { current: undefined as unknown };
    const largeBusboy = await eventLoopLagDuring(async () => {
      largeBusboyValue.current = await decodeWithBusboy(large.body, large.boundary);
    });
    assert.equal(fieldCount(largeBusboyValue.current), largeCount);

    const largeFormValue = { current: undefined as unknown };
    const largeForm = await eventLoopLagDuring(async () => {
      largeFormValue.current = await decodeReply(formDataReply(largeCount), {});
    });
    assert.equal(fieldCount(largeFormValue.current), largeCount);

    // Six times as many fields. A linear scan stays near 6x. The vulnerable
    // backing store calls FormData.getAll/delete once per field, and each of
    // those walks the whole entry list, so the stall grows much faster.
    const fieldsRatio = largeCount / smallCount;
    const busboyBudget = smallBusboy * fieldsRatio * 1.5;
    assert.ok(
      largeBusboy < busboyBudget,
      `decodeReplyFromBusboy stalled the event loop for ${largeBusboy.toFixed(0)}ms ` +
        `on ${large.body.length} bytes (${largeCount} fields); linear budget was ` +
        `${busboyBudget.toFixed(0)}ms (small payload ${smallBusboy.toFixed(0)}ms)`,
    );
    assert.ok(
      largeForm < busboyBudget,
      `decodeReply stalled the event loop for ${largeForm.toFixed(0)}ms ` +
        `on ${largeCount} referenced fields; linear budget was ${busboyBudget.toFixed(0)}ms`,
    );

    console.log(
      JSON.stringify({
        bytes: large.body.length,
        smallBusboyMs: Math.round(smallBusboy),
        largeBusboyMs: Math.round(largeBusboy),
        largeFormMs: Math.round(largeForm),
        budgetMs: Math.round(busboyBudget),
      }),
    );
  }

  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
