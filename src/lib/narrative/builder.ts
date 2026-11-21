import type { NarrativeSegment } from "../types";

function monthDiff(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}

function formatSpan(start?: string, end?: string, current?: boolean): string {
  if (!start) return "unknown";
  const endLabel = current ? "present" : end ? end.slice(0, 7) : "no end date";
  return `${start.slice(0, 7)} – ${endLabel}`;
}

export function buildLifeNarrative(input: {
  experience: Array<{
    title: string;
    company: string;
    start?: string;
    end?: string;
    current?: boolean;
  }>;
  education: Array<{
    school: string;
    degree?: string;
    start?: string;
    end?: string;
  }>;
}): NarrativeSegment[] {
  const segments: NarrativeSegment[] = [];

  for (const edu of input.education) {
    segments.push({
      span: formatSpan(edu.start, edu.end),
      type: "education",
      text: `${edu.degree ?? "Studied"} at ${edu.school}`,
    });
  }

  const roles = [...input.experience].sort((a, b) =>
    (a.start ?? "").localeCompare(b.start ?? ""),
  );

  let previousEnd: Date | null = null;
  for (const role of roles) {
    const start = role.start ? new Date(role.start) : null;
    const end = role.current ? new Date() : role.end ? new Date(role.end) : null;

    if (start && previousEnd) {
      const gapMonths = monthDiff(previousEnd, start);
      if (gapMonths > 2) {
        segments.push({
          span: formatSpan(previousEnd.toISOString(), start.toISOString()),
          type: "gap",
          text: `[~${gapMonths} months between roles — likely job search]`,
          assumption: true,
        });
      }
    }

    segments.push({
      span: formatSpan(role.start, role.end, role.current),
      type: "role",
      text: `${role.title} at ${role.company}`,
    });

    if (start) previousEnd = end;
  }

  return segments;
}
