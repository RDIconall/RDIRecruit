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

export async function workableFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...headers(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Workable API error ${res.status} on ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
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
  const query = new URLSearchParams();
  if (params?.state) query.set("state", params.state);
  if (params?.limit) query.set("limit", String(params.limit));
  const qs = query.toString() ? `?${query}` : "";
  const data = await workableFetch<{ jobs: WorkableJob[] }>(`/jobs${qs}`);
  return data.jobs;
}

export async function getJob(shortcode: string): Promise<WorkableJob> {
  const data = await workableFetch<{ job: WorkableJob }>(`/jobs/${shortcode}`);
  return data.job;
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
 * Fetch every candidate for a job, following `since_id` pagination.
 * Workable caps a page at 100; this loops until a short page (safety cap 50 pages).
 */
export async function listAllCandidates(
  shortcode: string,
  params?: { updatedAfter?: string | null },
): Promise<WorkableCandidate[]> {
  const all: WorkableCandidate[] = [];
  let sinceId: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const batch = await listCandidates(shortcode, {
      limit: 100,
      since_id: sinceId,
      updated_after: params?.updatedAfter ?? undefined,
    });
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
    sinceId = batch[batch.length - 1]!.id;
  }
  return all;
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

export async function listCandidateActivities(
  candidateId: string,
  params?: { limit?: number; actions?: string; updated_after?: string },
): Promise<WorkableActivity[]> {
  const query = new URLSearchParams();
  if (params?.limit) query.set("limit", String(params.limit ?? 50));
  if (params?.actions) query.set("actions", params.actions);
  if (params?.updated_after) query.set("updated_after", params.updated_after);
  const qs = query.toString() ? `?${query}` : "";
  const data = await workableFetch<{ activities: WorkableActivity[] }>(
    `/candidates/${candidateId}/activities${qs}`,
  );
  return data.activities ?? [];
}

export async function moveCandidateStage(
  shortcode: string,
  candidateId: string,
  targetStage: string,
): Promise<WorkableCandidate> {
  const data = await workableFetch<{ candidate: WorkableCandidate }>(
    `/jobs/${shortcode}/candidates/${candidateId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ candidate: { stage: targetStage } }),
    },
  );
  return data.candidate;
}

export async function addCandidateNote(
  shortcode: string,
  candidateId: string,
  body: string,
): Promise<void> {
  await workableFetch(`/jobs/${shortcode}/candidates/${candidateId}/activities`, {
    method: "POST",
    body: JSON.stringify({ activity: { action: "note", body } }),
  });
}

export async function addCandidateTags(
  shortcode: string,
  candidateId: string,
  tags: string[],
): Promise<WorkableCandidate> {
  const data = await workableFetch<{ candidate: WorkableCandidate }>(
    `/jobs/${shortcode}/candidates/${candidateId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ candidate: { tags } }),
    },
  );
  return data.candidate;
}

export async function disqualifyCandidate(
  shortcode: string,
  candidateId: string,
  reason?: string,
): Promise<WorkableCandidate> {
  const data = await workableFetch<{ candidate: WorkableCandidate }>(
    `/jobs/${shortcode}/candidates/${candidateId}/disqualify`,
    {
      method: "POST",
      body: JSON.stringify({ disqualification_reason: reason ?? "" }),
    },
  );
  return data.candidate;
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

export interface WorkableEvent {
  id: string;
  type: string;
  created_at: string;
  payload: Record<string, unknown>;
}

export async function listEvents(params?: {
  since?: string;
  limit?: number;
}): Promise<WorkableEvent[]> {
  const query = new URLSearchParams();
  if (params?.since) query.set("since", params.since);
  if (params?.limit) query.set("limit", String(params.limit ?? 100));
  const qs = query.toString() ? `?${query}` : "";
  const data = await workableFetch<{ events: WorkableEvent[] }>(`/events${qs}`);
  return data.events;
}

export async function createSubscription(input: {
  target: string;
  event: string;
  job_shortcode?: string;
}): Promise<{ id: string }> {
  const data = await workableFetch<{ subscription: { id: string } }>(
    "/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({ subscription: input }),
    },
  );
  return data.subscription;
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
  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(digest),
  );
}
