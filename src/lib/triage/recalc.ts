import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import type { Candidate, Decision, DecisionRead } from "./types";

const MODEL = "claude-sonnet-4-6";

const VALID_DECISIONS: Decision[] = ["interview", "short", "verify", "hold", "cut", "blocked"];

const SYSTEM_PROMPT = `You are the candidate-triage decision engine for RDI Trials. Your job is to protect interview time: cut weak candidates first, decide who is worth a screen, and flag who needs verification before any human time is spent.

OUTPUT IS A DECISION, NOT A SCORE. You must NEVER produce, mention, or imply a numeric score, points, percentage, grade, or tier. The ONLY status language allowed is this fixed decision vocabulary:
- "interview"  = Interview first (clears the bar; screen this one first)
- "short"      = Short screen (worth a quick screen, with a caveat to test)
- "verify"     = Verify first (promising but a key claim, salary, or fact must be confirmed before a slot)
- "hold"       = Hold (competent but not differentiating; does not beat the top of the pool)
- "cut"        = Cut (reject on materials — application-care failure, contradiction, pattern risk, or role mismatch)
- "blocked"    = Review blocked (materials incomplete / failed to parse — no read possible until re-sync)

Read ACTIONS and evidence, not adjectives. Weigh the human corrections and any interview transcript HEAVILY — a human correction overrides the AI's earlier parse of the materials. Integrity problems and clear contradictions are gates: they push to cut regardless of fit.

Return JSON only, no prose outside the JSON, in exactly this shape:
{
  "decision": one of ${VALID_DECISIONS.map((d) => `"${d}"`).join(" | ")},
  "why": "one or two sentences — the decisive reason for this call, grounded in the materials/corrections",
  "risk": "the single main risk or the one thing a human must settle (one sentence)",
  "next": "the concrete next action, e.g. Screen | Short screen | Verify | Hold | Reject | Re-sync",
  "timelineNote": "one short note on what changed vs the prior read, or empty string if nothing changed"
}`;

function buildUserPrompt(input: RecalcInput): string {
  const { candidate, corrections, transcript, replies } = input;

  const tl = (candidate.timeline ?? [])
    .map((r) => `- ${r.period} · ${r.org} · ${r.role} · ${r.tenure} · ${r.scope} [${r.signal}]`)
    .join("\n");

  const answers = (candidate.answers ?? [])
    .map((a) => `Q: ${a.q}\nA: ${a.a}${a.comment ? `\n(prior note: ${a.comment})` : ""}`)
    .join("\n\n");

  const cover = candidate.cover.hasLetter
    ? candidate.cover.lines.map((l) => l.t).join(" ")
    : "No cover letter submitted.";

  const corr = corrections.length
    ? corrections.map((c) => `- [${c.ts}] ${c.text}`).join("\n")
    : "none";

  const reps = Object.entries(replies).filter(([, v]) => v);
  const repsText = reps.length ? reps.map(([k, v]) => `- (${k}) ${v}`).join("\n") : "none";

  return `CANDIDATE: ${candidate.name}
Current role on file: ${candidate.role} at ${candidate.company}
Salary ask: ${candidate.salary}
RO capability (level label, NOT a score): ${candidate.roLevel}
Logistics: ${candidate.logistics.location} — likelihood ${candidate.logistics.likelihood}

PRIOR READ (to revise):
- Decision: ${candidate.decision}
- Why: ${candidate.why}
- Main risk: ${candidate.flag}
- Next: ${candidate.next}

CAREER TIMELINE:
${tl || "none parsed"}

COVER LETTER:
${cover}

APPLICATION ANSWERS:
${answers || "none on file"}

HUMAN CORRECTIONS (authoritative — these override the AI's earlier parse):
${corr}

REVIEWER REPLIES TO PRIOR AI COMMENTS:
${repsText}

INTERVIEW / SCREEN TRANSCRIPT (post-application — weight heavily when present):
${transcript || "none yet"}

Re-derive the decision read now. If the human corrections or the transcript change the picture, change the decision accordingly. Remember: decision vocabulary only, never a number.`;
}

export interface RecalcInput {
  candidate: Candidate;
  corrections: { ts: string; text: string }[];
  transcript: string;
  replies: Record<string, string>;
}

/**
 * Re-derive a candidate's decision read with Claude. Resilient: returns null when
 * no API key is configured or the call/parse fails, so the caller can keep the
 * existing read and never crash the page.
 */
export async function recalculateRead(input: RecalcInput): Promise<DecisionRead | null> {
  if (!hasAnthropic()) return null;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] ?? "{}") as Partial<DecisionRead>;

    const decision = VALID_DECISIONS.includes(parsed.decision as Decision)
      ? (parsed.decision as Decision)
      : input.candidate.decision;

    return {
      decision,
      why: (parsed.why || input.candidate.why || "").trim(),
      risk: (parsed.risk || input.candidate.flag || "").trim(),
      next: (parsed.next || "").trim(),
      timelineNote: (parsed.timelineNote || "").trim() || undefined,
      recalculatedAt: new Date().toISOString(),
      model: MODEL,
    };
  } catch (error) {
    console.error("Triage recalculate failed", error);
    return null;
  }
}
