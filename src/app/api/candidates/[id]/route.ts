import { NextResponse } from "next/server";
import { getCandidateDetail } from "@/lib/data/board";
import { loadOneCandidate } from "@/lib/triage/load";

/**
 * Candidate detail, plus a `triage` block explaining the call the board shows.
 *
 * The triage block exists to answer "why is this person on the interview list?"
 * without reading the database by hand: it reports the decision, whether the file
 * clears the deterministic interview bar, what held it back if not, and the three
 * checkable signals (answers, spec fit, strength-vs-salary) the ordering uses.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const detail = await getCandidateDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let triage: Record<string, unknown> | null = null;
  try {
    const one = await loadOneCandidate(id);
    if (one) {
      const c = one.candidate;
      triage = {
        name: c.name,
        decision: c.decision,
        onInterviewList: c.decision === "interview",
        interviewGate: c.interviewGate ?? null,
        why: c.why,
        next: c.next,
        caveat: c.caveat ?? null,
        answersRead: c.answersRead,
        specRead: c.specRead,
        value: c.value,
        refusedToAnswer: Boolean(c.refusedToAnswer),
        redFlags: c.redFlags.map((f) => f.flag),
        decisionOverride: one.slice.decisionOverride ?? null,
        standing: c.standing ?? null,
      };
    }
  } catch (error) {
    console.error(`Triage diagnostic failed for ${id}`, error);
  }

  return NextResponse.json({ ...detail, triage });
}
