// Stand-in for @anthropic-ai/sdk 0.54.0 (package-lock). The product constructs
// `new Anthropic({ apiKey })` and calls messages.batches.create / retrieve /
// results / cancel (src/lib/analysis/batch.ts). This records those calls and,
// once a test marks the batch ended, returns one succeeded message whose text
// is JSON parseEvaluatorMessage accepts (src/lib/scoring/evaluator.ts). It does
// not score the candidate; the app's own normalize and projection do that.
//
// Export shape matches index.js of that package: a CommonJS module with
// __esModule and default pointing at the constructor.

const batches = [];

// Category scores sum to 72 under the default legacy weights, with a stated
// salary and an OWNED answer, so decisionFor (src/lib/analysis/decision.ts)
// returns "interview". personQuality "high" and seat verdict "strong_seat"
// make fitReadFromEvaluation (src/lib/triage/fit-read.ts) sentiment "good".
const MODEL_JSON = JSON.stringify({
  categoryScores: {
    principal: 18,
    environment: 14,
    scope: 14,
    writing: 10,
    tenure: 8,
    local: 8,
  },
  personQuality: "high",
  seatFit: {
    appliedSeat: "Office Coordinator",
    verdict: "strong_seat",
    summary: "Fits the seat.",
  },
  integrityGate: { status: "clear", note: "" },
  otherGateResults: [],
  complement: "technician",
  summary: "Owned delivery against this seat.",
  confidence: "medium",
  salaryValue: "justified",
  salaryAsk: "$120k",
  answerGrades: [{ question: "Why this seat?", verdict: "OWNED", note: "Owned the example." }],
  triage: { why: "Async video shows owned delivery against this seat." },
  verification: { read: "Clean", claims: [], questions: [], actions: [] },
});

function resetAnthropic() {
  batches.length = 0;
}

function markBatchesEnded() {
  for (const batch of batches) batch.ended = true;
}

function graderPrompts() {
  const prompts = [];
  for (const batch of batches) {
    for (const request of batch.requests) {
      const content = request.params?.messages?.[0]?.content;
      prompts.push(typeof content === "string" ? content : JSON.stringify(content ?? ""));
    }
  }
  return prompts;
}

function batchCount() {
  return batches.length;
}

function messageFor(request) {
  return {
    content: [{ type: "text", text: MODEL_JSON }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 12,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    custom_id_echo: request.custom_id,
  };
}

function Anthropic(_options) {
  this.messages = {
    batches: {
      create: async ({ requests }) => {
        const id = `msgbatch_test_${batches.length + 1}`;
        const batch = {
          id,
          processing_status: "in_progress",
          request_counts: { processing: requests.length },
          created_at: new Date().toISOString(),
          expires_at: null,
          ended_at: null,
          requests,
          ended: false,
        };
        batches.push(batch);
        return batch;
      },
      retrieve: async (id) => {
        const batch = batches.find((item) => item.id === id);
        const ended = Boolean(batch?.ended);
        return {
          id,
          processing_status: ended ? "ended" : "in_progress",
          request_counts: batch?.request_counts ?? {},
          ended_at: ended ? new Date().toISOString() : null,
        };
      },
      results: async (id) => {
        const batch = batches.find((item) => item.id === id);
        return (batch?.requests ?? []).map((request) => ({
          custom_id: request.custom_id,
          result: {
            type: "succeeded",
            message: messageFor(request),
          },
        }));
      },
      cancel: async () => ({ id: "cancelled" }),
    },
    create: async () => {
      throw new Error("messages.create was not part of the webhook batch path");
    },
  };
}

module.exports = Anthropic;
module.exports.Anthropic = Anthropic;
module.exports.default = Anthropic;
module.exports.resetAnthropic = resetAnthropic;
module.exports.markBatchesEnded = markBatchesEnded;
module.exports.graderPrompts = graderPrompts;
module.exports.batchCount = batchCount;
Object.defineProperty(module.exports, "__esModule", { value: true });
