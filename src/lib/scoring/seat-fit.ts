import type {
  AlternateSeatSignal,
  AnswerGradePayload,
  CategoryKey,
  CategoryScores,
  GateResult,
  IntegrityGate,
  RubricSchemaVersion,
  SeatDimension,
  SeatDimensionScores,
} from "../types";

export type DecisionBand = "STRONG" | "VIABLE" | "HOLD" | "PASS";

export interface GateAdjustment {
  total: number;
  band: DecisionBand;
  capped: boolean;
  capReasons: string[];
}

export function decisionBand(total: number): DecisionBand {
  if (total >= 85) return "STRONG";
  if (total >= 70) return "VIABLE";
  if (total >= 55) return "HOLD";
  return "PASS";
}

/**
 * Match the model's dimension keys to the rubric's, tolerantly.
 *
 * The keys are slugified from the rubric markdown, and the model rarely echoes
 * them byte-for-byte — it uses the label, changes separators, or drops filler
 * words. An exact-match lookup scored every near-miss 0, so a strong candidate
 * could total 37 instead of 84 and land in the reject band. Match on the key or
 * the label, ignoring case, punctuation, and "and".
 */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

function looseKey(value: string): string {
  return normalizeKey(value).replace(/\band\b/g, "").replace(/and/g, "");
}

export interface SeatDimensionMatch {
  scores: SeatDimensionScores;
  /** How many of the rubric's dimensions the model actually supplied. */
  matched: number;
}

export function matchSeatDimensionScores(
  raw: Partial<SeatDimensionScores> | undefined,
  dimensions: SeatDimension[],
): SeatDimensionMatch {
  const exact = new Map<string, string>();
  const normalized = new Map<string, string>();
  const loose = new Map<string, string>();
  for (const d of dimensions) {
    exact.set(d.key, d.key);
    for (const candidate of [d.key, d.label]) {
      if (!normalized.has(normalizeKey(candidate))) normalized.set(normalizeKey(candidate), d.key);
      if (!loose.has(looseKey(candidate))) loose.set(looseKey(candidate), d.key);
    }
  }

  const resolved = new Map<string, number>();
  for (const [rawKey, rawValue] of Object.entries(raw ?? {})) {
    const target =
      exact.get(rawKey) ?? normalized.get(normalizeKey(rawKey)) ?? loose.get(looseKey(rawKey));
    if (!target || resolved.has(target)) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    resolved.set(target, value);
  }

  const scores: SeatDimensionScores = {};
  for (const d of dimensions) {
    const value = resolved.get(d.key) ?? 0;
    scores[d.key] = Math.max(0, Math.min(d.weight, Math.round(value)));
  }
  return { scores, matched: resolved.size };
}

export function normalizeSeatDimensionScores(
  raw: Partial<SeatDimensionScores> | undefined,
  dimensions: SeatDimension[],
): SeatDimensionScores {
  return matchSeatDimensionScores(raw, dimensions).scores;
}

export function totalFromSeatDimensions(scores: SeatDimensionScores): number {
  return Object.values(scores).reduce((sum, value) => sum + value, 0);
}

export function isMaterialSyntheticAnswer(answer: Pick<AnswerGradePayload, "answerProvenance" | "authorshipConfidence" | "candidateEvidenceCredit">): boolean {
  return (
    answer.answerProvenance === "unsupported" &&
    answer.authorshipConfidence === "likely_synthetic" &&
    answer.candidateEvidenceCredit === "zero"
  );
}

export function hasMaterialSyntheticExpertise(answers: AnswerGradePayload[] | undefined): boolean {
  return Boolean(answers?.some(isMaterialSyntheticAnswer));
}

export function hasFailingGate(gates: GateResult[] | undefined): GateResult | null {
  return (
    gates?.find(
      (g) => g.status === "fail" || (g.status === "warn" && g.severity === "critical"),
    ) ?? null
  );
}

export function applySeatGates(input: {
  rawTotal: number;
  dimensions: SeatDimension[];
  dimensionScores: SeatDimensionScores;
  integrityGate?: IntegrityGate | null;
  otherGateResults?: GateResult[] | null;
  answerGrades?: AnswerGradePayload[];
}): GateAdjustment {
  let total = Math.max(0, Math.min(100, Math.round(input.rawTotal)));
  const capReasons: string[] = [];

  if (input.integrityGate?.status === "fail") {
    total = Math.min(total, 54);
    capReasons.push(input.integrityGate.note || "Integrity gate failed.");
  }

  const failedGate = hasFailingGate(input.otherGateResults ?? undefined);
  if (failedGate) {
    total = Math.min(total, 54);
    capReasons.push(`${failedGate.label}: ${failedGate.note}`);
  }

  for (const dimension of input.dimensions) {
    if (dimension.criticalMinimum == null) continue;
    const score = input.dimensionScores[dimension.key] ?? 0;
    if (score < dimension.criticalMinimum) {
      total = Math.min(total, 84);
      capReasons.push(
        `${dimension.label} below critical minimum (${score}/${dimension.weight}; minimum ${dimension.criticalMinimum}).`,
      );
    }
  }

  return {
    total,
    band: decisionBand(total),
    capped: capReasons.length > 0,
    capReasons,
  };
}

export function legacyCategoriesFromSeatTotal(
  total: number,
  weights: Record<CategoryKey, number>,
): CategoryScores {
  const keys = Object.keys(weights) as CategoryKey[];
  const target = Math.max(0, Math.min(100, Math.round(total)));
  const weightTotal = keys.reduce((sum, key) => sum + weights[key], 0) || 1;
  const out = {} as CategoryScores;
  let running = 0;

  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      out[key] = Math.max(0, Math.min(weights[key], target - running));
      return;
    }
    const value = Math.max(0, Math.min(weights[key], Math.round((weights[key] / weightTotal) * target)));
    out[key] = value;
    running += value;
  });

  return out;
}

/**
 * Prefer seat-dimension totals, but never persist a number the model did not
 * actually produce. If most dimensions came back unmatched or unscored, summing
 * what remains understates the candidate badly — a single 4-point dimension
 * reads as a 4/100 reject. Fall back to the legacy total in that case.
 */
export function resolveSeatTotal(input: {
  schemaVersion: RubricSchemaVersion;
  dimensions: SeatDimension[];
  dimensionScores: SeatDimensionScores;
  legacyTotal: number;
}): number {
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  if (input.schemaVersion !== "seat-dimensions-v2" || !input.dimensions.length) {
    return clamp(input.legacyTotal);
  }
  const scored = input.dimensions.filter((d) => (input.dimensionScores[d.key] ?? 0) > 0).length;
  const enoughCoverage = scored >= Math.ceil(input.dimensions.length / 2);
  if (!enoughCoverage && input.legacyTotal > 0) return clamp(input.legacyTotal);
  return clamp(totalFromSeatDimensions(input.dimensionScores));
}

export function rubricSchemaForDimensions(dimensions: SeatDimension[]): RubricSchemaVersion {
  return dimensions.length && dimensions.reduce((sum, d) => sum + d.weight, 0) === 100
    ? "seat-dimensions-v2"
    : "legacy-v1";
}

export function bestAlternateSeat(signals: AlternateSeatSignal[] | undefined): AlternateSeatSignal | null {
  if (!signals?.length) return null;
  const weight = { high_potential: 3, possible: 2, weak: 1 } as const;
  return [...signals].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || weight[b.fit] - weight[a.fit],
  )[0] ?? null;
}
