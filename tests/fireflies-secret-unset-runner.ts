/**
 * Child process: FIREFLIES_WEBHOOK_SECRET is unset. A short transcript posted
 * to the public ingest route must be refused, and neither events nor evidence
 * may be written. Spawned so env is parsed once in a clean process.
 */
Object.assign(process.env, { NODE_ENV: "development" });
process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "test-service-role-placeholder";
delete process.env.FIREFLIES_WEBHOOK_SECRET;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.VIDEOASK_WEBHOOK_SECRET;

async function main(): Promise<void> {
const { memory, loadIngestApp } = await import("./helpers/ingest-app");
const { NextRequest } = await import("next/server");

memory.reset({
  jobs: [{ shortcode: "JOB1", title: "Clinical Role", status: "published" }],
  candidates: [
    {
      workable_id: "cand_known",
      job_shortcode: "JOB1",
      name: "Known Applicant",
      email: "applicant@example.com",
      disqualified: false,
      stage: "Applied",
      created_at: new Date().toISOString(),
    },
  ],
});

const { postFireflies } = await loadIngestApp();
const raw = JSON.stringify({
  transcriptId: "meeting-no-secret",
  title: "Interview",
  transcript: "A normal length transcript that must not be stored without a webhook secret.",
  workable_id: "cand_known",
});
const response = await postFireflies(
  new NextRequest("http://localhost/api/ingest/fireflies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  }),
);

const events = memory.rows("events").length;
const evidence = memory.rows("evidence").length;
if (response.status === 401 && events === 0 && evidence === 0) {
  process.exit(0);
}
console.error(`expected 401 and no writes, got status=${response.status} events=${events} evidence=${evidence}`);
process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
