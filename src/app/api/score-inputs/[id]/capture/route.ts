import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase/server";

async function signedInUserId(): Promise<string | null> {
  try {
    const { userId } = await auth();
    return userId ?? null;
  } catch {
    return null;
  }
}

// Scoring writes every score input as a text card with no capture file
// (src/lib/scoring/run-score.ts), so this route never signs a stored
// capture_path: any path on a row came from somewhere other than ingest.
// Résumé files are served, with audit logging, by /api/candidates/[id]/resume.
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const userId = await signedInUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const supabase = getServiceSupabase();
  const { data: input } = await supabase
    .from("score_inputs")
    .select("claim, capture_kind, quote, source_ref")
    .eq("id", id)
    .maybeSingle();

  if (!input) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    caption: input.claim,
    kind: input.capture_kind,
    capture_url: null,
    quote: input.quote,
    source_ref: input.source_ref,
  });
}
