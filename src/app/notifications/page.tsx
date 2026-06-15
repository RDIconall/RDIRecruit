import Link from "next/link";
import { AppHeader } from "@/components/layout/app-header";
import { listNotifications, markNotificationsRead } from "@/lib/notifications/service";
import { getPublishedJobs, resolveActiveJobShortcode } from "@/lib/jobs/service";
import { candidatePath } from "@/lib/routes";

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const params = await searchParams;
  const jobs = await getPublishedJobs();
  const jobShortcode = (await resolveActiveJobShortcode(params.job)) ?? jobs[0]?.shortcode;
  const alerts = await listNotifications();
  await markNotificationsRead();

  return (
    <div className="min-h-screen bg-cream">
      <AppHeader activeJob={jobShortcode} alertCount={0} />
      <div className="mx-auto max-w-[760px] px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <p className="mt-2 text-sm text-navy/65">Strong-fit crossings and async submissions.</p>

        <div className="mt-6 divide-y divide-navy/10 overflow-hidden rounded-xl border border-navy/10 bg-white">
          {alerts.length ? (
            alerts.map((alert) => {
              const payload = alert.payload as { text?: string; jobShortcode?: string };
              const job = payload.jobShortcode ?? jobShortcode;
              return (
                <div key={alert.id} className="flex items-start justify-between gap-4 px-5 py-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-orange">
                      {(alert.type ?? "alert").replace(/_/g, " ")}
                    </p>
                    <p className="mt-1 text-sm text-navy">{payload.text ?? "Notification"}</p>
                    {alert.candidate_id && job ? (
                      <Link
                        href={candidatePath(job, alert.candidate_id)}
                        className="mt-2 inline-block text-xs text-orange hover:underline"
                      >
                        View candidate →
                      </Link>
                    ) : null}
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-navy/45">
                    {new Date(alert.created_at).toLocaleDateString()}
                  </span>
                </div>
              );
            })
          ) : (
            <p className="px-5 py-8 text-sm text-navy/55">No alerts yet. Strong-fit candidates trigger in-app notifications.</p>
          )}
        </div>
      </div>
    </div>
  );
}
