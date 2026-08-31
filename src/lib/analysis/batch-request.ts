import type Anthropic from "@anthropic-ai/sdk";
import { buildEvaluatorRequest, type EvaluatorInput } from "../scoring/evaluator";
import { shouldHardenBatchAttempt } from "./batch-policy";

export function batchRequestForAnalysis(row: {
  id: string;
  input_snapshot: EvaluatorInput;
  attempt_count: number;
}): Anthropic.Messages.BatchCreateParams.Request {
  return {
    custom_id: row.id,
    params: buildEvaluatorRequest(row.input_snapshot, shouldHardenBatchAttempt(row.attempt_count)),
  };
}

