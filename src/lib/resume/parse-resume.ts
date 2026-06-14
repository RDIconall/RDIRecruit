import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import type { ParsedResumeReview } from "./types";

const MODEL = "claude-sonnet-4-6";

function heuristicParse(text: string, workableExperience: unknown[]): ParsedResumeReview {
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
    education: [],
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
  if (!hasAnthropic() || input.resumeText.length < 80) {
    return heuristicParse(input.resumeText, input.workableExperience ?? []);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const prompt = `You are parsing a hiring résumé for RDI Trials. Extract a structured chronology ONCE — job-relevant only.

Candidate: ${input.candidateName}

Résumé text:
"""
${input.resumeText.slice(0, 14000)}
"""

Workable structured experience (may be incomplete — prefer résumé lines when they disagree, flag discrepancies):
${JSON.stringify(input.workableExperience ?? [], null, 2)}

Workable education:
${JSON.stringify(input.workableEducation ?? [], null, 2)}

Rules:
- Dates as YYYY-MM when possible.
- Detect gaps between roles ≥3 months; label honestly (e.g. "~9 months between roles — likely job search").
- Never extract protected-class attributes (age, race, religion, photos, etc.).
- chronologySummary: 2-3 sentence intelligent read of their career climb, date consistency, and anything a recruiter should verify live.
- dateFlags: array of NEEDS YOU items (overlaps, missing dates, title inflation vs tenure).
- Each role needs resumeLine: the exact or near-exact résumé line for source highlighting.

Return JSON only:
{
  "chronologySummary": string,
  "dateFlags": string[],
  "roles": [{"title","company","start","end","current":bool,"bullets":[],"resumeLine","stratumHint"}],
  "education": [{"school","degree","field","start","end"}],
  "gaps": [{"start","end","months","label","assumption":bool}]
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0]?.type === "text" ? response.content[0].text : "{}";
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match?.[0] ?? "{}") as Omit<ParsedResumeReview, "modelVersion" | "parsedAt">;

  return {
    chronologySummary: parsed.chronologySummary ?? "Résumé chronology parsed at ingest.",
    dateFlags: parsed.dateFlags ?? [],
    roles: parsed.roles ?? [],
    education: parsed.education ?? [],
    gaps: parsed.gaps ?? [],
    modelVersion: MODEL,
    parsedAt: new Date().toISOString(),
  };
}
