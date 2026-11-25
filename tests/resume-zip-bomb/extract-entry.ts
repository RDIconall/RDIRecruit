import { readFileSync } from "node:fs";
import { extractTextFromResume } from "../../src/lib/resume/extract-text";

const file = process.argv[2];
const extension = process.argv[3] || "docx";
const mime =
  extension === "doc"
    ? "application/msword"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function peak() {
  const status = readFileSync("/proc/self/status", "utf8");
  return {
    hwmKB: Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0),
    vmPeakKB: Number(status.match(/VmPeak:\s+(\d+)/)?.[1] ?? 0),
  };
}

extractTextFromResume(readFileSync(file), mime, extension)
  .then((text) => {
    console.log(JSON.stringify({ ok: true, textLength: text.length, text: text.slice(0, 120), error: null, ...peak() }));
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ ok: false, textLength: 0, text: "", error: message.slice(0, 300), ...peak() }));
  });
