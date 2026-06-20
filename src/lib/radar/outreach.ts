import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic, publicBaseUrl } from "../env";
import type { OutreachDraft, Pipeline, RadarContact } from "./types";

const MODEL = "claude-sonnet-4-6";

function pitch(pipeline: Pipeline): string {
  if (pipeline === "bd") {
    return `RDI provides clinical trial + lab services to IVD/diagnostics sponsors. This is a business-development outreach: open a conversation about how RDI could support their clinical/lab needs. Be consultative, not salesy.`;
  }
  return `RDI is hiring a Clinical Operations Lead / Study Control Lead — a hands-on role running clinical execution at a small, fast-moving IVD/diagnostics sponsor. This is a recruiting outreach: gauge interest and invite a low-pressure conversation. Be specific about why THEY fit; do not over-promise.`;
}

function buildSystemPrompt(pipeline: Pipeline, senderName: string): string {
  return `You write short, personalized, high-reply-rate outreach for RDI. ${pitch(pipeline)}

Rules:
- Personalize from the person's real title/company/background — reference something specific, never generic flattery.
- Email: a tight subject (<= 7 words) and a 60-110 word body. Plain, human, direct. One clear ask (a brief call). No buzzword soup, no "I hope this finds you well", no fake urgency.
- LinkedIn message: <= 300 characters, even more casual, one specific hook + soft ask.
- Sign as ${senderName} from RDI.
- Do NOT include an unsubscribe line — it is appended automatically.

Return JSON only:
{ "emailSubject": "...", "emailBody": "...", "linkedinMessage": "..." }`;
}

function buildUserPrompt(contact: RadarContact): string {
  const lines = [
    `Name: ${contact.fullName ?? "—"}`,
    `Title: ${contact.title ?? "—"}`,
    `Company: ${contact.company ?? "—"}`,
    `Location: ${contact.location ?? "—"}`,
  ];
  if (contact.profileSummary) lines.push(`Background: ${contact.profileSummary.slice(0, 1500)}`);
  if (contact.score?.summary) lines.push(`Our read: ${contact.score.summary}`);
  if (contact.score?.strongestSignal) lines.push(`Strongest signal: ${contact.score.strongestSignal}`);
  return `Draft outreach for:\n${lines.join("\n")}`;
}

/** Builds the CAN-SPAM-style opt-out footer appended to outbound email bodies. */
export function unsubscribeFooter(token: string): string {
  const url = `${publicBaseUrl()}/api/radar/unsubscribe?token=${token}`;
  return `\n\n—\nRDI Trials · If you'd prefer not to hear from us, opt out here: ${url}`;
}

/**
 * Draft email + LinkedIn outreach with Claude. Resilient: returns null when no
 * API key is set or the call/parse fails.
 */
export async function draftOutreach(
  contact: RadarContact,
  pipeline: Pipeline,
  senderName: string,
): Promise<OutreachDraft | null> {
  if (!hasAnthropic()) return null;
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: [{ type: "text", text: buildSystemPrompt(pipeline, senderName), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserPrompt(contact) }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] ?? "{}") as Partial<OutreachDraft>;
    return {
      emailSubject: (parsed.emailSubject ?? "").trim() || `RDI — quick note for ${contact.firstName ?? "you"}`,
      emailBody: (parsed.emailBody ?? "").trim(),
      linkedinMessage: (parsed.linkedinMessage ?? "").trim(),
    };
  } catch (error) {
    console.error("Radar outreach draft failed", error);
    return null;
  }
}
