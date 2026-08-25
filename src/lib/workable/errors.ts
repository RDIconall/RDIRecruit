export class WorkableApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`Workable API error ${status} on ${path}: ${body}`);
    this.name = "WorkableApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export function isRetryableWorkableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isPermanentWorkableNotFound(error: unknown): boolean {
  if (error instanceof WorkableApiError) return error.status === 404;
  const maybeStatus = (error as { status?: unknown } | null)?.status;
  if (maybeStatus === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /not found/i.test(message);
}
