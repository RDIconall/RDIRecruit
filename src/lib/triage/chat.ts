import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import type { ChatMessage } from "./types";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a senior recruiting partner inside RDI Trials' candidate-triage tool, talking live with the hiring team (e.g. Conall or Lara) about ONE specific candidate. You are sharp, candid, and genuinely useful — a thinking partner, not a cheerleader.

Ground every answer in the candidate's working file, the job rubric, the role spec, and any interview transcript provided below. Reason from ACTIONS and evidence, not adjectives. Separate what actually decides a call from what only looks like a red flag. Be willing to disagree with the human — then defer to their judgment.

Hard rules:
- NEVER produce a numeric score, percentage, points, grade, or tier. When you reference a call, speak only in the decision vocabulary: Interview first, Short screen, Verify first, Hold, Cut, Review blocked.
- Be specific when you cite the transcript or materials — quote or paraphrase the actual moment.
- Keep replies tight and conversational: a few short paragraphs at most, no bullet-point walls unless asked. This is a back-and-forth, not a report.
- If the materials don't support an answer, say so plainly rather than inventing detail.`;

function buildContextBlock(input: {
  candidateName?: string;
  workingFile: string;
  rubric?: string;
  jobSpec?: string;
}): string {
  const rubricBlock = (input.rubric || "").trim()
    ? `\n\nJOB RUBRIC (the bar this role is graded against):\n"""\n${input.rubric!.trim().slice(0, 7000)}\n"""`
    : "";
  const specBlock = (input.jobSpec || "").trim()
    ? `\n\nROLE SPEC (what this job actually is):\n"""\n${input.jobSpec!.trim().slice(0, 3000)}\n"""`
    : "";
  return `CANDIDATE WORKING FILE${input.candidateName ? ` — ${input.candidateName}` : ""} (.md — the living case file: decision read, timeline, transcript, rubric fit, corrections):
"""
${(input.workingFile || "(empty)").slice(0, 16000)}
"""${specBlock}${rubricBlock}`;
}

/** Ensure the message list the API sees starts on a user turn and alternates cleanly. */
function normalizeHistory(history: ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  const trimmed = [...history];
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  return trimmed
    .filter((m) => m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Continue the candidate "war room" conversation with Claude. Resilient: returns
 * null when no API key is configured or the call fails, so the caller can keep
 * the prior history and surface a friendly notice instead of crashing.
 */
export async function chatWithClaude(input: {
  candidateName?: string;
  workingFile: string;
  rubric?: string;
  jobSpec?: string;
  /** Full conversation so far, ending with the latest user message. */
  history: ChatMessage[];
}): Promise<string | null> {
  if (!hasAnthropic()) return null;

  const messages = normalizeHistory(input.history);
  if (!messages.length) return null;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        {
          type: "text",
          text: buildContextBlock(input),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return text || null;
  } catch (error) {
    console.error("Candidate chat failed", error);
    return null;
  }
}
