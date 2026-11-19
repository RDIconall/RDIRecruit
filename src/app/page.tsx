import { currentUser } from "@clerk/nextjs/server";
import { TriageApp } from "@/components/triage/triage-app";
import { checkHiringAdmin } from "@/lib/auth/hiring-admin";
import { loadTriagePool, CROSS_ROLE_SHORTCODE } from "@/lib/triage/load";
import { reviewerKindFrom, reviewerKindLabel, type Viewer } from "@/lib/triage/reviewer";

// Server-fed from Supabase (candidates + evaluations + working files). Clerk
// middleware requires a session; this page additionally requires the session to
// be on HIRING_ADMIN_EMAILS before any applicant data is loaded. Human triage
// edits persist to Supabase via the server actions in src/app/actions/triage.ts.
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

function AccessRestricted() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 32,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        background: "#f7f5f1",
        color: "#1c1917",
      }}
    >
      <div style={{ maxWidth: 480, textAlign: "center" }}>
        <p style={{ margin: 0, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase", color: "#78716c" }}>
          RDIRecruit
        </p>
        <h1 style={{ margin: "8px 0 12px", fontSize: 28, fontWeight: 700 }}>Access restricted</h1>
        <p style={{ margin: 0, lineHeight: 1.5, color: "#44403c" }}>
          This account is not on the hiring team. Ask an administrator to add your email address.
        </p>
      </div>
    </main>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const access = await checkHiringAdmin();
  if (!access.ok) return <AccessRestricted />;

  const params = await searchParams;
  // Default to cross-role inbox: "who's the best new applicant?"
  const job = params.job || CROSS_ROLE_SHORTCODE;
  const [pool, viewer] = await Promise.all([loadTriagePool(job), resolveViewer()]);

  // key on the job so switching jobs fully resets client state.
  return <TriageApp key={pool.meta.jobShortcode} pool={pool} viewer={viewer} />;
}
