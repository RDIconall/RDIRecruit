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

export function normalizeSeatDimensionScores(
  raw: Partial<SeatDimensionScores> | undefined,
  dimensions: SeatDimension[],
): SeatDimensionScores {
  const out: SeatDimensionScores = {};
  for (const d of dimensions) {
    const value = Number(raw?.[d.key] ?? 0);
    out[d.key] = Math.max(0, Math.min(d.weight, Math.round(Number.isFinite(value) ? value : 0)));
  }
  return out;
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

/** Prefer seat-dimension totals, but never persist a 0 when the model only filled legacy buckets. */
export function resolveSeatTotal(input: {
  schemaVersion: RubricSchemaVersion;
  dimensions: SeatDimension[];
  dimensionScores: SeatDimensionScores;
  legacyTotal: number;
}): number {
  if (input.schemaVersion !== "seat-dimensions-v2" || !input.dimensions.length) {
    return Math.max(0, Math.min(100, Math.round(input.legacyTotal)));
  }
  const dimensionTotal = totalFromSeatDimensions(input.dimensionScores);
  const allZero = input.dimensions.every((d) => (input.dimensionScores[d.key] ?? 0) === 0);
  if (allZero && input.legacyTotal > 0) return Math.max(0, Math.min(100, Math.round(input.legacyTotal)));
  return Math.max(0, Math.min(100, Math.round(dimensionTotal)));
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
