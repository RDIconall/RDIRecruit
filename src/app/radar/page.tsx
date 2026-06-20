import { currentUser } from "@clerk/nextjs/server";
import { RadarApp } from "@/components/radar/radar-app";
import { loadRadar } from "@/lib/radar/load";
import type { Pipeline } from "@/lib/radar/types";

// Server-fed from Supabase. Auth enforced by Clerk middleware. Human edits and
// LLM scoring/drafting persist via the server actions in src/app/actions/radar.ts.
export const dynamic = "force-dynamic";

const PIPELINES: Pipeline[] = ["recruiting", "bd"];

export default async function RadarPage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string; search?: string }>;
}) {
  const params = await searchParams;
  const pipeline: Pipeline = PIPELINES.includes(params.pipeline as Pipeline)
    ? (params.pipeline as Pipeline)
    : "recruiting";
  const searchId = params.search || null;

  const [data, user] = await Promise.all([
    loadRadar({ pipeline, searchId }),
    currentUser().catch(() => null),
  ]);

  const viewer =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
    user?.emailAddresses?.[0]?.emailAddress?.split("@")[0] ||
    "RDI";

  return <RadarApp key={`${pipeline}:${searchId ?? "all"}`} data={data} viewer={viewer} />;
}
