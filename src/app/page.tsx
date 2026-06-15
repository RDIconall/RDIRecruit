import { currentUser } from "@clerk/nextjs/server";
import { TriageApp } from "@/components/triage/triage-app";
import { loadTriagePool, DEFAULT_JOB_SHORTCODE } from "@/lib/triage/load";
import { reviewerKindFrom, reviewerKindLabel, type Viewer } from "@/lib/triage/reviewer";

// Server-fed from Supabase (candidates + evaluations + working files). Auth is
// enforced by Clerk middleware. Human triage edits persist to Supabase via the
// server actions in src/app/actions/triage.ts.
export const dynamic = "force-dynamic";

async function resolveViewer(): Promise<Viewer> {
  try {
    const user = await currentUser();
    if (!user) return { kind: "other", label: reviewerKindLabel("other") };
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    const email = user.emailAddresses?.[0]?.emailAddress;
    const label = name || (email ? email.split("@")[0] : undefined);
    const kind = reviewerKindFrom(label || email);
    return { id: user.id, label: label || reviewerKindLabel(kind), kind };
  } catch {
    return { kind: "other", label: reviewerKindLabel("other") };
  }
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const params = await searchParams;
  const job = params.job || DEFAULT_JOB_SHORTCODE;
  const [pool, viewer] = await Promise.all([loadTriagePool(job), resolveViewer()]);

  // key on the job so switching jobs fully resets client state.
  return <TriageApp key={pool.meta.jobShortcode} pool={pool} viewer={viewer} />;
}
