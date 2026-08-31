import { estimateCostUsd, type ClaudeUsage } from "./models";

/**
 * One JSON line per Claude call, so Claude spend is greppable in Vercel logs
 * (`scope":"claude"`) instead of only visible as a monthly total in the Anthropic
 * console. `cacheRead` vs `fresh` is the number that matters most: a prompt-cache
 * change that silently stops hitting shows up here as fresh input tokens.
 *
 * Deliberately tiny and dependency-free, mirroring gradeLog.
 */
export function logClaudeUsage(
  site: string,
  model: string,
  usage: ClaudeUsage | null | undefined,
  fields: Record<string, unknown> = {},
): void {
  try {
    console.log(
      JSON.stringify({
        scope: "claude",
        site,
        model,
        at: new Date().toISOString(),
        fresh: usage?.input_tokens ?? 0,
        cacheWrite: usage?.cache_creation_input_tokens ?? 0,
        cacheRead: usage?.cache_read_input_tokens ?? 0,
        output: usage?.output_tokens ?? 0,
        usd: estimateCostUsd(model, usage),
        ...fields,
      }),
    );
  } catch {
    console.log(`[claude] ${site} ${model}`);
  }
}
