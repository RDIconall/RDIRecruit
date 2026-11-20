import { NextRequest } from "next/server";
import { resetTables, rows, seed, startPostgrestStandIn } from "./postgrest-stand-in.ts";

async function main(): Promise<void> {
  const localFetch = globalThis.fetch.bind(globalThis);
  let serverOrigin = "";
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (serverOrigin && url.startsWith(serverOrigin)) return localFetch(input, init);
    throw new Error(`blocked outbound request to ${new URL(url).host}`);
  };

  const server = await startPostgrestStandIn();
  serverOrigin = server.url;
  process.env.SUPABASE_URL = server.url;
  process.env.SUPABASE_SERVICE_KEY = "test-service-role-placeholder";
  process.env.ANTHROPIC_API_KEY = "anthropic-test-placeholder";

  const ONLY_ID = "cand_only";
  resetTables();
  seed("candidates", {
    workable_id: ONLY_ID,
    email: "Only.One@Secret.Example",
    name: "Only One",
    job_shortcode: "JOB1",
  });
  seed("jobs", {
    shortcode: "JOB1",
    title: "Clinical lead",
    raw: {
      full_description:
        "Own the clinical delivery plan, the vendor handoff, and the weekly operating review for this seat.",
    },
  });
  seed("applications", {
    candidate_id: ONLY_ID,
    resume_text:
      "Led a twelve-person clinical operations team through two product launches and a vendor transition.",
    answers: {},
    parsed_experience: [],
  });

  const { POST } = await import("../src/app/api/ingest/fireflies/route.ts");
  const request = new NextRequest("http://localhost/api/ingest/fireflies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Screen",
      transcript: "We discussed the role and the candidate's last project.",
      participants: ["only%@secret.example"],
    }),
  });

  let candidateId: unknown;
  let error: string | null = null;
  try {
    const response = await POST(request);
    const body = (await response.json()) as { candidateId?: string };
    candidateId = body.candidateId;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  console.log(
    JSON.stringify({
      candidateId: candidateId ?? null,
      evidence: rows("evidence").filter((row) => row.candidate_id === ONLY_ID).length,
      analyses: rows("candidate_analyses").filter((row) => row.candidate_id === ONLY_ID).length,
      error,
    }),
  );
  await server.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
