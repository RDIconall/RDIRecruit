/**
 * Size limits for the public ingest routes. A long interview (several hours of
 * speech) fits comfortably under the transcript cap; anything above it is
 * rejected before any event, evidence, or other write.
 */
export const MAX_TRANSCRIPT_CHARS = 200_000;

/**
 * Raw request body cap. Leaves room for a capped transcript in multi-byte UTF-8
 * plus JSON escaping and the surrounding metadata, and bounds every stored
 * webhook payload (the `events` queue keeps the whole body).
 */
export const MAX_INGEST_BODY_BYTES = 2 * 1024 * 1024;

export function transcriptTooLong(text: string | null | undefined): boolean {
  return typeof text === "string" && text.length > MAX_TRANSCRIPT_CHARS;
}

/**
 * Read the request body as text, refusing to buffer more than `maxBytes`.
 * Returns null when the body is larger than the cap, without reading the rest.
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number = MAX_INGEST_BODY_BYTES,
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
