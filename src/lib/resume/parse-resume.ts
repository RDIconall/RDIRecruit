import type { ParsedResumeReview } from "./types";

function heuristicParse(
  text: string,
  workableExperience: unknown[],
  workableEducation: unknown[],
): ParsedResumeReview {
  const roles = (workableExperience as Array<{
    title?: string;
    company?: string;
    start?: string;
    end?: string;
    current?: boolean;
    summary?: string;
  }>).map((entry) => ({
    title: entry.title ?? "Role",
    company: entry.company ?? "Company",
    start: entry.start?.slice(0, 7) ?? null,
    end: entry.current ? null : entry.end?.slice(0, 7) ?? null,
    current: Boolean(entry.current),
    bullets: entry.summary ? [entry.summary] : [],
    resumeLine: `${entry.title ?? ""} · ${entry.company ?? ""}`.trim(),
  }));

  return {
    chronologySummary: "Parsed from Workable structured fields — run full résumé ingest for line-level review.",
    dateFlags: [],
    roles,
    education: (workableEducation as Array<{
      school?: string;
      degree?: string;
      field?: string;
      start?: string;
      end?: string;
    }>).map((entry) => ({
      school: entry.school ?? "School",
      degree: entry.degree ?? null,
      field: entry.field ?? null,
      start: entry.start?.slice(0, 7) ?? null,
      end: entry.end?.slice(0, 7) ?? null,
    })),
    gaps: [],
    modelVersion: "heuristic",
    parsedAt: new Date().toISOString(),
  };
}

export async function parseResumeIntelligently(input: {
  candidateName: string;
  resumeText: string;
  workableExperience?: unknown[];
  workableEducation?: unknown[];
}): Promise<ParsedResumeReview> {
  // Résumé extraction is intentionally deterministic. The one canonical
  // candidate analysis reads the full résumé text and performs the actual hiring
  // judgment; buying a second model call merely to reshape Workable's structured
  // fields violated the one-call-per-material-version contract.
  return heuristicParse(
    input.resumeText,
    input.workableExperience ?? [],
    input.workableEducation ?? [],
  );
}
