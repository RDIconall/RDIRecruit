import type { WorkableCandidate } from "../workable/client";

/** Reconstruct Workable-shaped data from cached `candidates.raw` jsonb. */
export function workableFromRaw(raw: Record<string, unknown> | null | undefined): WorkableCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as unknown as WorkableCandidate;
}

export function experienceFromRawOrApplication(
  raw: Record<string, unknown> | null | undefined,
  parsedExperience: unknown[] | null | undefined,
): Array<{ title?: string; company?: string; current?: boolean }> {
  const workable = workableFromRaw(raw);
  if (workable?.experience_entries?.length) {
    return workable.experience_entries.map((e) => ({
      title: e.title,
      company: e.company,
      current: Boolean(e.current),
    }));
  }
  return (parsedExperience ?? []) as Array<{ title?: string; company?: string; current?: boolean }>;
}
