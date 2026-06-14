import type { ExtractedFeatures } from "../types";

export type EvaluationInsert = {
  kind: string;
  ref: string | null;
  payload: Record<string, unknown>;
};

export function buildEvaluationsFromFeatures(
  features: ExtractedFeatures,
  answers: Record<string, string>,
): EvaluationInsert[] {
  const rows: EvaluationInsert[] = [];

  const complement = features.principalType.includes("owner") ? "owner" : "technician";
  rows.push({
    kind: "invest_head",
    ref: null,
    payload: {
      complement,
      head: complement === "owner" ? "Risk off the company" : "Work off the desk",
    },
  });

  rows.push({
    kind: "dig_in",
    ref: null,
    payload: {
      summary: features.aiBoilerplateTell
        ? "Written answers show surface-level fluency without owned detail — integrity gate leans on live demonstration."
        : "Application evidence is concrete enough to advance; async video should stress-test judgment under ambiguity.",
      quality: features.aiBoilerplateTell ? "surface-heavy" : "owned-mixed",
      integrityGate: features.aiBoilerplateTell ? "hold-for-live" : "clear",
      settleLive: true,
    },
  });

  for (const [question, answer] of Object.entries(answers)) {
    const lower = answer.toLowerCase();
    const grade =
      lower.length < 40
        ? "EVASIVE"
        : features.aiBoilerplateTell && lower.includes("positive working relationship")
          ? "SURFACE"
          : lower.includes("built") || lower.includes("managed") || lower.includes("pushed back")
            ? "OWNED"
            : "SURFACE";
    rows.push({
      kind: "answer_grade",
      ref: question.slice(0, 80),
      payload: { question, answer, grade, note: `Graded on substance vs concept key.` },
    });
  }

  if (features.claims.length) {
    rows.push({
      kind: "verification",
      ref: "resume-consistency",
      payload: {
        verdict: features.aiBoilerplateTell ? "WATCH" : "CLEAN",
        category: "Application integrity",
        explanation: features.aiBoilerplateTell
          ? "Generic phrasing in written answers — verify claims in live conversation."
          : "No material résumé-vs-application conflicts detected at ingest.",
      },
    });
  }

  for (const claim of features.claims.slice(0, 5)) {
    if (claim.category === "scope" || claim.category === "principal") {
      rows.push({
        kind: "role_read",
        ref: claim.sourceRef,
        payload: {
          read: claim.claim,
          level: features.principalType.includes("owner") ? "IIa–III" : "IIb",
          burden: claim.category === "scope" ? "operational systems" : "principal support",
          quote: claim.quote,
        },
      });
    }
  }

  return rows;
}

export function overlayFromFeatures(features: ExtractedFeatures) {
  const complement = features.principalType.includes("owner")
    ? ("owner" as const)
    : ("technician" as const);
  const salaryAsk = parseSalaryAsk(features.salaryExpectation);

  return {
    complement,
    complement_removes:
      complement === "owner"
        ? "the science & lab key-person risk that currently routes through the founder"
        : "calendar, travel, and principal-support load on the desk",
    salary_vector: salaryAsk
      ? totalAboveStrong(salaryAsk)
        ? "a fundraise decision, not a budget rejection"
        : "within band for the seat stratum"
      : null,
    salary_ask: salaryAsk,
  };
}

function parseSalaryAsk(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/\$?\s*(\d{2,3})[\s,]*k/i) ?? raw.match(/\$([\d,]+)/);
  if (!match) return raw.slice(0, 32);
  const num = match[1]!.replace(/,/g, "");
  if (raw.toLowerCase().includes("k") || num.length <= 3) return `$${num}k`;
  return `$${Number(num).toLocaleString()}`;
}

function totalAboveStrong(_ask: string) {
  return false;
}
