import { createHmac } from "node:crypto";

/**
 * Spec for the ingest cap. A normal interview fits. Anything longer is rejected
 * before events, evidence, or any other write.
 */
export const MAX_TRANSCRIPT_CHARS = 200_000;

/** Placeholder signing secret. Not a credential. */
export const TEST_WEBHOOK_SECRET = "test-fireflies-webhook-secret";

export const TRANSCRIPT_MARKER = "ZZZ_TRANSCRIPT_BODY_MARKER";

export function overLimitTranscript() {
  return `${TRANSCRIPT_MARKER}_${"A".repeat(MAX_TRANSCRIPT_CHARS)}`;
}

export function hubSignature(rawBody, secret = TEST_WEBHOOK_SECRET) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function evidenceSelectLeaksTranscript(columns) {
  const raw = String(columns).trim();
  if (raw === "*") return true;
  return raw.split(",").some((part) => {
    const name = part.trim().split(".").pop()?.replace(/"/g, "") ?? "";
    return name === "*" || name === "transcript" || name === "extracted";
  });
}
