import { env } from "../env";

/**
 * Every Claude model choice in the app resolves here, so a price or quality
 * change is one edit instead of a grep across ten call sites.
 *
 * The calls split into two tiers because they are not the same kind of work:
 *
 * - `judgment` — the reads a senior operator would otherwise do by hand: the
 *   candidate evaluation, the triage decision read, the live candidate chat, the
 *   sourcing score. The quality of these reads IS the product, so they run on the
 *   strongest general model we're willing to pay for.
 * - `extraction` — mechanical structure-from-text work such as distilling one
 *   reviewer note into one durable calibration rule. There is no hiring judgment
 *   in these calls; they are half the price on Haiku and fast.
 *
 * Both are overridable per deploy (CLAUDE_MODEL_JUDGMENT / CLAUDE_MODEL_EXTRACTION)
 * so a model can be pinned or rolled back without shipping a release.
 */
export const CLAUDE_JUDGMENT_MODEL = env.CLAUDE_MODEL_JUDGMENT ?? "claude-sonnet-5";
export const CLAUDE_EXTRACTION_MODEL = env.CLAUDE_MODEL_EXTRACTION ?? "claude-haiku-4-5";

/**
 * Published per-million-token rates for the models above, used only to turn the
 * `usage` block Anthropic returns into a dollar figure in our own logs. Keep in
 * step with https://platform.claude.com/docs/en/about-claude/pricing — a stale
 * entry costs nothing but makes the logged spend wrong.
 *
 * Cache writes bill at 1.25x base input (5-minute TTL) and cache reads at 0.1x.
 */
interface ModelRate {
  input: number;
  output: number;
}

const RATES_PER_MTOK: Record<string, ModelRate> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-opus-5": { input: 5, output: 25 },
  // Legacy generation — still priced here so a pinned rollback logs real dollars.
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface ClaudeUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Dollar cost of one call from the `usage` block on the response. Returns null for
 * a model we have no rate for, so an unpriced model logs tokens without inventing
 * a number.
 */
export function estimateCostUsd(model: string, usage: ClaudeUsage | null | undefined): number | null {
  const rate = RATES_PER_MTOK[model];
  if (!rate || !usage) return null;
  const fresh = usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const dollars =
    (fresh * rate.input +
      cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER +
      cacheRead * rate.input * CACHE_READ_MULTIPLIER +
      output * rate.output) /
    1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
