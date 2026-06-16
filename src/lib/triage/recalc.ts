import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import type { CareerRead, CorrectionEntry, Candidate, Decision, DecisionRead, ReviewerKind, RubricFit } from "./types";

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

When a named human reviewer (e.g. Conall or Lara) leaves a correction, treat their signal as authoritative human judgment and weight it accordingly — name them as the source of the change.

Return JSON only, no prose outside the JSON, in exactly this shape:
{
  "decision": one of ${VALID_DECISIONS.map((d) => `"${d}"`).join(" | ")},
  "why": "one or two sentences — the decisive reason for this call, grounded in the materials/corrections",
  "risk": "the single main risk or the one thing a human must settle (one sentence)",
  "next": "the concrete next action, e.g. Screen | Short screen | Verify | Hold | Reject | Re-sync",
  "timelineNote": "one short note on what changed vs the prior read, or empty string if nothing changed",
  "careerRead": {
    "path": "the candidate's career-path read in one or two sentences (no numbers)",
    "positive": "the strongest positive inference from the materials",
    "risk": "the main risk inference",
    "implication": "what this implies for the decision"
  },
  "rubricFit": {
    "verdict": "a short words-only fit label vs the job rubric, e.g. Strong fit | Partial fit | Weak fit | Misaligned",
    "summary": "2-3 sentences on how this candidate maps to the rubric's categories and gates, and the decisive reason they are (or are not) a good fit for THIS role",
    "strengths": ["specific rubric-aligned strengths, grounded in the materials"],
    "gaps": ["specific rubric gaps, missing evidence, or hard-gate concerns"]
  }
}
The "careerRead" object is optional context — include it when you have enough to say something real, otherwise omit it entirely.
The "rubricFit" object MUST be included ONLY when a JOB RUBRIC is provided below; judge the candidate strictly against that rubric's categories, hard gates, and pattern-recognition guidance. Translate the rubric's point bands into the words-only verdict — NEVER output the numeric score itself. If no rubric is provided, omit "rubricFit" entirely.`;

function buildUserPrompt(input: RecalcInput): string {
  const { candidate, corrections, transcript, replies, workingFile } = input;

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
    ? corrections
        .map((c) => `- [${c.ts}]${c.reviewerLabel ? ` (${c.reviewerLabel})` : ""} ${c.text}`)
        .join("\n")
    : "none";

  const reviewerLine = input.reviewer?.label
    ? `LATEST REVIEWER: ${input.reviewer.label}${input.reviewer.kind ? ` (${input.reviewer.kind})` : ""} — weight this human's signal heavily.\n`
    : "";

  const reps = Object.entries(replies).filter(([, v]) => v);
  const repsText = reps.length ? reps.map(([k, v]) => `- (${k}) ${v}`).join("\n") : "none";

  const rubricBlock = (input.rubric || "").trim()
    ? `\n\nJOB RUBRIC (grade this candidate strictly against this — fill the "rubricFit" object):\n"""\n${input.rubric!.trim().slice(0, 7000)}\n"""`
    : "";

  const specBlock = (input.jobSpec || "").trim()
    ? `\n\nROLE SPEC (what this job actually is):\n"""\n${input.jobSpec!.trim().slice(0, 3000)}\n"""`
    : "";

  return `${reviewerLine}STORED WORKING FILE (.md — this candidate's living case file):
"""
${(workingFile || "(empty)").slice(0, 8000)}
"""

CANDIDATE: ${candidate.name}
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
${(transcript || "none yet").slice(0, 24000)}${specBlock}${rubricBlock}

Re-derive the decision read now. If the human corrections or the transcript change the picture, change the decision accordingly. Remember: decision vocabulary only, never a number.`;
}

export interface RecalcInput {
  candidate: Candidate;
  /** The candidate's stored .md working file (case file), fed to Claude as context. */
  workingFile: string;
  corrections: CorrectionEntry[];
  transcript: string;
  replies: Record<string, string>;
  /** Identity of the human whose latest correction triggered this recalc (#7). */
  reviewer?: { label?: string; kind?: ReviewerKind };
  /** The job's grading rubric (markdown). When present, Claude fills rubricFit. */
  rubric?: string;
  /** The role spec / job description (markdown), for additional grounding. */
  jobSpec?: string;
}

function parseCareerRead(value: unknown): CareerRead | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string).trim() : "");
  const path = str("path");
  const positive = str("positive");
  const risk = str("risk");
  const implication = str("implication");
  if (!path && !positive && !risk && !implication) return undefined;
  return { path, positive, risk, implication };
}

function parseRubricFit(value: unknown): RubricFit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string).trim() : "");
  const list = (k: string) =>
    Array.isArray(v[k])
      ? (v[k] as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
      : [];
  const verdict = str("verdict");
  const summary = str("summary");
  const strengths = list("strengths");
  const gaps = list("gaps");
  if (!verdict && !summary && !strengths.length && !gaps.length) return undefined;
  return { verdict, summary, strengths, gaps, generatedAt: new Date().toISOString() };
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
      // Headroom: the read now also carries careerRead + rubricFit (verdict,
      // summary, strengths[], gaps[]). 1200 truncated the JSON mid-stream for
      // rubric-graded candidates, which broke the parse and silently dropped
      // the re-analysis. 3000 comfortably fits the full object.
      max_tokens: 3000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });

    if (response.stop_reason === "max_tokens") {
      console.warn("Triage recalculate: response hit max_tokens — JSON may be truncated");
    }
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
      careerRead: parseCareerRead((parsed as Record<string, unknown>).careerRead),
      rubricFit: parseRubricFit((parsed as Record<string, unknown>).rubricFit),
      recalculatedAt: new Date().toISOString(),
      model: MODEL,
    };
  } catch (error) {
    console.error("Triage recalculate failed", error);
    return null;
  }
}
