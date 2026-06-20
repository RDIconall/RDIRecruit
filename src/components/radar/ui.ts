import type { OutreachStatus } from "@/lib/radar/types";

export const NAVY = "#162335";
export const ORANGE = "#E74424";
export const BRICK = "#9E3B28";

export interface Chip {
  c: string;
  bg: string;
  b: string;
}

// Recommendation labels come from the LLM but are constrained by the prompt.
export function recMeta(rec: string | null | undefined): Chip & { label: string } {
  const r = (rec ?? "").toLowerCase();
  if (r.includes("reach out")) return { label: rec!, c: ORANGE, bg: "rgba(231,68,36,0.10)", b: "rgba(231,68,36,0.32)" };
  if (r.includes("worth")) return { label: rec!, c: NAVY, bg: "rgba(22,35,53,0.06)", b: "rgba(22,35,53,0.22)" };
  if (r.includes("verif")) return { label: rec!, c: NAVY, bg: "transparent", b: "rgba(22,35,53,0.30)" };
  if (r.includes("backup")) return { label: rec!, c: "rgba(22,35,53,0.55)", bg: "transparent", b: "rgba(22,35,53,0.16)" };
  if (r.includes("pass")) return { label: rec!, c: BRICK, bg: "rgba(158,59,40,0.07)", b: "rgba(158,59,40,0.24)" };
  return { label: rec || "Unscored", c: "rgba(22,35,53,0.45)", bg: "transparent", b: "rgba(22,35,53,0.14)" };
}

export function outreachMeta(status: OutreachStatus | undefined): Chip & { label: string } {
  const map: Record<OutreachStatus, Chip & { label: string }> = {
    not_started: { label: "Not started", c: "rgba(22,35,53,0.45)", bg: "transparent", b: "rgba(22,35,53,0.14)" },
    drafted: { label: "Drafted", c: NAVY, bg: "rgba(22,35,53,0.06)", b: "rgba(22,35,53,0.20)" },
    sent: { label: "Sent", c: NAVY, bg: "rgba(22,35,53,0.06)", b: "rgba(22,35,53,0.22)" },
    replied: { label: "Replied", c: ORANGE, bg: "rgba(231,68,36,0.10)", b: "rgba(231,68,36,0.32)" },
    bounced: { label: "Bounced", c: BRICK, bg: "rgba(158,59,40,0.07)", b: "rgba(158,59,40,0.24)" },
    opted_out: { label: "Opted out", c: BRICK, bg: "rgba(158,59,40,0.07)", b: "rgba(158,59,40,0.24)" },
    no_response: { label: "No response", c: "rgba(22,35,53,0.55)", bg: "transparent", b: "rgba(22,35,53,0.16)" },
    meeting: { label: "Meeting booked", c: ORANGE, bg: "rgba(231,68,36,0.12)", b: "rgba(231,68,36,0.34)" },
  };
  return status ? map[status] : map.not_started;
}

// 1-5 overall → color band.
export function scoreColor(overall: number | null | undefined): string {
  if (overall == null) return "rgba(22,35,53,0.30)";
  if (overall >= 4) return ORANGE;
  if (overall >= 3) return NAVY;
  if (overall >= 2) return "rgba(22,35,53,0.55)";
  return BRICK;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
