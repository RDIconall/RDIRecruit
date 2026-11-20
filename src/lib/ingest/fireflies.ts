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
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const email = value.trim().toLowerCase();
    if (email.includes("@")) out.add(email);
  };
  for (const source of sources) {
    if (!source) continue;
    if (Array.isArray(source)) {
      for (const entry of source) {
        if (typeof entry === "string") add(entry);
        else if (entry && typeof entry === "object") add((entry as { email?: unknown }).email);
      }
    } else {
      add(source);
    }
  }
  return [...out];
}

/**
 * Turn a participant address into an `ilike` pattern that only matches that exact
 * address (case-insensitively). `%`, `_` and `\` are escaped for Postgres LIKE.
 * PostgREST rewrites every `*` in a like/ilike value to `%` and offers no escape
 * for it, so an address containing `*` cannot be matched literally and yields null.
 */
export function exactEmailIlikePattern(email: string): string | null {
  if (!email || email.includes("*")) return null;
  return email.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function hasFirefliesApiKey(): boolean {
  return Boolean(env.FIREFLIES_API_KEY);
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
