import { env } from "../env";

const subdomain = env.WORKABLE_SUBDOMAIN;

export function wbCandidate(jobShortcode: string, candidateId: string): string {
  return `https://${subdomain}.workable.com/backend/jobs/${jobShortcode}/candidates/${candidateId}`;
}

export function wbCandidateEmail(jobShortcode: string, candidateId: string): string {
  return `${wbCandidate(jobShortcode, candidateId)}#email`;
}

export function wbCandidateTimeline(jobShortcode: string, candidateId: string): string {
  return `${wbCandidate(jobShortcode, candidateId)}#timeline`;
}

export function wbJob(jobShortcode: string): string {
  return `https://${subdomain}.workable.com/backend/jobs/${jobShortcode}`;
}
