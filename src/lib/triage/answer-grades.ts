import type { VerdictRead } from "./types";

export type AnswerVerdictCount = {
  owned: number;
  surface: number;
  evasive: number;
  ai: number;
  syntheticUnsupported: number;
  zeroCredit: number;
  n: number;
  /** Concepts only from OWNED answers — surface/evasive must not inflate this. */
  ownedConcepts: number;
};

type AnswerGradeLike = {
  verdict?: string | null;
  present?: unknown;
  answerProvenance?: string | null;
  authorshipConfidence?: string | null;
  candidateEvidenceCredit?: string | null;
};

/** Count per-answer verdicts. Unknown/empty verdicts count as surface. */
export function countAnswerVerdicts(
  grades: AnswerGradeLike[],
): AnswerVerdictCount {
  let owned = 0,
    surface = 0,
    evasive = 0,
    ai = 0,
    syntheticUnsupported = 0,
    zeroCredit = 0,
    ownedConcepts = 0;
  for (const g of grades) {
    if (g.candidateEvidenceCredit === "zero") zeroCredit++;
    if (
      g.answerProvenance === "unsupported" &&
      g.authorshipConfidence === "likely_synthetic" &&
      g.candidateEvidenceCredit === "zero"
    ) {
      syntheticUnsupported++;
    }
    const v = (g.verdict ?? "").toUpperCase();
    if (v === "AI") {
      const backed =
        g.answerProvenance === "experience_backed" || g.answerProvenance === "adjacent_plausible";
      const credited = g.candidateEvidenceCredit === "high" || g.candidateEvidenceCredit === "partial";
      if (backed && credited) {
        owned++;
        if (Array.isArray(g.present)) ownedConcepts += g.present.filter(Boolean).length;
      } else {
        ai++;
      }
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
  return { owned, surface, evasive, ai, syntheticUnsupported, zeroCredit, n: grades.length, ownedConcepts };
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
 * 1. Unsupported likely-synthetic expertise with zero credit → weak
 * 2. Half+ AI → weak / AI-heavy
 * 3. Strict OWNED majority (owned > n/2) AND more owned than surface → strong
 * 4. Half+ surface, or any surface with zero owned → weak / Surface answers
 * 5. Half+ evasive (or evasive+AI) → weak
 * 6. Else mixed
 */
export function summarizeAnswerGrades(
  grades: AnswerGradeLike[],
): VerdictRead {
  if (!grades.length) return { label: "—", level: "none" };
  const c = countAnswerVerdicts(grades);
  const mix = mixLabel(c);
  const conceptBit = c.ownedConcepts ? ` · ${c.ownedConcepts} owned concepts` : "";
  const half = Math.ceil(c.n / 2);

  if (c.syntheticUnsupported >= 1 && c.syntheticUnsupported + c.zeroCredit >= half) {
    return { label: `Unsupported expertise (${mix || `${c.zeroCredit} zero-credit`})`, level: "weak" };
  }

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
