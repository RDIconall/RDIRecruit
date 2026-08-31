import type { EvaluatorOutput } from "../scoring/evaluator";
import type { Decision, DecisionRead, ValueRead } from "../triage/types";

function decisionFor(evaluation: EvaluatorOutput): Decision {
  if (
    evaluation.integrityGate.status === "fail" ||
    evaluation.otherGateResults.some((gate) => gate.status === "fail" && gate.severity === "critical")
  ) {
    return "reject";
  }
  const substantive = evaluation.answerGrades.filter((grade) => grade.verdict === "OWNED").length;
  const empty = evaluation.answerGrades.filter(
    (grade) => grade.verdict === "SURFACE" || grade.verdict === "EVASIVE" || grade.verdict === "AI",
  ).length;
  if (
    evaluation.total < 55 &&
    evaluation.answerGrades.length > 0 &&
    substantive === 0 &&
    empty === evaluation.answerGrades.length
  ) {
    return "reject";
  }

  const verificationRead = evaluation.verification.read.toLowerCase();
  const discrepancy =
    verificationRead.includes("discrepancy") ||
    verificationRead.includes("material") ||
    evaluation.verification.claims.some((claim) => claim.verdict === "DISCREPANCY");
  if (discrepancy) return "backup";
  if ((!evaluation.salaryAsk || evaluation.salaryValue === "unstated") && evaluation.total < 82) {
    return "backup";
  }
  return evaluation.total >= 70 ? "interview" : "backup";
}

function nextAction(decision: Decision, postInterview: boolean): string {
  if (postInterview) {
    if (decision === "interview") return "Advance to next round";
    if (decision === "backup") return "Hold — do not advance yet";
    if (decision === "reject") return "Pass on the candidate";
    return "Re-sync";
  }
  if (decision === "interview") return "Interview";
  if (decision === "backup") return "Hold as backup";
  if (decision === "reject") return "Reject";
  return "Re-sync";
}

function valueRead(evaluation: EvaluatorOutput): ValueRead {
  if (!evaluation.salaryAsk || evaluation.salaryValue === "unstated") {
    return {
      headline: "Ask not stated",
      level: "none",
      detail: "Judge the candidate on strength alone and confirm salary before the next step.",
    };
  }
  const level: ValueRead["level"] =
    evaluation.salaryValue === "justified" || evaluation.salaryValue === "great value"
      ? "strong"
      : evaluation.salaryValue === "poor value"
        ? "weak"
        : "fair";
  return {
    headline:
      level === "strong"
        ? "Strength supports the ask"
        : level === "weak"
          ? "Limited evidence for the ask"
          : "Priced about right",
    level,
    detail: evaluation.salaryVector,
  };
}

export function decisionReadFromEvaluation(
  evaluation: EvaluatorOutput,
  postInterview: boolean,
  model: string,
): DecisionRead {
  const decision = decisionFor(evaluation);
  return {
    decision,
    why: evaluation.triage.why || evaluation.summary,
    risk: evaluation.triage.risk || evaluation.digIn.integrityNote || evaluation.digIn.resolve[0] || "",
    next: nextAction(decision, postInterview),
    ...(evaluation.triage.caveat ? { caveat: evaluation.triage.caveat } : {}),
    ...(evaluation.triage.timelineNote ? { timelineNote: evaluation.triage.timelineNote } : {}),
    ...(evaluation.triage.careerRead ? { careerRead: evaluation.triage.careerRead } : {}),
    ...(evaluation.triage.assessment ? { assessment: evaluation.triage.assessment } : {}),
    ...(evaluation.triage.rubricFit ? { rubricFit: evaluation.triage.rubricFit } : {}),
    value: valueRead(evaluation),
    recalculatedAt: new Date().toISOString(),
    model,
  };
}

