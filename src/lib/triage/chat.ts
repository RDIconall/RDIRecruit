import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import type { ChatMessage } from "./types";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a senior recruiting partner inside RDI Trials' candidate-triage tool, talking live with the hiring team (e.g. Conall or Lara) about ONE specific candidate (the FOCUS candidate). You are sharp, candid, and genuinely useful — a thinking partner, not a cheerleader.

Ground every answer in the candidate's source materials (cover letter, application answers, résumé, interview transcripts), the working file, the job rubric, and the role spec provided below. The CANDIDATE MATERIALS block holds the verbatim source text — when asked about the cover letter, résumé, or an answer, read the actual text there before responding. Reason from ACTIONS and evidence, not adjectives. Separate what actually decides a call from what only looks like a red flag. Be willing to disagree with the human — then defer to their judgment.

Cross-candidate comparisons: the POOL ROSTER below lists every OTHER candidate in this job's pool (name, current role, and current decision). When the human asks you to compare the focus candidate against a specific other candidate — or asks why another candidate got their call — use the get_candidate_materials tool to pull that other candidate's full working file and verbatim materials before answering. Do NOT guess about another candidate from the roster line alone; retrieve their record first, then do an evidence-grounded side-by-side. Only candidates shown in the POOL ROSTER are available.

Hard rules:
- NEVER produce a numeric score, percentage, points, grade, or tier. When you reference a call, speak only in the decision vocabulary: Interview first, Short screen, Verify first, Hold, Cut, Review blocked.
- Be specific when you cite the transcript or materials — quote or paraphrase the actual moment.
- Keep replies tight and conversational: a few short paragraphs at most, no bullet-point walls unless asked. This is a back-and-forth, not a report.
- If the materials don't support an answer, say so plainly rather than inventing detail. If a requested candidate is not in the pool, say so rather than inventing their record.`;

/** Tool that lets Claude pull another pool candidate's full record on demand (RAG-like). */
const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_candidate_materials",
    description:
      "Fetch the full working file (decision read, timeline, rubric fit, corrections) and verbatim source materials (cover letter, application answers, résumé text, interview transcripts) for ANOTHER candidate in this job's pool, so you can compare them against the focus candidate. Pass the other candidate's full name or id exactly as it appears in the POOL ROSTER. Only candidates listed in the POOL ROSTER can be retrieved.",
    input_schema: {
      type: "object",
      properties: {
        candidate: {
          type: "string",
          description: "The other candidate's full name or id, exactly as shown in the POOL ROSTER.",
        },
      },
      required: ["candidate"],
    },
  },
];

const MAX_TOOL_ROUNDS = 4;
const FETCHED_MATERIALS_CAP = 30000;

function buildContextBlock(input: {
  candidateName?: string;
  workingFile: string;
  materials?: string;
  rubric?: string;
  jobSpec?: string;
  roster?: string;
}): string {
  const materialsBlock = (input.materials || "").trim()
    ? `\n\nCANDIDATE MATERIALS (verbatim source text — cover letter, application answers, résumé, interview transcripts):\n"""\n${input.materials!.trim().slice(0, 40000)}\n"""`
    : "";
  const rubricBlock = (input.rubric || "").trim()
    ? `\n\nJOB RUBRIC (the bar this role is graded against):\n"""\n${input.rubric!.trim().slice(0, 7000)}\n"""`
    : "";
  const specBlock = (input.jobSpec || "").trim()
    ? `\n\nROLE SPEC (what this job actually is):\n"""\n${input.jobSpec!.trim().slice(0, 3000)}\n"""`
    : "";
  const rosterBlock = (input.roster || "").trim()
    ? `\n\nPOOL ROSTER (the OTHER candidates in this job's pool — use the get_candidate_materials tool to pull any of their full records before comparing):\n"""\n${input.roster!.trim().slice(0, 12000)}\n"""`
    : "";
  return `FOCUS CANDIDATE WORKING FILE${input.candidateName ? ` — ${input.candidateName}` : ""} (.md — the living case file: decision read, timeline, transcript, rubric fit, corrections):
"""
${(input.workingFile || "(empty)").slice(0, 16000)}
"""${materialsBlock}${specBlock}${rubricBlock}${rosterBlock}`;
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
  /** Verbatim source materials (cover letter, answers, résumé, transcripts). */
  materials?: string;
  rubric?: string;
  jobSpec?: string;
  /** Compact one-line-per-candidate roster of the OTHER candidates in the pool. */
  roster?: string;
  /**
   * Resolve another pool candidate's full record by name or id (server-side,
   * scoped to the same pool). When provided, Claude is given a tool to pull other
   * candidates on demand so it can do evidence-grounded side-by-side comparisons.
   */
  fetchOtherCandidate?: (query: string) => Promise<{ name: string; content: string } | null>;
  /** Full conversation so far, ending with the latest user message. */
  history: ChatMessage[];
}): Promise<string | null> {
  if (!hasAnthropic()) return null;

  const messages: Anthropic.MessageParam[] = normalizeHistory(input.history);
  if (!messages.length) return null;

  const canRetrieve = Boolean(input.fetchOtherCandidate && (input.roster || "").trim());

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: SYSTEM_PROMPT },
      {
        type: "text",
        text: buildContextBlock(input),
        cache_control: { type: "ephemeral" },
      },
    ];

    let lastText = "";
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system,
        messages,
        ...(canRetrieve ? { tools: TOOLS } : {}),
      });

      lastText =
        response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim() || lastText;

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // No tool call (or we've exhausted the retrieval budget) → final answer.
      if (response.stop_reason !== "tool_use" || !toolUses.length || !canRetrieve || round === MAX_TOOL_ROUNDS) {
        return lastText || null;
      }

      // Replay the assistant's tool-use turn, then feed back each requested record.
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const query =
          tu.name === "get_candidate_materials" && tu.input && typeof tu.input === "object"
            ? String((tu.input as { candidate?: unknown }).candidate ?? "").trim()
            : "";
        let content: string;
        if (!query) {
          content = "No candidate name or id was provided.";
        } else {
          const fetched = await input.fetchOtherCandidate!(query);
          content = fetched
            ? `Record for ${fetched.name} (another candidate in this pool):\n\n${fetched.content.slice(0, FETCHED_MATERIALS_CAP)}`
            : `No candidate matching "${query}" is in this job's pool. Only candidates listed in the POOL ROSTER can be retrieved.`;
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content });
      }
      messages.push({ role: "user", content: results });
    }

    return lastText || null;
  } catch (error) {
    console.error("Candidate chat failed", error);
    return null;
  }
}
