import { isPermanentWorkableNotFound } from "../workable/errors";

export const MAX_WORKABLE_EVENT_ATTEMPTS = 3;

export type EventFailureStatus = "retryable_failure" | "permanent_failure";

export function eventFailureStatus(error: unknown, attempts: number): EventFailureStatus {
  if (isPermanentWorkableNotFound(error)) return "permanent_failure";
  return attempts >= MAX_WORKABLE_EVENT_ATTEMPTS ? "permanent_failure" : "retryable_failure";
}

export function shouldRetryEvent(status: string | null | undefined, attempts: number): boolean {
  if (status === "permanent_failure" || status === "succeeded") return false;
  return attempts < MAX_WORKABLE_EVENT_ATTEMPTS;
}
