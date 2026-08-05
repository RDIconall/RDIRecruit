import type { VerdictRead } from "./types";

export type AnswerVerdictCount = {
  owned: number;
  surface: number;
  evasive: number;
  ai: number;
  n: number;
  /** Concepts only from OWNED answers — surface/evasive must not inflate this. */
  ownedConcepts: number;
};

/** Count per-answer verdicts. Unknown/empty verdicts count as surface. */
export function countAnswerVerdicts(
  grades: Array<{ verdict?: string | null; present?: unknown }>,
): AnswerVerdictCount {
  let owned = 0,
    surface = 0,
    evasive = 0,
    ai = 0,
    ownedConcepts = 0;
  for (const g of grades) {
    const v = (g.verdict ?? "").toUpperCase();
    if (v === "AI") {
      ai++;
    } else if (v === "OWNED") {
      owned++;
      if (Array.isArray(g.present)) ownedConcepts += g.present.filter(Boolean).length;
    } else if (v === "EVASIVE") {
      evasive++;
    } else {
      // SURFACE, blank, or unknown — never credit as owned
      surface++;
    }
  }
  return { owned, surface, evasive, ai, n: grades.length, ownedConcepts };
}

function mixLabel(c: AnswerVerdictCount): string {
  return [
    c.owned ? `${c.owned} owned` : "",
    c.surface ? `${c.surface} surface` : "",
    c.evasive ? `${c.evasive} evasive` : "",
    c.ai ? `${c.ai} AI` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Collapse per-answer grades to one pool label.
 *
 * Rules (strict — surface must not read as strong):
 * 1. Half+ AI → weak / AI-heavy
 * 2. Strict OWNED majority (owned > n/2) AND more owned than surface → strong
 * 3. Half+ surface, or any surface with zero owned → weak / Surface answers
 * 4. Half+ evasive (or evasive+AI) → weak
 * 5. Else mixed
 */
export function summarizeAnswerGrades(
  grades: Array<{ verdict?: string | null; present?: unknown }>,
): VerdictRead {
  if (!grades.length) return { label: "—", level: "none" };
  const c = countAnswerVerdicts(grades);
  const mix = mixLabel(c);
  const conceptBit = c.ownedConcepts ? ` · ${c.ownedConcepts} owned concepts` : "";
  const half = Math.ceil(c.n / 2);

  if (c.ai >= half) {
    return { label: `AI-heavy (${mix})`, level: "weak" };
  }

  // Strict majority owned, and owned beats surface — two surface answers can never be "strong".
  if (c.owned > c.n / 2 && c.owned > c.surface) {
    return { label: `Strong answers (${mix}${conceptBit})`, level: "strong" };
  }

  if (c.surface >= half || (c.owned === 0 && c.surface > 0)) {
    return { label: `Surface answers (${mix})`, level: "weak" };
  }

  if (c.evasive + c.ai >= half) {
    return { label: `Weak answers (${mix})`, level: "weak" };
  }

  return { label: `Mixed answers (${mix}${conceptBit})`, level: "mixed" };
}

/**
 * Key for matching "the same question" across candidates: lowercase, collapse
 * whitespace, strip trailing punctuation. Workable question text is identical
 * per job, so this only has to absorb formatting noise.
 */
export function answerQuestionKey(q: string | null | undefined): string {
  return (q ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s?.:!]+$/g, "")
    .trim();
}

/**
 * Place one candidate's answer against the rest of the pool's answers to the
 * SAME question. This is deterministic aggregation over the per-answer verdicts
 * the AI grader already produced for every candidate — the grader itself reads
 * one candidate at a time and is forbidden from inventing cross-candidate
 * claims, so the comparison has to be assembled here from real grades.
 *
 * Returns null when nobody else has answered the question (no comparison to make).
 */
export function compareAnswerToPool(
  verdict: string | null | undefined,
  otherVerdicts: Array<string | null | undefined>,
): string | null {
  if (!otherVerdicts.length) return null;
  const up = (v: string | null | undefined) => (v ?? "").toUpperCase();
  const total = otherVerdicts.length + 1;
  const ownedOthers = otherVerdicts.filter((v) => up(v) === "OWNED").length;
  const mine = up(verdict);

  if (mine === "OWNED") {
    return ownedOthers === 0
      ? `the only owned answer to this question across ${total} candidates`
      : `one of ${ownedOthers + 1} owned answers to this question across ${total} candidates`;
  }

  const read = mine === "AI" ? "reads as AI" : mine === "EVASIVE" ? "dodges it" : "stays surface";
  if (ownedOthers > 0) {
    return `${ownedOthers} of ${total} candidates answered this at owned depth — this one ${read}`;
  }
  return `no owned answers to this question yet across ${total} candidates — this one ${read}`;
}
