import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../env";

/**
 * Fireflies transcript ingestion helpers.
 *
 * Two supported flows:
 *  1. The webhook payload already carries the transcript text (some Zapier/Make
 *     relays and custom posts do this) — we store it directly, no API key needed.
 *  2. The native Fireflies webhook only sends a `meetingId` / `transcriptId` and
 *     an event type. We then fetch the transcript over their GraphQL API using
 *     `FIREFLIES_API_KEY`. Without that key the fetch is skipped and the caller
 *     reports that credentials are required to go live.
 */

const FIREFLIES_GRAPHQL = "https://api.fireflies.ai/graphql";

export interface FirefliesTranscript {
  id: string | null;
  title: string | null;
  text: string;
  organizerEmail: string | null;
  participantEmails: string[];
}

/** Pull a transcript id out of the many shapes Fireflies/relays send. */
export function extractTranscriptId(payload: Record<string, unknown>): string | null {
  const p = payload as Record<string, unknown> & {
    meetingId?: string;
    transcriptId?: string;
    transcript_id?: string;
    data?: { meetingId?: string; transcriptId?: string; id?: string };
    transcript?: { id?: string };
  };
  return (
    p.transcriptId ??
    p.transcript_id ??
    p.meetingId ??
    p.data?.transcriptId ??
    p.data?.meetingId ??
    p.data?.id ??
    p.transcript?.id ??
    null
  );
}

/** Join Fireflies sentence objects (or a raw transcript string) into plain text. */
function sentencesToText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((s) => {
        if (typeof s === "string") return s;
        const row = s as { speaker_name?: string; text?: string };
        const speaker = row.speaker_name ? `${row.speaker_name}: ` : "";
        return row.text ? `${speaker}${row.text}` : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

/** If the webhook already embeds the transcript text, pull it out. */
export function extractInlineTranscript(
  payload: Record<string, unknown>,
): FirefliesTranscript | null {
  const p = payload as Record<string, unknown> & {
    title?: string;
    meeting_title?: string;
    transcript?: unknown;
    sentences?: unknown;
    text?: unknown;
    host_email?: string;
    organizer_email?: string;
    participants?: unknown;
    meeting_attendees?: Array<{ email?: string }>;
  };

  const text =
    sentencesToText(p.sentences) ||
    sentencesToText((p.transcript as { sentences?: unknown } | undefined)?.sentences) ||
    sentencesToText(p.transcript) ||
    sentencesToText(p.text);

  if (!text) return null;

  const participants = collectEmails(p.participants, p.meeting_attendees);
  return {
    id: extractTranscriptId(payload),
    title: p.meeting_title ?? p.title ?? null,
    text,
    organizerEmail: p.organizer_email ?? p.host_email ?? null,
    participantEmails: participants,
  };
}

function collectEmails(...sources: unknown[]): string[] {
  const out = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    if (Array.isArray(source)) {
      for (const entry of source) {
        if (typeof entry === "string" && entry.includes("@")) out.add(entry.toLowerCase());
        else if (entry && typeof entry === "object") {
          const email = (entry as { email?: string }).email;
          if (email) out.add(email.toLowerCase());
        }
      }
    } else if (typeof source === "string" && source.includes("@")) {
      out.add(source.toLowerCase());
    }
  }
  return [...out];
}

export function hasFirefliesApiKey(): boolean {
  return Boolean(env.FIREFLIES_API_KEY);
}

/**
 * True only when FIREFLIES_WEBHOOK_SECRET is set and `signature` is the hex
 * HMAC-SHA256 of the exact raw body under it. Fireflies sends it in
 * `x-hub-signature`; relays may use `x-fireflies-signature`. An optional
 * `sha256=` prefix is accepted.
 */
export function verifyFirefliesSignature(rawBody: string, signature: string | null): boolean {
  const secret = env.FIREFLIES_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const provided = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Escape a value for a PostgreSQL ILIKE so it matches only itself
 * (case-insensitively). Returns null for values containing `*`, which PostgREST
 * rewrites to `%` regardless of escaping.
 */
export function literalIlikePattern(value: string): string | null {
  if (value.includes("*")) return null;
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Fetch a full transcript from the Fireflies GraphQL API. Requires FIREFLIES_API_KEY. */
export async function fetchFirefliesTranscript(
  transcriptId: string,
): Promise<FirefliesTranscript | null> {
  if (!env.FIREFLIES_API_KEY) return null;

  const query = `
    query Transcript($id: String!) {
      transcript(id: $id) {
        id
        title
        organizer_email
        participants
        sentences { speaker_name text }
      }
    }
  `;

  const res = await fetch(FIREFLIES_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.FIREFLIES_API_KEY}`,
    },
    body: JSON.stringify({ query, variables: { id: transcriptId } }),
  });

  if (!res.ok) {
    throw new Error(`Fireflies API ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const json = (await res.json()) as {
    data?: {
      transcript?: {
        id?: string;
        title?: string;
        organizer_email?: string;
        participants?: string[];
        sentences?: Array<{ speaker_name?: string; text?: string }>;
      };
    };
    errors?: Array<{ message?: string }>;
  };

  if (json.errors?.length) {
    throw new Error(`Fireflies API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const t = json.data?.transcript;
  if (!t) return null;

  return {
    id: t.id ?? transcriptId,
    title: t.title ?? null,
    text: sentencesToText(t.sentences),
    organizerEmail: t.organizer_email ?? null,
    participantEmails: collectEmails(t.participants),
  };
}
