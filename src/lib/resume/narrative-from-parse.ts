import type { NarrativeSegment } from "../types";
import type { ParsedResumeReview } from "./types";

function formatSpan(start: string | null, end: string | null, current?: boolean): string {
  if (!start) return "unknown";
  const endLabel = current || !end ? "present" : end.slice(0, 7);
  return `${start.slice(0, 7)} – ${endLabel}`;
}

export function narrativeFromParsedResume(parsed: ParsedResumeReview): NarrativeSegment[] {
  const segments: NarrativeSegment[] = [];

  for (const edu of parsed.education) {
    segments.push({
      span: formatSpan(edu.start, edu.end),
      type: "education",
      text: `${edu.degree ?? "Studied"}${edu.field ? ` in ${edu.field}` : ""} at ${edu.school}`,
    });
  }

  const sortedRoles = [...parsed.roles].sort((a, b) =>
    (a.start ?? "").localeCompare(b.start ?? ""),
  );

  let gapIndex = 0;
  for (const role of sortedRoles) {
    while (
      gapIndex < parsed.gaps.length &&
      parsed.gaps[gapIndex]!.start <= (role.start ?? "")
    ) {
      const gap = parsed.gaps[gapIndex]!;
      segments.push({
        span: formatSpan(gap.start, gap.end),
        type: "gap",
        text: gap.label,
        assumption: gap.assumption ?? true,
      });
      gapIndex += 1;
    }

    segments.push({
      span: formatSpan(role.start, role.end, role.current),
      type: "role",
      text: `${role.title} at ${role.company}`,
    });
  }

  while (gapIndex < parsed.gaps.length) {
    const gap = parsed.gaps[gapIndex]!;
    segments.push({
      span: formatSpan(gap.start, gap.end),
      type: "gap",
      text: gap.label,
      assumption: gap.assumption ?? true,
    });
    gapIndex += 1;
  }

  return segments;
}

export function experienceFromParsedResume(parsed: ParsedResumeReview) {
  return parsed.roles.map((role) => ({
    title: role.title,
    company: role.company,
    start: role.start ?? undefined,
    end: role.end ?? undefined,
    current: role.current,
    summary: role.bullets.join(" "),
    resumeLine: role.resumeLine || role.bullets.join(" "),
  }));
}

export function educationFromParsedResume(parsed: ParsedResumeReview) {
  return parsed.education.map((edu) => ({
    school: edu.school,
    degree: edu.degree ?? undefined,
    start: edu.start ?? undefined,
    end: edu.end ?? undefined,
  }));
}
