/** Default cap for public webhook/ingest bodies. Real provider events are a few KB. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 413; error: string };

const DIGITS = /^\d+$/;

/**
 * Reads a request body as UTF-8 text without ever buffering more than
 * `maxBytes`. A declared Content-Length over the cap is refused before any
 * body byte is pulled. Otherwise the stream is read chunk by chunk and
 * cancelled the moment it passes the declared length (or the cap).
 *
 * A body without Content-Length that reaches the cap is refused: proving it
 * ends exactly there would mean pulling another chunk past the cap.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<BodyReadResult> {
  const header = request.headers.get("content-length");
  let declared: number | null = null;
  if (header !== null) {
    const trimmed = header.trim();
    if (!DIGITS.test(trimmed)) {
      await discard(request);
      return { ok: false, status: 400, error: "Invalid Content-Length" };
    }
    declared = Number(trimmed);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      await discard(request);
      return { ok: false, status: 413, error: "Payload too large" };
    }
  }

  const body = request.body;
  if (!body) return { ok: true, text: "" };

  const limit = declared ?? maxBytes;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        tooLarge = true;
        break;
      }
      chunks.push(value);
    }
    if (declared === null && total >= maxBytes) tooLarge = true;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (tooLarge) return { ok: false, status: 413, error: "Payload too large" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

async function discard(request: Request): Promise<void> {
  if (request.body && !request.body.locked) {
    await request.body.cancel().catch(() => {});
  }
}
