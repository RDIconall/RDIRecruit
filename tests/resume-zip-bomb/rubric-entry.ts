import { readFileSync } from "node:fs";
import { extractRubricFromFile } from "../../src/app/actions/rubrics";

function peak() {
  const status = readFileSync("/proc/self/status", "utf8");
  return {
    hwmKB: Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0),
    vmPeakKB: Number(status.match(/VmPeak:\s+(\d+)/)?.[1] ?? 0),
  };
}

const buf = readFileSync(process.argv[2]);
const file = new File([buf], process.argv[3] || "rubric.docx", {
  type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});
const form = new FormData();
form.set("file", file);

extractRubricFromFile(form)
  .then((result) => {
    console.log(
      JSON.stringify({
        ok: result.ok,
        error: result.ok ? null : result.error,
        textLength: result.ok ? result.text.length : 0,
        text: result.ok ? result.text.slice(0, 120) : "",
        ...peak(),
      }),
    );
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ ok: false, error: message.slice(0, 300), textLength: 0, text: "", ...peak() }));
  });
