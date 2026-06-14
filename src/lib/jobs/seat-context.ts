import type { CategoryKey } from "../types";

export interface SeatContext {
  jobTitle: string;
  /** The stratum band the seat requires, e.g. "IVc–IVb" or "IIb–IIa". */
  seatStratum: string;
  /** One-paragraph read of what this seat needs — fed to the evaluator. */
  jdSummary: string;
  /** Category labels as the board renders them (rubric categories → seat language). */
  categoryLabels: Record<CategoryKey, string>;
}

/**
 * The six rubric categories the grader scores against. Mirrors `CATEGORY_LABELS`
 * in board/format.ts and the rubric markdown's "Weights" section so the prompt,
 * the UI, and the rubric all agree on the same criteria.
 */
const CATEGORY_LABELS: Record<CategoryKey, string> = {
  principal: "Principal",
  environment: "Environment",
  scope: "Scope",
  writing: "Writing",
  tenure: "Tenure",
  local: "Local",
};

function seatStratumFromTitle(title: string): string {
  const t = title.toLowerCase();
  if (/(chief|vp|vice president|head of|director)/.test(t)) return "IVc–IVb";
  if (/(principal|lead|senior manager|associate director)/.test(t)) return "IIIb–IIIa";
  if (/(manager|supervisor|senior)/.test(t)) return "IIIc–IIIb";
  if (/(coordinator|assistant|associate|analyst|specialist)/.test(t)) return "IIb–IIa";
  return "IIIb–IIIa";
}

/**
 * Builds the seat framing for the evaluator. Workable's job description (in
 * `raw.description` / `raw.full_description`) is used verbatim when present;
 * otherwise we derive a faithful default from the title.
 */
export function buildSeatContext(input: {
  title: string;
  department?: string | null;
  location?: string | null;
  raw?: Record<string, unknown> | null;
}): SeatContext {
  const title = input.title || "the open seat";
  const seatStratum = seatStratumFromTitle(title);

  const rawDescription =
    (input.raw?.full_description as string | undefined) ??
    (input.raw?.description as string | undefined) ??
    (input.raw?.requirements as string | undefined) ??
    "";

  const locationLine = input.location ? ` based in ${input.location}` : "";
  const deptLine = input.department ? ` in ${input.department}` : "";

  const jdSummary = rawDescription
    ? stripHtml(rawDescription).slice(0, 4000)
    : `${title}${deptLine}${locationLine} at RDI Trials — an IVD-only CRO. ` +
      `The seat sits at stratum ${seatStratum}; evaluate which founder burden it buys down ` +
      `(work off the desk vs. risk off the company) and whether the gap it hands back is one RDI can cover.`;

  return {
    jobTitle: title,
    seatStratum,
    jdSummary,
    categoryLabels: CATEGORY_LABELS,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
