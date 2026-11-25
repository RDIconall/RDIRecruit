import { readFileSync } from "node:fs";
import { backfillMissingResumes } from "../../src/lib/resume/backfill";

const passes = Number(process.argv[2] ?? "1");

function peak() {
  const status = readFileSync("/proc/self/status", "utf8");
  return {
    hwmKB: Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0),
    vmPeakKB: Number(status.match(/VmPeak:\s+(\d+)/)?.[1] ?? 0),
  };
}

async function main() {
  const results = [];
  for (let i = 0; i < passes; i += 1) {
    results.push(await backfillMissingResumes({ budgetMs: 120_000 }));
  }
  console.log(JSON.stringify({ results, ...peak() }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ fatal: message.slice(0, 500), ...peak() }));
  process.exit(1);
});
