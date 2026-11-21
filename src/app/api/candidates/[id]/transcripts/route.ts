import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { hasSupabase } from "@/lib/env";
import { getServiceSupabase } from "@/lib/supabase/server";
import { INTERVIEW_EVIDENCE_TYPES } from "@/lib/sync/candidate-hash";
import { firefliesFrom } from "@/lib/triage/from-supabase";
import type { InterviewEvidenceRow } from "@/lib/types";

/** One applicant's interview transcripts, loaded when the reviewer opens them. */
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
    .select("id, candidate_id, source_type, label, captured_at, created_at, transcript")
    .eq("candidate_id", id)
    .in("source_type", [...INTERVIEW_EVIDENCE_TYPES])
    .order("created_at", { ascending: false });
  if (error) {
    console.error(`Failed to load transcripts for ${id}`, error);
    return NextResponse.json({ error: "Failed to load transcripts" }, { status: 500 });
  }

  return NextResponse.json({ recordings: firefliesFrom((data ?? []) as InterviewEvidenceRow[]) });
}
