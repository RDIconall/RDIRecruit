/** Canonical URL helpers — spec routes live under `/jobs/...`. */

export function jobBoardPath(shortcode: string, tier?: string): string {
  const base = `/jobs/${encodeURIComponent(shortcode)}`;
  return tier ? `${base}?tier=${encodeURIComponent(tier)}` : base;
}

export function candidatePath(jobShortcode: string, candidateId: string): string {
  return `/jobs/${encodeURIComponent(jobShortcode)}/c/${encodeURIComponent(candidateId)}`;
}

export function composePath(jobShortcode: string, candidateId: string): string {
  return `/jobs/${encodeURIComponent(jobShortcode)}/c/${encodeURIComponent(candidateId)}/compose`;
}
