import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import { computeOverall, dimensionsFor } from "./scorecard";
import type { Pipeline, RadarContact, ScoreDimension } from "./types";

const MODEL = "claude-sonnet-4-6";

export interface ScoreResult {
  dimensions: ScoreDimension[];
  overall: number | null;
  recommendation: string;
  summary: string;
  strongestSignal: string;
  biggestConcern: string;
  nextAction: string;
  model: string;
}

function buildSystemPrompt(pipeline: Pipeline, scorecardMd: string): string {
  const defs = dimensionsFor(pipeline);
  const dimLines = defs
    .map((d) => `- "${d.key}" (${d.label})${d.isRisk ? " [RISK: higher = worse]" : ""}: ${d.basis}`)
    .join("\n");
  return `You are RDI's sourcing analyst. You score one person against RDI's private scorecard and produce a crisp recommendation. You are skeptical and evidence-based: titles and big-name employers are NOT evidence by themselves — weigh what the person actually did.

THE SCORECARD (grade strictly against this):
"""
${scorecardMd}
"""

SCORE EACH DIMENSION 1-5 (5 = strong evidence; 1 = no evidence or contrary). Use ONLY these dimension keys:
${dimLines}

For RISK dimensions, a HIGH score means MORE concern (it should pull the recommendation down), not a strength.

Return JSON only, no prose outside it, in exactly this shape:
{
  "dimensions": [{ "key": "<one of the keys above>", "score": <1-5 integer>, "rationale": "<one sentence grounded in the profile>" }],
  "recommendation": "<one short verdict label: Reach out now | Worth a look | Backup | Pass | Needs verification>",
  "summary": "<2-3 sentences: who they are and the decisive read>",
  "strongestSignal": "<the single strongest reason to pursue, one sentence>",
  "biggestConcern": "<the single biggest concern or unknown, one sentence>",
  "nextAction": "<concrete next step, e.g. 'Send intro email' | 'Verify IVD experience on a call' | 'Pass — too big-company'>"
}
Include EVERY dimension key listed above exactly once. Never invent facts not supported by the profile; when evidence is missing, score low and say so in the rationale.`;
}

function buildUserPrompt(contact: RadarContact): string {
  const fields = [
    `Name: ${contact.fullName ?? "—"}`,
    `Title: ${contact.title ?? "—"}`,
    `Company: ${contact.company ?? "—"}`,
    `Location: ${contact.location ?? "—"}`,
    `LinkedIn: ${contact.linkedinUrl ?? "—"}`,
    `Source: ${contact.source}`,
  ].join("\n");
  const summary = contact.profileSummary?.trim()
    ? `\n\nPROFILE SUMMARY / NOTES:\n"""\n${contact.profileSummary.trim().slice(0, 6000)}\n"""`
    : "";
  const raw = Object.keys(contact.raw ?? {}).length
    ? `\n\nRAW SOURCE FIELDS:\n${JSON.stringify(contact.raw).slice(0, 4000)}`
    : "";
  return `Score this person now.\n\n${fields}${summary}${raw}`;
}

/**
 * Score a contact with Claude. Resilient: returns null when no API key is set or
 * the call/parse fails, so the caller keeps any prior score and never crashes.
 */
export async function scoreContact(
  contact: RadarContact & { raw?: Record<string, unknown> },
  pipeline: Pipeline,
  scorecardMd: string,
): Promise<ScoreResult | null> {
  if (!hasAnthropic()) return null;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1800,
      system: [{ type: "text", text: buildSystemPrompt(pipeline, scorecardMd), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserPrompt(contact) }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] ?? "{}") as Record<string, unknown>;

    const defs = dimensionsFor(pipeline);
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const rawDims = Array.isArray(parsed.dimensions) ? (parsed.dimensions as Record<string, unknown>[]) : [];
    const seen = new Map<string, ScoreDimension>();
    for (const d of rawDims) {
      const key = String(d.key ?? "");
      const def = byKey.get(key);
      if (!def || seen.has(key)) continue;
      const score = Math.max(1, Math.min(5, Math.round(Number(d.score) || 1)));
      seen.set(key, { key, label: def.label, score, rationale: String(d.rationale ?? "").trim(), isRisk: def.isRisk });
    }
    // Ensure every dimension is present (default missing ones to a neutral low).
    const dimensions: ScoreDimension[] = defs.map(
      (def) => seen.get(def.key) ?? { key: def.key, label: def.label, score: def.isRisk ? 1 : 2, rationale: "No evidence in profile.", isRisk: def.isRisk },
    );

    const overall = computeOverall(dimensions.map((d) => ({ score: d.score, weight: byKey.get(d.key)?.weight ?? 0, isRisk: d.isRisk })));

    const str = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string).trim() : "");
    return {
      dimensions,
      overall,
      recommendation: str("recommendation") || "Worth a look",
      summary: str("summary"),
      strongestSignal: str("strongestSignal"),
      biggestConcern: str("biggestConcern"),
      nextAction: str("nextAction"),
      model: MODEL,
    };
  } catch (error) {
    console.error("Radar score failed", error);
    return null;
  }
}
