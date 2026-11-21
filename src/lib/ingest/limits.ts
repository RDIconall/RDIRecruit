/**
 * Size limits for text that arrives from outside the app (webhooks, ingest
 * relays, pasted interviews). Every evidence transcript is stored at most
 * TRANSCRIPT_MAX_CHARS long, and raw payload copies kept for auditing are
 * bounded as a whole so one request can never park megabytes in a row.
 */

export const TRANSCRIPT_MAX_CHARS = 60_000;

/** What the triage inbox carries per interview; the full text loads on demand. */
export const INBOX_TRANSCRIPT_EXCERPT_CHARS = 2_000;

export const EVIDENCE_LABEL_MAX_CHARS = 200;

export const PAYLOAD_MAX_CHARS = 16_000;
export const PAYLOAD_STRING_MAX_CHARS = 2_000;

const PAYLOAD_MAX_DEPTH = 8;
const PAYLOAD_KEY_MAX_CHARS = 200;
const TRUNCATED = "…[truncated]";

export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - TRUNCATED.length)) + TRUNCATED;
}

export function capTranscript(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  return clipText(text, TRANSCRIPT_MAX_CHARS);
}

/**
 * Deep copy of a JSON value that spends at most `budget` characters on strings,
 * keys, and scalars, clips each string to `maxString`, and drops whatever is left
 * once the budget runs out.
 */
export function boundJson<T>(
  value: T,
  budget: number = PAYLOAD_MAX_CHARS,
  maxString: number = PAYLOAD_STRING_MAX_CHARS,
): T {
  let remaining = budget;

  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      const clipped = clipText(node, Math.max(0, Math.min(maxString, remaining)));
      remaining -= clipped.length;
      return clipped;
    }
    if (node === null || typeof node === "number" || typeof node === "boolean") {
      remaining -= 8;
      return node;
    }
    if (typeof node !== "object") return null;
    if (depth >= PAYLOAD_MAX_DEPTH) {
      remaining -= TRUNCATED.length;
      return TRUNCATED;
    }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) {
        if (remaining <= 0) {
          out.push(TRUNCATED);
          break;
        }
        out.push(walk(item, depth + 1));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [rawKey, item] of Object.entries(node as Record<string, unknown>)) {
      if (remaining <= 0) {
        out[TRUNCATED] = true;
        break;
      }
      const key = clipText(rawKey, PAYLOAD_KEY_MAX_CHARS);
      remaining -= key.length;
      out[key] = walk(item, depth + 1);
    }
    return out;
  };

  return walk(value, 0) as T;
}
