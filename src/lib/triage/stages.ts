/** Workable pipeline stage helpers — Workable is SoT for where a candidate sits. */

export interface StageColumn {
  slug: string;
  name: string;
  /** True for Applied/Sourced/New — the triage inbox. */
  isInbox: boolean;
}

const INBOX_KEYS = new Set(["", "sourced", "applied", "new", "lead", "candidate"]);

/** Normalize a stage name or slug for comparison. */
export function stageKey(stage: string | null | undefined): string {
  return (stage ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isInboxStage(stage: string | null | undefined): boolean {
  const key = stageKey(stage).replace(/\s+/g, "");
  if (!key) return true;
  return INBOX_KEYS.has(stageKey(stage)) || INBOX_KEYS.has(key);
}

/** Match a candidate's mirrored stage string to a Workable stage slug/name. */
export function matchStageSlug(
  stage: string | null | undefined,
  columns: StageColumn[],
): string | null {
  const key = stageKey(stage);
  if (!key) return columns.find((c) => c.isInbox)?.slug ?? null;
  for (const col of columns) {
    if (stageKey(col.slug) === key || stageKey(col.name) === key) return col.slug;
    if (stageKey(col.slug).replace(/\s+/g, "") === key.replace(/\s+/g, "")) return col.slug;
    if (stageKey(col.name).replace(/\s+/g, "") === key.replace(/\s+/g, "")) return col.slug;
  }
  return null;
}

/** Prefer a Phone Screen / Interview-ish stage for "Send to screen". */
export function phoneScreenSlug(columns: StageColumn[]): string | null {
  const prefer = columns.find((c) => {
    const k = stageKey(c.name) + " " + stageKey(c.slug);
    return /phone|screen|interview/.test(k) && !c.isInbox;
  });
  if (prefer) return prefer.slug;
  return columns.find((c) => !c.isInbox)?.slug ?? null;
}

/** Next stage after the candidate's current one (by column order). */
export function nextStageSlug(
  current: string | null | undefined,
  columns: StageColumn[],
): string | null {
  const pipeline = columns.filter((c) => c.slug !== "disqualified");
  const cur = matchStageSlug(current, pipeline);
  const idx = pipeline.findIndex((c) => c.slug === cur);
  if (idx < 0) return phoneScreenSlug(pipeline);
  return pipeline[idx + 1]?.slug ?? null;
}

/**
 * Build display columns from Workable stages. Always appends a Disqualified
 * column (disposition, not a Workable "stage" in the same sense).
 */
export function buildStageColumns(
  stages: Array<{ slug: string; name: string; kind?: string; position?: number }>,
): StageColumn[] {
  const sorted = [...stages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const cols: StageColumn[] = sorted.map((s) => ({
    slug: s.slug,
    name: s.name || s.slug,
    isInbox: isInboxStage(s.slug) || isInboxStage(s.name) || s.kind === "sourced",
  }));
  if (!cols.some((c) => c.isInbox)) {
    cols.unshift({ slug: "applied", name: "Applied", isInbox: true });
  }
  cols.push({ slug: "disqualified", name: "Disqualified", isInbox: false });
  return cols;
}

/** Fallback when Workable stages can't be loaded. */
export const FALLBACK_STAGES: StageColumn[] = [
  { slug: "applied", name: "Applied", isInbox: true },
  { slug: "phone-screen", name: "Phone Screen", isInbox: false },
  { slug: "interview", name: "Interview", isInbox: false },
  { slug: "offer", name: "Offer", isInbox: false },
  { slug: "hired", name: "Hired", isInbox: false },
  { slug: "disqualified", name: "Disqualified", isInbox: false },
];
