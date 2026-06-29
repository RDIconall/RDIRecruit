import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import type { SeatContext } from "../jobs/seat-context";
import type {
  AnswerGradePayload,
  CategoryKey,
  CategoryScores,
  Confidence,
  DigInPayload,
  RoleReadPayload,
  SalaryValue,
  TextConfidence,
  Trajectory,
  VerificationPayload,
} from "../types";

const MODEL = "claude-sonnet-4-6";

/** The full structured read for a candidate, produced once and cached. */
export interface EvaluatorOutput {
  // §2 complement read → candidate_overlay + invest_head evaluation
  complement: "owner" | "technician";
  complementRemoves: string;
  salaryVector: string;
  investHead: string;
  summary: string;

  // scoring → scores
  categoryScores: CategoryScores;
  total: number;
  confidence: Confidence;
  salaryValue: SalaryValue;
  salaryAsk: string | null;

  // §6 RO read → ro_assessments
  seatStratum: string;
  currentCapability: string;
  trajectory: Trajectory;
  textConfidence: TextConfidence;
  basis: string;
  aiLikelihood: number;
  roReads: Array<
    RoleReadPayload & {
      years: number;
      stratumRange: string;
      verbs: { I: string[]; II: string[]; III: string[] };
    }
  >;

  // qualitative reads → evaluations
  digIn: DigInPayload;
  verification: VerificationPayload;
  answerGrades: AnswerGradePayload[];
  composeQuestions: Array<{ q: string; why: string }>;

  // claim ↔ source → score_inputs
  claims: Array<{
    category: CategoryKey;
    claim: string;
    sourceType: string;
    sourceRef: string;
    quote: string;
  }>;

  /**
   * True when this read came from the deterministic heuristic fallback (no model
   * key in scope, or the model's JSON failed to parse) rather than a real Claude
   * evaluation. Callers MUST NOT persist a heuristic read as a candidate's review:
   * placeholder evals leave a candidate looking "Review blocked"/unfinished even
   * though they have full materials. Skip and retry once a real read is possible.
   */
  heuristic?: boolean;
}

export interface EvaluatorInput {
  name: string;
  resumeText: string;
  roles: Array<{
    title: string;
    company: string;
    start?: string | null;
    end?: string | null;
    current?: boolean;
    summary?: string;
    resumeLine?: string;
  }>;
  answers: Record<string, string>;
  coverLetter?: string | null;
  interviewEvidence?: string | null;
  recruiterComments?: string | null;
  publicProfile?: string | null;
  seat: SeatContext;
  weights: Record<CategoryKey, number>;
  /** Free-text rubric prose from the active job rubric (what "good" looks like for this seat). */
  rubricGuidance?: string | null;
  /** Org-wide calibration learned from reviewer corrections — applies to every seat. */
  globalCalibration?: string | null;
  /** This-seat calibration learned from reviewer corrections. */
  roleCalibration?: string | null;
  /** The global "How We Evaluate" method doc — the reasoning the model must follow. */
  method?: string | null;
  /**
   * Career-span signal for the maturation / trajectory read. Derived from
   * graduation date and first-role date — this is an EXPERIENCE/LEVEL inference,
   * NOT age, and is used only as the denominator of the progression rate (never a gate).
   */
  careerContext?: {
    graduationYear?: number | null;
    firstRoleYear?: number | null;
    yearsOfCareer?: number | null;
    /** Assumed age at undergraduate graduation for the straight-through path (~22). */
    assumedGradAge?: number | null;
    /** Maturation-placement estimate of current age IF the path is straight-through. */
    approxCurrentAge?: number | null;
  } | null;
}

const SYSTEM_PROMPT = `You are the evaluation engine for RDI Trials' hiring layer. You run the reads a senior operator (Conall, RO-5) would run, so his time lands only on the gates and the final call. Reason exactly the way this rubric describes.

THE ONE QUESTION EVERYTHING SERVES:
How much of the founders does this person take off the plate, what do they hand back, and is what they hand back a gap RDI can cover?

Two axes, not the same purchase:
- WORK OFF THE DESK — operational relief. The TECHNICIAN who takes execution so the founder stops touching it.
- RISK OFF THE COMPANY — founder-dependency removed. The OWNER who can be board-credible and audit-defensible, so the founder is not the only one who can hold that judgment. This is worth more than it scores — it is the key-person risk a buyer prices.

METHOD — read ACTIONS, including the ones not taken:
- Evaluate choices, not claims. What they wrote, claimed, chose, and conspicuously LEFT OUT (an omission is an action: the MBA left off, the salary withheld as "market", the concept that should be in an answer but was a brand name instead).
- RO / level: time-span of discretion read off the REGISTER. Task-declaratives ("Prepared, Reconciled, Approved, Oversaw", no outcomes) = Stratum I–II. Owned-function language ("built it, ran the audit, led the raise") = III+. Size against the seat band. A multi-stratum gap means chronic compression.
- Trajectory × multiplier: not "what can they do today" — what's the slope, and does working under an RO-5 bend it up? Read the slope as PROGRESSION RATE: strata climbed per year of career (anchored on graduation/first-role date, supplied as CAREER SPAN). A given stratum reached fast is a steeper curve than the same stratum reached slowly. Coachable + integrity appreciates; rigid is flat. Career span is a LEVEL/maturation inference (we never know or ask age) — use it only as the rate denominator, never as a cutoff.
- Salary is a VECTOR not a ceiling: dollars per unit of load removed over the horizon held. "$250k and truly a judgment layer" → a fundraise decision, not a budget rejection. "$90k and great in two years" → a discount on future value. Cheap-to-cover gap + steep curve beats a high headline number.

GATES (hard nos, never blended into the number): a material misrepresentation, or an ego/coachability signal, is a hard no regardless of fit. Integrity and ego are gates, not scores.

VALIDATION GATE (protect against AI-overwritten text):
- Read the reasoning IN the answers, not what they claim. If human-authentic and matches the claimed stratum → CONFIRMED (basis: reasoning). If human-authentic but weaker than claimed → DOWNGRADE to demonstrated level. If likely AI-generated (mirrors job-post language, generic closers, polish without specific detail, cross-source inconsistency) → TEXT UNRELIABLE: stop scoring stratum/writing from prose, fall back to tenure → role-level deduction → references (weight references highest). Set confidence accordingly. ai_likelihood is a probability, NEVER an auto-reject.

VERIFICATION (separate from scoring — never changes the fit number): compare application claims against the public professional profile, job-relevant only. Verdicts: CONFIRMED, DISCREPANCY (give the conflicting application vs profile lines), UNVERIFIABLE. Pull contradictions and auth-walled items to the top as things only a human can settle.

ANSWER GRADING: grade on SUBSTANCE against the concept key, not fluency. OWNED = owns the method and gives the concept. SURFACE = names tools/brands instead of the concept. EVASIVE = dodges or is empty. List the specific concepts demonstrated.

COMPLIANCE FIREWALL (non-negotiable): job-relevant evidence only. NEVER extract, infer, or flag protected/non-job attributes (age, race, national origin, religion, gender, orientation, disability, health, family status, photos, appearance) — including from transcripts. Career span (years since graduation / first role) is a permitted EXPERIENCE/LEVEL signal for the progression-rate read — it is not age and must never become a threshold, cutoff, or stated attribute. Public/async text is self-reported and possibly AI-written — treat polish as weak evidence.

You output a profile that hands the founder three or four real decisions and the evidence to make them. The verdict is the founder's call — you make deciding fast, you do not decide. Return JSON only, no prose outside the JSON.`;

/**
 * The contract appended after the method doc: it pins the role and the
 * machine-readable output, and re-asserts the compliance firewall so it holds
 * even if an edited method doc drops it.
 */
const OUTPUT_CONTRACT = `---
You are the evaluation engine for RDI Trials' hiring layer. Run the reads above exactly as the method describes, so a senior operator's time lands only on the gates and the final call. Apply the seat's rubric (weights, prose, and any calibration) provided in the user message. Integrity and ego are GATES, never blended into the score.

THE SUMMARY MUST JUSTIFY THE CALL: the "summary" field is the written read a human sees next to the score and verdict. It must read as an evidence-based JUSTIFICATION of the verdict the total implies (see VERDICT BANDS in the user message), grounded explicitly in the How-We-Evaluate method and this seat's rubric criteria. Decide the category scores first; then write a summary whose tone and conclusion MATCH that score. Never praise or sell a candidate the score denies or holds — for a Deny/Hold, lead with the decisive gap against the rubric and method; for an Advance, lead with what clears the bar. Every claim cites the action, omission, or rubric criterion it rests on.

COMPLIANCE FIREWALL (non-negotiable): job-relevant evidence only — never extract, infer, or flag protected/non-job attributes (age, race, national origin, religion, gender, orientation, disability, health, family status, photos, appearance). Return JSON only, no prose outside the JSON, in the exact shape requested below.`;

/** System prompt = the live "How We Evaluate" method doc + the output contract. */
function buildSystemPrompt(method?: string | null): string {
  const core = method?.trim() ? method.trim() : SYSTEM_PROMPT;
  return `${core}\n\n${OUTPUT_CONTRACT}`;
}

function categoryLabelLine(seat: SeatContext): string {
  return (Object.keys(seat.categoryLabels) as CategoryKey[])
    .map((k) => `${k} ("${seat.categoryLabels[k]}")`)
    .join(", ");
}

function calibrationBlock(input: EvaluatorInput): string {
  const sections: string[] = [];
  if (input.rubricGuidance?.trim()) {
    sections.push(`RUBRIC GUIDANCE FOR THIS SEAT (what "good" looks like — apply it):
"""
${input.rubricGuidance.trim().slice(0, 6000)}
"""`);
  }
  if (input.globalCalibration?.trim()) {
    sections.push(`CALIBRATION — HOW RDI SCORES (learned from reviewer corrections, applies to every seat; follow it):
"""
${input.globalCalibration.trim().slice(0, 4000)}
"""`);
  }
  if (input.roleCalibration?.trim()) {
    sections.push(`CALIBRATION — THIS SEAT SPECIFICALLY (learned from reviewer corrections on this role; follow it):
"""
${input.roleCalibration.trim().slice(0, 4000)}
"""`);
  }
  return sections.length ? `\n${sections.join("\n\n")}\n` : "";
}

/**
 * Career-span context for the maturation/trajectory read. This is a LEVEL/EXPERIENCE
 * inference from graduation + first-role dates — not age, and never a gate. It gives
 * the model the denominator for the progression rate (strata climbed per year of career).
 */
function careerSpanBlock(input: EvaluatorInput): string {
  const c = input.careerContext;
  if (!c) return "";
  const parts: string[] = [];
  if (c.graduationYear) parts.push(`undergraduate graduation ~${c.graduationYear}`);
  if (c.firstRoleYear) parts.push(`first professional role ~${c.firstRoleYear}`);
  if (c.yearsOfCareer) parts.push(`~${c.yearsOfCareer} years of career`);
  if (!parts.length) return "";

  const ageLine =
    c.approxCurrentAge && c.graduationYear
      ? `
MATURATION PLACEMENT: assuming the standard straight-through path (≈${c.assumedGradAge ?? 22} at undergraduate graduation), that puts them at roughly ${c.approxCurrentAge} now. Apply this estimate ONLY if the chronology is consistent with finishing the degree right after secondary school — no multi-year pre-college work, no late or part-time completion. If the path looks non-traditional, IGNORE the age estimate and use career span alone. This is a maturation-band placement to locate them on the RO capability curve; it is never an age you state, weight, deduct for, or gate on.`
      : "";

  return `
CAREER SPAN (for the maturation / trajectory read — this is a LEVEL inference, NOT age, and is NEVER a cutoff or gate): ${parts.join(", ")}.
Use this only as the DENOMINATOR of the progression rate: judge whether the highest stratum they reached is fast / on-track / slow for the span of career, and whether the slope is still rising or has flattened. A III reached in 8 years is a steeper curve than a III reached in 25. Calibrate the trajectory read to this; do not deduct or reject for the span itself.${ageLine}
`;
}

function buildUserPrompt(input: EvaluatorInput): string {
  return `SEAT: ${input.seat.jobTitle} — required stratum band ${input.seat.seatStratum}.
SEAT DESCRIPTION:
${input.seat.jdSummary}

RUBRIC CATEGORIES (max points): ${(Object.keys(input.weights) as CategoryKey[])
    .map((k) => `${input.seat.categoryLabels[k]} ${input.weights[k]}`)
    .join(" · ")}
Category keys map to seat language as: ${categoryLabelLine(input.seat)}
${calibrationBlock(input)}

CANDIDATE: ${input.name}
${careerSpanBlock(input)}
PARSED ROLES (oldest→newest where dated):
${JSON.stringify(input.roles, null, 2)}

RÉSUMÉ TEXT:
"""
${input.resumeText.slice(0, 12000)}
"""

APPLICATION ANSWERS:
${JSON.stringify(input.answers, null, 2)}

COVER LETTER:
${input.coverLetter?.slice(0, 3000) || "None"}

PUBLIC PROFESSIONAL PROFILE (for verification only; may be empty):
${input.publicProfile?.slice(0, 4000) || "Not fetched — mark profile-dependent claims UNVERIFIABLE."}

INTERVIEW / ASYNC VIDEO EVIDENCE (post-application — weight heavily when present):
${input.interviewEvidence?.trim() || "None yet"}

RECRUITER NOTES FROM WORKABLE (context only, not primary evidence):
${input.recruiterComments?.trim() || "None"}

VERDICT BANDS — the total you assign IS the founder-facing call. The "summary" you write must be consistent with the band your total lands in:
- 85–100 → ADVANCE (clears the seat bar)
- 70–84 → CONSIDER (holds the level, watch the caveat)
- 55–69 → HOLD (borderline — needs more evidence before a call)
- 0–54 → DENY (below the seat requirement)
Set the category scores first, sum them, see which band the total falls in, then write the summary as the justification of THAT band — referencing the seat's rubric criteria and the How-We-Evaluate method by name. Do not write an upbeat or selling summary for a total in the HOLD or DENY band.

Return this exact JSON shape (fill every field; arrays may be empty but must be present):
{
  "complement": "owner" | "technician",
  "complementRemoves": "specific founder burden this hire buys down (one phrase)",
  "salaryVector": "the salary-as-vector read, e.g. 'a fundraise decision, not a budget rejection'",
  "investHead": "Risk off the company" | "Work off the desk",
  "summary": "3-6 sentences that JUSTIFY the verdict your total implies (per VERDICT BANDS). Open with the decisive factor that sets the call against this seat's rubric and the How-We-Evaluate method: for DENY/HOLD lead with the disqualifying gap or missing evidence (cite the rubric criterion and the action/omission), NOT with praise; for ADVANCE/CONSIDER lead with what clears the bar. Frame on the one question (load off the desk, risk off the company, what's handed back, is the gap coverable), but the tone and conclusion MUST match the score — never sell or praise a candidate the score denies or holds. End on the one real constraint or the single thing a human must settle.",
  "categoryScores": { "principal": int, "environment": int, "scope": int, "writing": int, "tenure": int, "local": int },
  "confidence": "high" | "medium" | "text-unreliable",
  "salaryValue": "justified" | "great value" | "rich for fit" | "poor value" | "unstated",
  "salaryAsk": "e.g. $215k or null if unstated",
  "seatStratum": "${input.seat.seatStratum}",
  "currentCapability": "e.g. IVb–a",
  "trajectory": "grows-the-role" | "bends-away" | "plateaued" | "regressed",
  "textConfidence": "confirmed" | "downgraded" | "text-unreliable",
  "basis": "reasoning" | "role-and-tenure" | "reference",
  "aiLikelihood": 0.0,
  "roReads": [{ "role": "", "company": "", "years": 0, "stratum": "IIIa", "stratumRange": "IIIa–IVc", "verbs": {"I":[],"II":[],"III":[]}, "read": "one-sentence read of what level this role demonstrates and what burden it maps to", "level": "IIa–III", "burden": "what founder load it covers", "quote": "the résumé line the read rests on" }],
  "digIn": { "quality": "Strong|Mixed|Surface|Thin", "mix": "e.g. '1 owned (technical) · 2 intent answers, on point'", "integrity": "Clear|Minor|Material", "integrityNote": "what to watch, or empty", "careerRead": "one-line career read · portability to RDI risk", "resolve": ["things to settle live"] },
  "verification": { "read": "Clean|Minor flags|Material discrepancy|Unverified (no profile)", "claims": [{ "category": "", "application": "what the application says", "profile": "what the profile says", "verdict": "CONFIRMED|DISCREPANCY|UNVERIFIABLE", "note": "" }], "questions": ["pinpoint questions to resolve live"], "actions": ["checks before an offer"] },
  "answerGrades": [{ "question": "", "answer": "verbatim answer", "verdict": "OWNED|SURFACE|EVASIVE", "present": ["concepts demonstrated"], "note": "", "kind": "screen|intent" }],
  "composeQuestions": [{ "q": "tailored risk question", "why": "what it tests" }],
  "claims": [{ "category": "principal|environment|scope|writing|tenure|local", "claim": "the assertion", "sourceType": "resume|answer|application_field", "sourceRef": "where", "quote": "verbatim support" }]
}

Rules: category scores must not exceed their max. Keep all reads job-relevant. Cite the action behind every inference.`;
}

export async function evaluateCandidate(input: EvaluatorInput): Promise<EvaluatorOutput> {
  if (!hasAnthropic()) {
    return heuristicEvaluate(input);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    // The system prefix (global method doc + output contract) is identical across
    // every candidate, so cache it: a one-time write premium then 0.1x reads on the
    // rest of a batch run. It comfortably clears Sonnet's 2,048-token cache minimum.
    system: [
      {
        type: "text",
        text: buildSystemPrompt(input.method),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
  const match = text.match(/\{[\s\S]*\}/);
  let parsed: Partial<EvaluatorOutput>;
  try {
    parsed = JSON.parse(match?.[0] ?? "{}") as Partial<EvaluatorOutput>;
  } catch {
    // A truncated/malformed model response is a TRANSIENT failure, not a real
    // read. Flag it heuristic so the scorer skips persisting and retries — never
    // freeze a candidate on placeholder data.
    return heuristicEvaluate(input);
  }

  return normalize(parsed, input);
}

function clampCategories(
  raw: Partial<CategoryScores> | undefined,
  weights: Record<CategoryKey, number>,
): CategoryScores {
  const keys = Object.keys(weights) as CategoryKey[];
  const out = {} as CategoryScores;
  for (const key of keys) {
    const value = Number(raw?.[key] ?? 0);
    out[key] = Math.max(0, Math.min(weights[key], Math.round(Number.isFinite(value) ? value : 0)));
  }
  return out;
}

function normalize(parsed: Partial<EvaluatorOutput>, input: EvaluatorInput): EvaluatorOutput {
  const categoryScores = clampCategories(parsed.categoryScores, input.weights);
  const total = Object.values(categoryScores).reduce((sum, v) => sum + v, 0);
  const complement = parsed.complement === "owner" ? "owner" : "technician";

  return {
    complement,
    complementRemoves: parsed.complementRemoves ?? "operational load on the founder desk",
    salaryVector: parsed.salaryVector ?? "unpriced — salary unstated",
    investHead: parsed.investHead ?? (complement === "owner" ? "Risk off the company" : "Work off the desk"),
    summary: parsed.summary ?? "Investment read pending fuller evidence.",
    categoryScores,
    total,
    confidence: parsed.confidence ?? "medium",
    salaryValue: parsed.salaryValue ?? "unstated",
    salaryAsk: parsed.salaryAsk ?? null,
    seatStratum: parsed.seatStratum ?? input.seat.seatStratum,
    currentCapability: parsed.currentCapability ?? "—",
    trajectory: parsed.trajectory ?? "plateaued",
    textConfidence: parsed.textConfidence ?? "confirmed",
    basis: parsed.basis ?? "reasoning",
    aiLikelihood: typeof parsed.aiLikelihood === "number" ? parsed.aiLikelihood : 0.2,
    roReads: (parsed.roReads ?? []).map((r) => ({
      role: r.role ?? "",
      company: r.company ?? "",
      years: Number(r.years ?? 0),
      stratum: r.stratum ?? "—",
      stratumRange: r.stratumRange ?? r.stratum ?? "—",
      verbs: r.verbs ?? { I: [], II: [], III: [] },
      read: r.read ?? "",
      level: r.level ?? r.stratum ?? "—",
      burden: r.burden ?? "",
      quote: r.quote ?? "",
    })),
    digIn: {
      quality: parsed.digIn?.quality ?? "Mixed",
      mix: parsed.digIn?.mix ?? "",
      integrity: parsed.digIn?.integrity ?? "Clear",
      integrityNote: parsed.digIn?.integrityNote ?? "",
      careerRead: parsed.digIn?.careerRead ?? "",
      resolve: parsed.digIn?.resolve ?? [],
    },
    verification: {
      read: parsed.verification?.read ?? "Unverified (no profile)",
      claims: parsed.verification?.claims ?? [],
      questions: parsed.verification?.questions ?? [],
      actions: parsed.verification?.actions ?? [],
    },
    answerGrades: parsed.answerGrades ?? [],
    composeQuestions: parsed.composeQuestions ?? [],
    claims: (parsed.claims ?? []).filter((c) => c && c.claim),
  };
}

/** Deterministic fallback when no model key is present — keeps the app usable, never blank. */
function heuristicEvaluate(input: EvaluatorInput): EvaluatorOutput {
  const combined = `${input.resumeText}\n${Object.values(input.answers).join("\n")}`.toLowerCase();
  const ownerSignals = ["audit", "board", "p&l", "raise", "clia", "cap", "fda", "director"];
  const isOwner = ownerSignals.some((s) => combined.includes(s));
  const aiTell =
    combined.includes("positive working relationship") || combined.includes("prevent recurrence");
  const complement = isOwner ? "owner" : "technician";

  const categoryScores = clampCategories(
    {
      principal: Math.round(input.weights.principal * (isOwner ? 0.85 : 0.65)),
      environment: Math.round(input.weights.environment * 0.7),
      scope: Math.round(input.weights.scope * 0.65),
      writing: Math.round(input.weights.writing * (aiTell ? 0.45 : 0.7)),
      tenure: Math.round(input.weights.tenure * 0.6),
      local: Math.round(input.weights.local * (combined.includes("los angeles") ? 0.9 : 0.5)),
    },
    input.weights,
  );
  const total = Object.values(categoryScores).reduce((sum, v) => sum + v, 0);

  const roReads = input.roles.map((r) => ({
    role: r.title,
    company: r.company,
    years: 0,
    stratum: "—",
    stratumRange: "—",
    verbs: { I: [], II: [], III: [] },
    read: r.summary?.slice(0, 160) ?? `${r.title} at ${r.company}.`,
    level: isOwner ? "III–IV" : "II–III",
    burden: isOwner ? "function ownership" : "operational execution",
    quote: r.resumeLine ?? r.summary?.slice(0, 160) ?? "",
  }));

  const answerGrades = Object.entries(input.answers).map(([question, answer]) => {
    const lower = answer.toLowerCase();
    const verdict =
      lower.length < 40 ? "EVASIVE" : aiTell ? "SURFACE" : lower.includes("built") || lower.includes("led") ? "OWNED" : "SURFACE";
    return {
      question,
      answer,
      verdict: verdict as AnswerGradePayload["verdict"],
      present: [] as string[],
      note: "Graded on substance vs concept key (heuristic — no model key set).",
      kind: "screen",
    };
  });

  return {
    complement,
    complementRemoves: isOwner
      ? "the science & lab key-person risk that currently routes through the founder"
      : "operational load on the founder desk",
    salaryVector: "unpriced — confirm salary expectation",
    investHead: isOwner ? "Risk off the company" : "Work off the desk",
    summary:
      "Heuristic read (no model key configured). Set ANTHROPIC_API_KEY to generate the full RDI evaluation.",
    categoryScores,
    total,
    confidence: aiTell ? "text-unreliable" : "medium",
    salaryValue: "unstated",
    salaryAsk: null,
    seatStratum: input.seat.seatStratum,
    currentCapability: isOwner ? "III–IV" : "II–III",
    trajectory: "plateaued",
    textConfidence: aiTell ? "text-unreliable" : "confirmed",
    basis: aiTell ? "role-and-tenure" : "reasoning",
    aiLikelihood: aiTell ? 0.8 : 0.2,
    roReads,
    digIn: {
      quality: aiTell ? "Surface" : "Mixed",
      mix: `${answerGrades.length} answers on file`,
      integrity: aiTell ? "Minor" : "Clear",
      integrityNote: aiTell ? "Generic phrasing — verify in live conversation." : "",
      careerRead: "Career read pending model evaluation.",
      resolve: ["Confirm key claims in a live conversation."],
    },
    verification: {
      read: "Unverified (no profile)",
      claims: [],
      questions: [],
      actions: ["Run the full evaluation with a model key to populate verification."],
    },
    answerGrades,
    composeQuestions: [
      { q: "Walk me through the most ambiguous problem you owned end to end last year.", why: "Baseline judgment anchor." },
    ],
    claims: roReads.slice(0, 3).map((r) => ({
      category: "scope" as CategoryKey,
      claim: r.read,
      sourceType: "resume",
      sourceRef: `${r.company}`,
      quote: r.quote,
    })),
    heuristic: true,
  };
}
