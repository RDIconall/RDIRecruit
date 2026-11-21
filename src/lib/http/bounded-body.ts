export type BoundedBody =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" };

/**
 * Reads a request body as UTF-8, refusing anything over `maxBytes`.
 *
 * Content-Length is only a fast path: a short or missing header does not let a
 * longer stream through, because the stream itself is counted and cancelled as
 * soon as it passes the limit.
 */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return { ok: true, text: Buffer.concat(chunks, total).toString("utf8") };
}
