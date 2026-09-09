import type { Decision } from "./types";

const MODEL = "claude-sonnet-4-6";

export type FitSentiment = "good" | "neutral" | "negative";

export interface FitRead {
  reply: string;
  sentiment: FitSentiment;
  appliedFit: string;
  rdiFit: string;
  suggestedSeat: string;
}

export function parseFitRead(raw: unknown): FitRead | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sentiment = String(o.sentiment ?? "").toLowerCase();
  if (sentiment !== "good" && sentiment !== "neutral" && sentiment !== "negative") return null;
  const reply = String(o.reply ?? "").trim();
  if (!reply) return null;
  return {
    reply,
    sentiment,
    appliedFit: String(o.appliedFit ?? "").trim(),
    rdiFit: String(o.rdiFit ?? "").trim(),
    suggestedSeat: String(o.suggestedSeat ?? "").trim(),
  };
}

export function decisionFromSentiment(sentiment: FitSentiment): Decision {
  if (sentiment === "good") return "interview";
  if (sentiment === "negative") return "reject";
  return "backup";
}

/** Project a list-facing fit read from the canonical analysis without a second Claude call. */
export function fitReadFromCanonical(parts: {
  why: string;
  personQuality?: string | null;
  seatVerdict?: string | null;
  appliedFit?: string | null;
  rdiFit?: string | null;
  suggestedSeat?: string | null;
}): FitRead | null {
  const reply = (parts.why ?? "").trim();
  if (!reply) return null;
  const pq = (parts.personQuality ?? "").toLowerCase();
  const v = (parts.seatVerdict ?? "").toLowerCase();
  let sentiment: FitSentiment = "neutral";
  if (pq === "weak" || pq === "blocked" || v === "pass" || v === "wrong_seat") {
    sentiment = "negative";
  } else if (v === "strong_seat") {
    sentiment = "good";
  } else if (v === "viable_seat" && pq !== "promising") {
    sentiment = "good";
  } else if (v === "routing" && (pq === "high" || pq === "solid")) {
    sentiment = "good";
  }
  return {
    reply,
    sentiment,
    appliedFit: (parts.appliedFit ?? "").trim(),
    rdiFit: (parts.rdiFit ?? "").trim(),
    suggestedSeat: (parts.suggestedSeat ?? "").trim(),
  };
}

const SYSTEM = `You are reading one job applicant for RDI Trials (a diagnostics CRO). Conall and Lara are hiring complements — people who take work or risk off their plate — not replacements.

You will get the job description and everything the candidate submitted. Write a free hiring read. Do NOT assign points, percentages, bands, or a numeric score.

Return JSON only:
{
  "reply": "3-8 sentences. What they have actually done, what is unproven, whether you would spend time on them. Cite actions from the materials.",
  "sentiment": "good" | "neutral" | "negative",
  "appliedFit": "2-4 sentences: fit to THIS posting specifically.",
  "rdiFit": "2-4 sentences: would we want this person at RDI somewhere — judgment, ownership, integrity, load they could take off Conall/Lara.",
  "suggestedSeat": "If this posting is wrong or generic, the real RDI seat they fit — or empty string."
}

sentiment:
- good — you would want them in the building, on this seat or another real one
- neutral — competent or unfinished; not who you book first
- negative — do not pursue (integrity, no substance, clear mismatch)

Job-relevant evidence only. Never infer protected attributes. Integrity problems are negative regardless of polish.`;

export async function generateFitRead(input: {
  name: string;
  jobTitle: string;
  jobSpec: string;
  resumeText: string;
  answers: Record<string, string>;
  coverLetter: string | null;
  methodology?: string;
}): Promise<FitRead | null> {
  const { env, hasAnthropic } = await import("../env");
  if (!hasAnthropic()) return null;

  const answers = Object.entries(input.answers)
    .map(([q, a]) => `Q: ${q}\nA: ${a}`)
    .join("\n\n");

  const user = `CANDIDATE: ${input.name}
POSTING: ${input.jobTitle}

JOB DESCRIPTION:
"""
${(input.jobSpec || "").trim().slice(0, 8000) || "(no posting body)"}
"""

RÉSUMÉ:
"""
${(input.resumeText || "").trim().slice(0, 14000) || "(none)"}
"""

APPLICATION ANSWERS:
"""
${answers.slice(0, 8000) || "(none)"}
"""

COVER LETTER:
"""
${(input.coverLetter || "").trim().slice(0, 3000) || "(none)"}
"""
${input.methodology?.trim() ? `\nHOW WE THINK ABOUT PEOPLE (context, not a scoring rubric):\n"""\n${input.methodology.trim().slice(0, 4000)}\n"""` : ""}`;

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1800,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return parseFitRead(JSON.parse(match[0]));
  } catch {
    return null;
  }
}

export async function loadLatestFitRead(candidateId: string): Promise<FitRead | null> {
  const { hasSupabase } = await import("../env");
  if (!hasSupabase()) return null;
  const { getServiceSupabase } = await import("../supabase/server");
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("evaluations")
    .select("payload")
    .eq("candidate_id", candidateId)
    .eq("kind", "fit_read")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return parseFitRead(data?.payload);
}

export async function storeFitRead(candidateId: string, jobShortcode: string | null, read: FitRead) {
  const { hasSupabase } = await import("../env");
  if (!hasSupabase()) return;
  const { getServiceSupabase } = await import("../supabase/server");
  const supabase = getServiceSupabase();
  await supabase.from("evaluations").delete().eq("candidate_id", candidateId).eq("kind", "fit_read");
  await supabase.from("evaluations").insert({
    candidate_id: candidateId,
    kind: "fit_read",
    ref: jobShortcode,
    payload: read,
  });
}
