import type {
  Confidence,
  RoAssessmentRow,
  RoRoleAssessment,
  TextConfidence,
  Trajectory,
} from "../types";

const STRATUM_I = ["scheduled", "booked", "filed", "processed", "greeted", "entered"];
const STRATUM_II = [
  "managed",
  "triaged",
  "anticipated",
  "prioritized",
  "owned end-to-end",
  "maintained confidential",
];
const STRATUM_III = [
  "led",
  "built",
  "redesigned",
  "established",
  "strategic partner",
];

function inferStratum(text: string): { stratum: string; verbs: RoRoleAssessment["verbs"] } {
  const lower = text.toLowerCase();
  const verbs = {
    I: STRATUM_I.filter((v) => lower.includes(v)),
    II: STRATUM_II.filter((v) => lower.includes(v)),
    III: STRATUM_III.filter((v) => lower.includes(v)),
  };

  if (verbs.III.length >= 2) return { stratum: "IIIb", verbs };
  if (verbs.III.length >= 1 || verbs.II.length >= 2) return { stratum: "IIa", verbs };
  if (verbs.II.length >= 1) return { stratum: "IIb", verbs };
  return { stratum: "I", verbs };
}

function yearsBetween(start?: string, end?: string): number {
  if (!start) return 0;
  const startDate = new Date(start);
  const endDate = end ? new Date(end) : new Date();
  return Math.max(0, (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365));
}

export function assessRoFromExperience(
  experience: Array<{
    title: string;
    company: string;
    start?: string;
    end?: string;
    summary?: string;
  }>,
  options?: {
    seatStratum?: string;
    aiLikelihood?: number;
    reasoningText?: string;
  },
): Omit<RoAssessmentRow, "id" | "candidate_id" | "created_at"> {
  const perRole: RoRoleAssessment[] = experience.map((role) => {
    const text = `${role.title} ${role.summary ?? ""}`;
    const inferred = inferStratum(text);
    const years = yearsBetween(role.start, role.end);
    return {
      role: role.title,
      company: role.company,
      years: Number(years.toFixed(1)),
      stratum: inferred.stratum,
      stratum_range: `${inferred.stratum}`,
      verbs: inferred.verbs,
    };
  });

  const reasoning = options?.reasoningText ?? experience.map((r) => r.summary ?? "").join(" ");
  const reasoningRead = inferStratum(reasoning);
  const resumeRead = perRole.at(-1)?.stratum ?? "I";

  let textConfidence: TextConfidence = "confirmed";
  let basis = "reasoning";
  let currentCapability = reasoningRead.stratum;

  const aiLikely = (options?.aiLikelihood ?? 0) >= 0.7;
  if (aiLikely) {
    textConfidence = "text-unreliable";
    basis = "role-and-tenure";
    currentCapability = resumeRead;
  } else if (compareStratum(reasoningRead.stratum, resumeRead) < 0) {
    textConfidence = "downgraded";
    currentCapability = reasoningRead.stratum;
  }

  const trajectory = inferTrajectory(perRole);

  return {
    per_role: perRole,
    seat_stratum: options?.seatStratum ?? "IIb-IIa",
    current_capability: currentCapability,
    trajectory,
    text_confidence: textConfidence,
    basis,
  };
}

function compareStratum(a: string, b: string): number {
  const rank = (value: string) => {
    if (value.startsWith("III")) return 3;
    if (value.startsWith("II")) return 2;
    return 1;
  };
  return rank(a) - rank(b);
}

function inferTrajectory(perRole: RoRoleAssessment[]): Trajectory {
  if (perRole.length < 2) return "plateaued";
  const first = compareStratum(perRole[0]!.stratum, "I");
  const last = compareStratum(perRole.at(-1)!.stratum, perRole[0]!.stratum);
  if (last > 0) return "grows-the-role";
  if (last < 0) return "regressed";
  return "plateaued";
}

export function confidenceLabel(confidence: TextConfidence): string {
  switch (confidence) {
    case "confirmed":
      return "Confirmed from reasoning";
    case "downgraded":
      return "Downgraded — résumé over-claimed";
    case "text-unreliable":
      return "Text unreliable — lean on tenure/references";
  }
}

export function mapRoConfidenceToFit(confidence: TextConfidence): Confidence {
  if (confidence === "text-unreliable") return "text-unreliable";
  if (confidence === "downgraded") return "medium";
  return "high";
}
