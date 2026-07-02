import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import { computeCommute } from "./commute";
import { gradeLog } from "./grade-log";
import type { RosterEntry } from "./load";
import type { AssessmentNarrative, CareerRead, CorrectionEntry, Candidate, Decision, DecisionRead, ReviewerKind, RubricFit, ValueRead } from "./types";

const MODEL = "claude-sonnet-4-6";

// The RDI office candidates commute to (configurable via env, single source).
// Used to ground Claude's fallback commute estimate.
const OFFICE = `RDI's office in ${env.RDI_OFFICE_ADDRESS}`;

const VALID_DECISIONS: Decision[] = ["interview", "backup", "reject", "blocked"];

const SYSTEM_PROMPT = `You are the candidate-triage decision engine for RDI Trials. Your job is to protect interview time. You answer three questions for the recruiter: (1) how strong is this candidate relative to the salary they are asking for, (2) is this someone to interview, hold as a backup, or reject, and (3) if interview, why they rank where they do against the rest of the pool.

OUTPUT IS A DECISION, NOT A SCORE. You must NEVER produce, mention, or imply a numeric score, points, percentage, grade, or tier. The ONLY status language allowed is this fixed four-action vocabulary:
- "interview" = Interview. Worth your time; belongs on the ranked interview list.
- "backup"    = Backup. Competent but does not beat the interview list — only reach for them if the top of the list falls through.
- "reject"    = Reject / do not interview. Below the bar for this seat — application-care failure, contradiction, pattern risk, role mismatch, or simply outclassed by the pool. ALWAYS give a concrete reason in "why".
- "blocked"   = Review blocked. Materials incomplete / failed to parse — no read possible until re-sync.
There is no "short screen" and no "verify first" status. If a key claim, fact, or salary needs confirming before booking, the candidate can still be "interview" or "backup" — put what must be confirmed in the "caveat" field.

JUDGE STRENGTH VS SALARY. The headline judgment is the candidate's strength weighed against their salary target. Strength = the quality of the life/career choices visible on the résumé (progression, tenure, the level their biggest accomplishments imply), the substance of their answers to the application questions, and their fit to the ROLE SPEC and JOB RUBRIC. Weigh that against their stated/target salary. A strong operator at a fair ask is high value; a thin candidate at a top-of-band ask is poor value. Fill the "value" object with this read.

IF THE SALARY ASK IS NOT STATED, there is no price to judge against: set value.level to "unpriced" with a headline like "Ask not stated", judge the candidate on strength alone in value.detail, and put "confirm the salary expectation" in the caveat. NEVER call an unpriced candidate overpriced or good value.

Read ACTIONS and evidence, not adjectives. Weigh the human corrections and any interview transcript HEAVILY — a human correction overrides the AI's earlier parse of the materials. Integrity problems and clear contradictions are gates: they push to reject regardless of fit.

When a named human reviewer (e.g. Conall or Lara) leaves a correction, treat their signal as authoritative human judgment and weight it accordingly — name them as the source of the change.

GROUND YOUR REASONING IN THE SUPPLIED METHOD. When a "HOW WE HIRE" methodology doc is provided below, that is the org's evaluation philosophy — reason the way it says to (read choices and omissions, weigh the gap not the person, run the reads in its order). When a ROLE SPEC and JOB RUBRIC are provided, judge fit strictly against them.

RANK AGAINST THE POOL. When a POOL ROSTER is provided, it lists every OTHER candidate in this job's pool with their current decision. Your call is RELATIVE, not absolute: "interview" is reserved for files that genuinely beat the field on strength-for-the-ask; "backup" means competent but does NOT beat the interview list. In "why", say plainly where they stand relative to the pool (e.g. "among the strongest for the ask", "mid-pack", "below the interview list") so the recruiter can order who to interview first — but NEVER as a number, percentile, or tier.

Return JSON only, no prose outside the JSON, in exactly this shape:
{
  "decision": one of ${VALID_DECISIONS.map((d) => `"${d}"`).join(" | ")},
  "why": "one or two sentences — the decisive reason for this call AND roughly where they stand in the pool, grounded in the materials/corrections",
  "risk": "the single main risk or the one thing a human must settle (one sentence)",
  "next": "the concrete next action, e.g. Interview | Hold as backup | Reject | Re-sync",
  "caveat": "what must be confirmed before an interview (a claim, a fact, or the salary), or an empty string if nothing needs confirming",
  "value": {
    "headline": "a short strength-vs-salary verdict, e.g. 'Strong operator, fair ask' | 'Solid, priced about right' | 'Overpriced for the level' | 'Ask not stated'",
    "level": "strong | fair | weak | unpriced (use unpriced ONLY when no salary ask is on file)",
    "detail": "1-2 sentences weighing their strength (résumé choices + answers + spec/rubric fit) against their salary target — or against strength alone when the ask is unstated"
  },
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
  },
  "assessment": {
    "bio": "A COMPLETE written biography in flowing prose (2-4 short paragraphs, separated by a blank line). Tell their story end to end: where they went to school and what they studied (include GPA only if it is actually stated in the materials), early roles, any graduate study, then the progression of roles with the organizations and how long at each, what kind of career track this is typical of, and finally — based on their most recent/most senior position — their single biggest accomplishment and the capability level (RO stratum) that accomplishment indicates. Write it the way a sharp recruiter briefs a hiring partner: specific, grounded in the résumé, no filler, no numeric scores. Never invent facts that are not in the materials; if something (like GPA or a degree) is not stated, simply omit it rather than guessing.",
    "application": "A summary of the application reviewed AGAINST THE SPEC, in 1-2 short paragraphs. Cover: the candidate's stated/target salary and whether it fits; the quality of their answers to the application questions (well thought out and detailed vs thin), how strongly the answers are backed by the experience and education on their résumé, and your read on how likely the answers are AI-generated (low/medium/high signs of AI use, with the tell); whether the cover letter is well written and shows genuine research into the role; and whether the writing STYLE is consistent across the résumé, cover letter, and application answers (consistency is a positive authenticity signal; a sharp mismatch is a flag).",
    "commute": "One or two sentences: state where the candidate currently lives, then estimate the typical driving commute time (in minutes) from there to ${OFFICE}. Use your geographic knowledge to give a realistic door-to-door drive-time estimate (e.g. 'about 25-35 minutes in normal traffic'). If the location is far (another state/country) say so plainly and note relocation would be required. If no location is on file, say it is not stated and must be confirmed."
  }
}
The "value" object MUST ALWAYS be included — it is the headline strength-vs-salary read the recruiter sees first.
The "careerRead" object is optional context — include it when you have enough to say something real, otherwise omit it entirely.
The "assessment" object MUST ALWAYS be included — it is the written candidate brief the recruiter reads. Ground every claim in the supplied materials (résumé, cover letter, answers, transcript). Prose only, never a numeric score.
The "rubricFit" object MUST be included whenever a JOB RUBRIC and/or a ROLE SPEC is provided below. Grade strictly against the JOB RUBRIC's categories, hard gates, and pattern-recognition guidance when one is provided; when there is NO separate rubric, the ROLE SPEC is the grading basis — judge fit against the spec's responsibilities and requirements instead. Translate any point bands into the words-only verdict — NEVER output a numeric score. Omit "rubricFit" only when NEITHER a rubric nor a role spec is provided.`;

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

  const materialsBlock = (input.materials || "").trim()
    ? `\n\nVERBATIM SOURCE MATERIALS (the candidate's own words — quote/ground the bio, AI-use read, and writing-consistency read in these):\n"""\n${input.materials!.trim().slice(0, 18000)}\n"""`
    : "";

  const methodBlock = (input.methodology || "").trim()
    ? `\n\nHOW WE HIRE (the org's evaluation methodology — reason exactly the way this says to):\n"""\n${input.methodology!.trim().slice(0, 9000)}\n"""`
    : "";

  const roster = input.poolRoster ?? [];
  const rosterBlock = roster.length
    ? `\n\nPOOL ROSTER (every OTHER active candidate in this job — your call is RELATIVE to these):\n${roster
        .map(
          (r) =>
            `- ${r.name} — ${r.role || "—"}${r.company ? ` @ ${r.company}` : ""} · ${r.experience || "—"} · RO ${r.roLevel || "—"} · current call: ${r.decision}${r.why ? ` — ${r.why.slice(0, 160)}` : ""}`,
        )
        .join("\n")
        .slice(0, 9000)}`
    : "";

  return `${reviewerLine}STORED WORKING FILE (.md — this candidate's living case file):
"""
${(workingFile || "(empty)").slice(0, 8000)}
"""

CANDIDATE: ${candidate.name}
Current role on file: ${candidate.role} at ${candidate.company}
Salary ask: ${!candidate.salary || candidate.salary === "—" ? "NOT STATED — must be confirmed" : candidate.salary}
RO capability (level label, NOT a score): ${candidate.roLevel}
Lives in: ${candidate.logistics.location || "not stated"} (office to commute to: ${OFFICE})
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
${(transcript || "none yet").slice(0, 24000)}${materialsBlock}${methodBlock}${specBlock}${rubricBlock}${rosterBlock}

Re-derive the decision read now. If the human corrections or the transcript change the picture, change the decision accordingly. Position the call relative to the pool roster. Remember: decision vocabulary only, never a number.`;
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
  /** Verbatim source materials (cover letter, answers, résumé, transcripts) so
   * Claude can ground the written bio, AI-use read, and writing-consistency read. */
  materials?: string;
  /** The global "how we hire" evaluation methodology — reasons the grade. */
  methodology?: string;
  /** Compact roster of the rest of the pool so the call is ranked relative to peers. */
  poolRoster?: RosterEntry[];
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

function parseAssessment(value: unknown): AssessmentNarrative | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string).trim() : "");
  const bio = str("bio");
  const application = str("application");
  const commute = str("commute");
  if (!bio && !application && !commute) return undefined;
  return { bio, application, commute };
}

function parseValue(value: unknown): ValueRead | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string).trim() : "");
  const headline = str("headline");
  const detail = str("detail");
  const rawLevel = str("level").toLowerCase();
  // "unpriced" (no ask on file) maps to the UI's "none" level — the value column
  // shows a dash rather than pretending a price judgment exists.
  const level: ValueRead["level"] =
    rawLevel === "strong" ? "strong" : rawLevel === "weak" ? "weak" : rawLevel === "fair" ? "fair" : "none";
  if (!headline && !detail && level === "none") return undefined;
  if (level === "none" && !/unpriced|none|not stated|unstated/.test(rawLevel + " " + headline.toLowerCase())) {
    // Unrecognized level but a real headline — keep the read, default to fair.
    return { headline: headline || "—", level: "fair", detail };
  }
  return { headline: headline || "—", level, detail };
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
  if (!hasAnthropic()) {
    gradeLog("recalc.skipped", { candidateId: input.candidate.id, reason: "no_anthropic" });
    return null;
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      // Headroom: the read carries careerRead + rubricFit + the long-form written
      // assessment (multi-paragraph bio, application summary, commute). The bio
      // alone can run several hundred words, so give the JSON room to complete —
      // a truncated response breaks the parse and silently drops the re-analysis.
      max_tokens: 4500,
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

    const assessment = parseAssessment((parsed as Record<string, unknown>).assessment);

    // Augment Claude's geographic commute estimate with a real door-to-door
    // driving time when Geoapify is configured. Best-effort: on any failure we
    // keep Claude's estimate. Only overrides when we actually have an assessment.
    if (assessment) {
      const measured = await computeCommute(input.candidate.logistics.location);
      if (measured) assessment.commute = measured.text;
    }

    gradeLog("recalc.ok", {
      candidateId: input.candidate.id,
      decision,
      pool: (input.poolRoster ?? []).length,
      hasMethod: Boolean((input.methodology || "").trim()),
      hasRubric: Boolean((input.rubric || "").trim()),
    });

    return {
      decision,
      why: (parsed.why || input.candidate.why || "").trim(),
      risk: (parsed.risk || input.candidate.flag || "").trim(),
      next: (parsed.next || "").trim(),
      caveat: (typeof (parsed as Record<string, unknown>).caveat === "string"
        ? ((parsed as Record<string, unknown>).caveat as string).trim()
        : "") || undefined,
      value: parseValue((parsed as Record<string, unknown>).value),
      timelineNote: (parsed.timelineNote || "").trim() || undefined,
      careerRead: parseCareerRead((parsed as Record<string, unknown>).careerRead),
      assessment,
      rubricFit: parseRubricFit((parsed as Record<string, unknown>).rubricFit),
      recalculatedAt: new Date().toISOString(),
      model: MODEL,
    };
  } catch (error) {
    // Fail open on transient Claude errors: keep the prior read, never crash.
    gradeLog("recalc.failed", {
      candidateId: input.candidate.id,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error("Triage recalculate failed", error);
    return null;
  }
}
