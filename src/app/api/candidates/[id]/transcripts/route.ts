import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { hasSupabase } from "@/lib/env";
import { getServiceSupabase } from "@/lib/supabase/server";
import { INTERVIEW_EVIDENCE_TYPES } from "@/lib/sync/candidate-hash";
import { firefliesFrom } from "@/lib/triage/from-supabase";
import type { EvidenceRow } from "@/lib/types";

/**
 * Interview transcripts for one candidate. The pool list leaves transcript text
 * out, so the dossier fetches it here only when a reviewer asks for it.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasSupabase()) return NextResponse.json({ recordings: [] });

  const { id } = await context.params;
  const { data, error } = await getServiceSupabase()
    .from("evidence")
    .select("id, candidate_id, source_type, label, captured_at, transcript, created_at")
    .eq("candidate_id", id)
    .in("source_type", [...INTERVIEW_EVIDENCE_TYPES]);
  if (error) {
    console.error(`Failed to load transcripts for ${id}`, error);
    return NextResponse.json({ error: "Failed to load transcripts" }, { status: 500 });
  }

  return NextResponse.json({ recordings: firefliesFrom((data ?? []) as EvidenceRow[]) });
}
