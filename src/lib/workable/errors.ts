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
  return maybeStatus === 404;
}
