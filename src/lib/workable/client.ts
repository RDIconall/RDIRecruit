import { getWorkableToken, env } from "../env";

import { createHmac, timingSafeEqual } from "crypto";

const BASE_URL = () =>
  `https://${env.WORKABLE_SUBDOMAIN}.workable.com/spi/v3`;

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getWorkableToken()}`,
    "Content-Type": "application/json",
  };
}

// Workable enforces ~10 req/s per token and returns 429 when exceeded. 5xx are
// transient. We retry both, bounded, honouring rate-limit headers when present.
const MAX_RETRIES = 5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the server-advised wait from a throttled/erroring response. Workable does
 * not consistently document `Retry-After`, so we also accept `X-Rate-Limit-Reset`
 * (epoch seconds) and tolerate either a delta-seconds or HTTP-date `Retry-After`.
 */
function retryAfterMs(res: Response): number | null {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  const reset = res.headers.get("x-rate-limit-reset");
  if (reset) {
    const resetSec = Number(reset);
    if (Number.isFinite(resetSec)) {
      const ms = resetSec * 1000 - Date.now();
      if (ms > 0) return ms;
    }
  }
  return null;
}

/** Exponential backoff (base 500ms, capped 20s) with full jitter. */
function backoffMs(attempt: number): number {
  const ceil = Math.min(20_000, 500 * 2 ** attempt);
  return Math.round(ceil / 2 + Math.random() * (ceil / 2));
}

export async function workableFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  // `paging.next` returns a fully-qualified URL — follow it verbatim rather than
  // re-prefixing the base, while relative paths keep the subdomain base URL.
  const url = path.startsWith("http") ? path : `${BASE_URL()}${path}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          ...headers(),
          ...(options.headers as Record<string, string> | undefined),
        },
      });
    } catch (networkError) {
      // Transient network/DNS blips: back off and retry, then surface the error.
      lastError =
        networkError instanceof Error ? networkError : new Error(String(networkError));
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    // 429 (rate limit) and 5xx (transient) are retryable. Don't read the body
    // before deciding — `continue` discards the response and retries cleanly.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const waitMs = retryAfterMs(res) ?? backoffMs(attempt);
      console.warn(
        `workable.fetch.retry: ${res.status} on ${path} — attempt ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`,
      );
      await sleep(waitMs);
      continue;
    }

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Workable API error ${res.status} on ${path}: ${body}`);
    }
    // Action endpoints (move/disqualify/revert/comments) return 200/202 with an
    // empty or `text/plain` body. Don't blow up trying to JSON-parse a non-JSON
    // success body — return undefined for empty, parsed JSON when possible, else
    // the raw text.
    if (!body) return undefined as T;
    try {
      return JSON.parse(body) as T;
    } catch {
      return body as unknown as T;
    }
  }

  throw lastError ?? new Error(`Workable API error on ${path}: retries exhausted`);
}

/**
 * Follow Workable's documented `paging.next` cursor (a fully-qualified URL) until
 * exhausted, collecting every item under `key`. Robust across list endpoints and
 * avoids the boundary-duplicate bug of hand-built `since_id` (which is inclusive).
 * Bounded page count is a safety valve against an unexpected cursor loop.
 * https://workable.readme.io/reference/job-candidates-index (paging.next)
 */
type PagedResponse = Record<string, unknown> & { paging?: { next?: string | null } };

async function fetchAllPages<T>(firstPath: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = firstPath;
  for (let page = 0; next && page < 500; page += 1) {
    const data: PagedResponse = await workableFetch<PagedResponse>(next);
    const items = (data[key] as T[] | undefined) ?? [];
    out.push(...items);
    next = data.paging?.next ?? null;
  }
  return out;
}

export interface WorkableJob {
  id: string;
  title: string;
  shortcode: string;
  state: string;
  department: string;
  url: string;
  application_url: string;
  shortlink: string;
  location: { location_str: string };
  created_at: string;
  updated_at: string;
  /**
   * The full posting body (intro + description + requirements + benefits) as a
   * single HTML blob. Only the single-job endpoint (`GET /jobs/{shortcode}`)
   * returns it — the list endpoint omits it entirely.
   */
  full_description?: string;
  description?: string;
  requirements?: string;
}

export interface WorkableCandidate {
  id: string;
  name: string;
  firstname: string;
  lastname: string;
  headline: string;
  account: { subdomain: string; name: string };
  job: { shortcode: string; title: string };
  stage: string;
  disqualified: boolean;
  disqualification_reason: string | null;
  hired_at: string | null;
  sourced: boolean;
  profile_url: string;
  /**
   * Candidate's profile photo URL. ONLY the single-candidate endpoint
   * (GET /jobs/{shortcode}/candidates/{id}) returns it — the LIST endpoint omits
   * it entirely, so the bulk mirror never carries a photo.
   */
  image_url?: string | null;
  address: string;
  phone: string;
  email: string;
  created_at: string;
  updated_at: string;
  resume_url?: string;
  cover_letter?: string;
  cover_letter_url?: string;
  tags?: string[];
  skills?: Array<{ name: string }>;
  education_entries?: Array<{
    school: string;
    degree: string;
    field_of_study: string;
    start_date: string;
    end_date: string;
  }>;
  experience_entries?: Array<{
    title: string;
    company: string;
    industry: string;
    start_date: string;
    end_date: string;
    summary: string;
    current?: boolean;
  }>;
  answers?: Array<{ question: { body: string }; answer: { body: string } }>;
}

export async function listJobs(params?: {
  state?: string;
  limit?: number;
}): Promise<WorkableJob[]> {
  // `limit` is the per-page size; `paging.next` is followed to return every job
  // (the list previously capped silently at one page of 100).
  const query = new URLSearchParams();
  if (params?.state) query.set("state", params.state);
  query.set("limit", String(params?.limit ?? 100));
  return fetchAllPages<WorkableJob>(`/jobs?${query}`, "jobs");
}

export async function getJob(shortcode: string): Promise<WorkableJob> {
  // Workable's SPI v3 single-job endpoint returns the job object at the TOP LEVEL
  // (id, title, full_description, …) — unlike the list endpoint (`{ jobs: [...] }`)
  // and the single-candidate endpoint (`{ candidate: {...} }`). Reading `data.job`
  // therefore yielded `undefined`, so `full_description` was silently dropped and
  // every job spec resolved empty (blocking grading). Accept either shape.
  const data = await workableFetch<{ job?: WorkableJob } & Partial<WorkableJob>>(
    `/jobs/${shortcode}`,
  );
  return (data.job ?? (data as WorkableJob));
}

export async function listCandidates(
  shortcode: string,
  params?: { stage?: string; limit?: number; since_id?: string; updated_after?: string },
): Promise<WorkableCandidate[]> {
  const query = new URLSearchParams();
  if (params?.stage) query.set("stage", params.stage);
  if (params?.limit) query.set("limit", String(params.limit ?? 100));
  if (params?.since_id) query.set("since_id", params.since_id);
  if (params?.updated_after) query.set("updated_after", params.updated_after);
  const qs = query.toString() ? `?${query}` : "";
  const data = await workableFetch<{ candidates: WorkableCandidate[] }>(
    `/jobs/${shortcode}/candidates${qs}`,
  );
  return data.candidates;
}

export async function getCandidate(
  shortcode: string,
  id: string,
): Promise<WorkableCandidate> {
  const data = await workableFetch<{ candidate: WorkableCandidate }>(
    `/jobs/${shortcode}/candidates/${id}`,
  );
  return data.candidate;
}

/**
 * Fetch a candidate via the account-level endpoint (no job shortcode needed).
 * Used before a tags PUT to read-modify-write the current tag set. Accepts the
 * `{ candidate: {...} }` envelope or a top-level object defensively.
 * https://workable.readme.io/reference/update-candidate (GET /candidates/:id)
 */
export async function getCandidateById(id: string): Promise<WorkableCandidate> {
  const data = await workableFetch<
    { candidate?: WorkableCandidate } & Partial<WorkableCandidate>
  >(`/candidates/${id}`);
  return data.candidate ?? (data as WorkableCandidate);
}

/**
 * Fetch every candidate for a job, following the documented `paging.next` cursor.
 * Replaces the prior hand-built `since_id` loop, whose boundary was inclusive
 * (`>=`) and therefore re-fetched the last row of each page as the first of the
 * next. https://workable.readme.io/reference/job-candidates-index
 */
export async function listAllCandidates(
  shortcode: string,
  params?: { updatedAfter?: string | null },
): Promise<WorkableCandidate[]> {
  const query = new URLSearchParams();
  query.set("limit", "100");
  if (params?.updatedAfter) query.set("updated_after", params.updatedAfter);
  return fetchAllPages<WorkableCandidate>(
    `/jobs/${shortcode}/candidates?${query}`,
    "candidates",
  );
}

export interface WorkableActivity {
  id: string;
  action: string;
  body?: string;
  created_at?: string;
  comment?: { body?: string };
  member?: { name?: string };
  actor?: { name?: string };
}

/**
 * Fetch a candidate's activity stream. We intentionally do NOT pass an `actions`
 * filter and rely on client-side filtering instead: the action enum is not
 * reliably documented, so an unknown value risks either an error or a silently
 * unfiltered response. Callers should filter on the `action` field they receive.
 * https://workable.readme.io/reference/candidate-activities
 */
export async function listCandidateActivities(
  candidateId: string,
  params?: { limit?: number },
): Promise<WorkableActivity[]> {
  const query = new URLSearchParams();
  query.set("limit", String(params?.limit ?? 50));
  const data = await workableFetch<{ activities: WorkableActivity[] }>(
    `/candidates/${candidateId}/activities?${query}`,
  );
  return data.activities ?? [];
}

export interface WorkableMember {
  id: string;
  name: string;
  email?: string;
  role?: string;
}

/**
 * List account members so the operator can discover their member id. Exposed for
 * a one-off lookup (e.g. a script) — do NOT call this on the write hot path; the
 * member id comes from WORKABLE_MEMBER_ID. https://workable.readme.io/reference/members
 */
export async function listMembers(): Promise<WorkableMember[]> {
  return fetchAllPages<WorkableMember>(`/members`, "members");
}

export interface WorkableDisqualificationReason {
  id: string;
  name?: string;
}

/**
 * List the account's disqualification reasons so the operator can map a reason to
 * an id for `disqualify_reason_id`. Not used on the hot path.
 * https://workable.readme.io/reference/disqualification_reasons
 */
export async function listDisqualificationReasons(): Promise<WorkableDisqualificationReason[]> {
  const data = await workableFetch<{
    disqualification_reasons?: WorkableDisqualificationReason[];
    reasons?: WorkableDisqualificationReason[];
  }>(`/disqualification_reasons`);
  return data.disqualification_reasons ?? data.reasons ?? [];
}

/**
 * The member id credited with candidate write actions (move/disqualify/revert/
 * comment). Required by the SPI v3 action endpoints. Sourced ONLY from the env —
 * we never call GET /members on the write hot path. Returns null when unset.
 */
export function getWorkableMemberId(): string | null {
  return env.WORKABLE_MEMBER_ID ?? null;
}

/** Sentinel returned (instead of throwing) when a write can't run safely. */
export interface WorkableWriteSkipped {
  skipped: true;
  reason: string;
}

export type WorkableWriteResult = WorkableWriteSkipped | void;

function skipWrite(action: string): WorkableWriteSkipped {
  // Structured, greppable warning so the operator can see exactly why a Workable
  // write was a no-op without it ever surfacing as a 500 in the triage UI.
  console.warn(
    `workable.write.skipped: WORKABLE_MEMBER_ID not configured (action=${action})`,
  );
  return { skipped: true, reason: "WORKABLE_MEMBER_ID not configured" };
}

/**
 * Move a candidate to a stage. SPI v3: `POST /candidates/{id}/move` with a FLAT
 * body `{ member_id, target_stage }`, returning 202 with an empty body (the prior
 * job-scoped PATCH + nested `{candidate:{stage}}` body was not a real endpoint).
 * Skips gracefully when no member id is configured. https://workable.readme.io/reference/move-candidate
 */
export async function moveCandidateStage(
  candidateId: string,
  targetStage: string,
): Promise<WorkableWriteResult> {
  const memberId = getWorkableMemberId();
  if (!memberId) return skipWrite("move");
  await workableFetch<unknown>(`/candidates/${candidateId}/move`, {
    method: "POST",
    body: JSON.stringify({ member_id: memberId, target_stage: targetStage }),
  });
}

/**
 * Add a comment to a candidate's timeline. SPI v3: `POST /candidates/{id}/comments`
 * with `{ member_id, comment: { body } }`, returning 201 with an empty body (the
 * prior job-scoped `/activities` POST with `{activity:{action:"note"}}` was wrong).
 * Skips gracefully when no member id is configured. https://workable.readme.io/reference/comment-on-candidate
 */
export async function addCandidateNote(
  candidateId: string,
  body: string,
): Promise<WorkableWriteResult> {
  const memberId = getWorkableMemberId();
  if (!memberId) return skipWrite("comment");
  await workableFetch<unknown>(`/candidates/${candidateId}/comments`, {
    method: "POST",
    body: JSON.stringify({ member_id: memberId, comment: { body } }),
  });
}

/**
 * Replace a candidate's tags. SPI v3: `PUT /candidates/{id}/tags` with a FLAT
 * body `{ tags }` — but PUT REPLACES the entire tag set, so we first GET the
 * candidate's current tags and union them in to avoid wiping existing tags.
 * No member id required. https://workable.readme.io/reference/tag-candidate
 */
export async function addCandidateTags(
  candidateId: string,
  tags: string[],
): Promise<void> {
  let existing: string[] = [];
  try {
    const current = await getCandidateById(candidateId);
    existing = current.tags ?? [];
  } catch (error) {
    // If we can't read current tags, fall back to adding only the new ones rather
    // than failing the action; better to risk a missing tag than wipe the set.
    console.warn(
      `workable.tags: could not read current tags for ${candidateId}; merging new tags only`,
      error,
    );
  }
  const merged = Array.from(new Set([...existing, ...tags]));
  await workableFetch<unknown>(`/candidates/${candidateId}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: merged }),
  });
}

/**
 * Disqualify a candidate in Workable. SPI v3: `POST /candidates/{id}/disqualify`
 * (account-level, NOT `/jobs/{shortcode}/...`) with a required `member_id`.
 * `disqualify_note` is the current field (max 256 chars); `disqualification_reason`
 * is deprecated. Returns 200 with an empty/plain-text body. Skips gracefully when
 * no member id is configured. https://workable.readme.io/reference/disqualify-candidate
 */
export async function disqualifyCandidate(
  candidateId: string,
  reason?: string,
): Promise<WorkableWriteResult> {
  const memberId = getWorkableMemberId();
  if (!memberId) return skipWrite("disqualify");
  await workableFetch<unknown>(`/candidates/${candidateId}/disqualify`, {
    method: "POST",
    body: JSON.stringify({
      member_id: memberId,
      ...(reason ? { disqualify_note: reason.slice(0, 256) } : {}),
    }),
  });
}

/**
 * Revert (undo) a candidate's disqualification. SPI v3: `POST /candidates/{id}/revert`
 * with a required `member_id`; 200 empty/plain-text body. Skips gracefully when no
 * member id is configured. https://workable.readme.io/reference/revert-disqualification-candidate
 */
export async function revertCandidate(candidateId: string): Promise<WorkableWriteResult> {
  const memberId = getWorkableMemberId();
  if (!memberId) return skipWrite("revert");
  await workableFetch<unknown>(`/candidates/${candidateId}/revert`, {
    method: "POST",
    body: JSON.stringify({ member_id: memberId }),
  });
}

export interface WorkableStage {
  slug: string;
  name: string;
  kind: string;
  position: number;
}

export async function listStages(shortcode: string): Promise<WorkableStage[]> {
  const data = await workableFetch<{ stages: WorkableStage[] }>(
    `/jobs/${shortcode}/stages`,
  );
  return data.stages;
}

export interface WorkableSubscription {
  id: number;
  event: string;
  target: string;
  job_shortcode: string | null;
  stage_slug: string | null;
  created_at: string;
  valid_until: string | null;
}

export async function listSubscriptions(): Promise<WorkableSubscription[]> {
  const data = await workableFetch<{ subscriptions: WorkableSubscription[] }>(
    "/subscriptions",
  );
  return data.subscriptions ?? [];
}

/**
 * Register a webhook subscription. Workable's SPI v3 expects a FLAT body
 * (`{ target, event, args? }`) — NOT a `{ subscription: {...} }` envelope.
 *
 * Only `candidate_created` and `candidate_moved` are real subscribable candidate
 * events. `target` MUST be unique across subscriptions (a duplicate returns 409),
 * so do not re-create a hook that already exists (e.g. the live candidate_created
 * subscription id 103591). When `args` is sent for candidate events the docs
 * require all of `account_id`, `job_shortcode`, `stage_slug` — empty strings mean
 * "all jobs"/"all stages". https://workable.readme.io/reference/webhook-subscriptions
 */
export async function createSubscription(input: {
  target: string;
  event: string;
  job_shortcode?: string;
  stage_slug?: string;
}): Promise<{ id: number }> {
  const body: Record<string, unknown> = {
    target: input.target,
    event: input.event,
  };
  if (input.job_shortcode !== undefined || input.stage_slug !== undefined) {
    body.args = {
      account_id: env.WORKABLE_SUBDOMAIN,
      job_shortcode: input.job_shortcode ?? "",
      stage_slug: input.stage_slug ?? "",
    };
  }
  return workableFetch<{ id: number }>("/subscriptions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function verifyWorkableSignature(
  payload: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const digest = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  const signatureBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);
  // timingSafeEqual throws on length mismatch — guard so a malformed/missing
  // signature is a clean reject (401) rather than an unhandled 500.
  if (signatureBuffer.length !== digestBuffer.length) return false;
  return timingSafeEqual(signatureBuffer, digestBuffer);
}
