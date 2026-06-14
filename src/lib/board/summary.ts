import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import { readSyncState, writeSyncState } from "../sync/sync-state";
import { getBoardFromSupabase } from "../data/board-queries";
import { tierKeyFromTotal } from "./format";

const MODEL = "claude-sonnet-4-6";

function key(jobShortcode: string) {
  return `board_summary:${jobShortcode}`;
}

/** Cached board-level narrative (generated on sync), or null. */
export async function getBoardSummary(jobShortcode: string): Promise<string | null> {
  const state = await readSyncState<{ text: string | null }>(key(jobShortcode), { text: null });
  return state.text ?? null;
}

/**
 * Regenerate the editorial board summary for a job — the "read the pipeline at a
 * glance" paragraph. Cheap: one Claude call over the top candidates' cached
 * reads. Stored in sync_state so the board renders it without a model call.
 */
export async function regenerateBoardSummary(jobShortcode: string, jobTitle?: string): Promise<string | null> {
  const board = await getBoardFromSupabase(jobShortcode);
  if (!board?.length) return null;

  const active = board.filter(
    (b) =>
      b.overlay?.status !== "withdrawn" &&
      b.overlay?.status !== "disqualified" &&
      !b.candidate.disqualified,
  );
  if (!active.length) return null;

  const top = active.slice(0, 6).map((b) => ({
    name: b.candidate.name ?? "Candidate",
    fit: b.score?.total ?? null,
    tier: tierKeyFromTotal(b.score?.total),
    stratum: b.ro?.current_capability ?? "—",
    trajectory: b.ro?.trajectory ?? "—",
    why: b.why ?? "",
  }));

  if (!hasAnthropic()) {
    const lead = top[0];
    return lead
      ? `${lead.name} leads the pool at ${lead.fit ?? "—"}. ${active.length} candidate${
          active.length === 1 ? "" : "s"
        } live; ${active.filter((b) => tierKeyFromTotal(b.score?.total) === "strong").length} clear the bar.`
      : null;
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const system = `You write the one-paragraph editorial read at the top of a hiring board for RDI Trials — the thing a founder reads in five seconds to know where the pipeline stands. Name the standout(s) and why, name the one real constraint, and where the next-best sits. Specific, plain, no hype, no lists. 2-4 sentences. Plain text only.`;
  const user = `SEAT: ${jobTitle ?? jobShortcode}
ACTIVE CANDIDATES: ${active.length}
TOP (by fit):
${top
    .map(
      (t) =>
        `- ${t.name} — fit ${t.fit ?? "—"} (${t.tier}), RO ${t.stratum} ${t.trajectory}. ${t.why}`,
    )
    .join("\n")}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    if (text) {
      await writeSyncState(key(jobShortcode), { text, at: new Date().toISOString() });
    }
    return text || null;
  } catch (error) {
    console.error("Board summary generation failed", error);
    return null;
  }
}
