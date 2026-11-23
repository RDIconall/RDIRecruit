import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const runner = "src/lib/resume/ocr-image-overflow.runner.ts";

test("short-text résumé with a wide 16-bit image does not trap MuPDF during OCR", async () => {
  const child = spawn(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", runner],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve(status ?? 1));
  });

  assert.equal(
    code,
    0,
    `OCR rasterizer trapped or rejected the résumé (exit ${code}).\n${stdout}${stderr}`,
  );
});
