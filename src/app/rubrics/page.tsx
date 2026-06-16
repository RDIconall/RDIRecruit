import { AppHeader } from "@/components/layout/app-header";
import { RubricEditor } from "@/components/rubrics/rubric-editor";
import { MethodEditor } from "@/components/rubrics/method-editor";
import { getActiveRubricMarkdown } from "@/app/actions/rubrics";
import { getPublishedJobs, resolveActiveJobShortcode } from "@/lib/jobs/service";
import { DEFAULT_RUBRIC_MD } from "@/lib/rubric/parser";
import { getCalibrationForJob } from "@/lib/calibration/service";
import { getMethodDoc } from "@/lib/evaluation/method";
import { getUnreadNotificationCount } from "@/lib/notifications/service";

export default async function RubricsPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const params = await searchParams;
  const jobs = await getPublishedJobs();
  const jobShortcode = (await resolveActiveJobShortcode(params.job)) ?? jobs[0]?.shortcode ?? "EA-001";
  const rubricDoc = await getActiveRubricMarkdown(jobShortcode);
  const calibration = await getCalibrationForJob(jobShortcode);
  const method = await getMethodDoc();
  const alertCount = await getUnreadNotificationCount();

  return (
    <div className="min-h-screen bg-cream">
      <AppHeader activeJob={jobShortcode} alertCount={alertCount} />
      <div className="mx-auto max-w-[1180px] px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Evaluation docs{" "}
          <span className="font-serif italic font-normal text-orange">for {jobShortcode}.</span>
        </h1>
        <p className="mt-2 max-w-[760px] text-sm text-navy/65">
          Every read is graded against <strong>two documents</strong>: the global{" "}
          <em>How we evaluate</em> method (below) and this seat&rsquo;s rubric. Markdown is the
          source of truth — each save versions the doc and re-scores affected candidates.
        </p>

        <div className="mt-8">
          <MethodEditor initialMarkdown={method} />
        </div>

        <div className="mt-8">
          <h2 className="text-base font-semibold">
            Rubric <span className="font-normal text-navy/55">— specific to {jobShortcode}</span>
          </h2>
          <p className="mt-1 text-xs text-navy/55">
            Weights, tiers, and what &ldquo;good&rdquo; looks like for this seat. Upload a job spec
            to append what candidates are scored against — then save to apply.{" "}
            {rubricDoc.source === "saved"
              ? `Editing saved v${rubricDoc.version}.`
              : rubricDoc.source === "seed"
                ? "Loaded from the docs/ source file — save to create an editable version."
                : "Using the default template — save to create this seat's rubric."}
          </p>
          <div className="mt-4">
            <RubricEditor
              jobShortcode={jobShortcode}
              initialMarkdown={rubricDoc.markdown ?? DEFAULT_RUBRIC_MD}
            />
          </div>
        </div>

        {calibration.global || calibration.role ? (
          <div className="mt-10">
            <h2 className="text-base font-semibold">
              Learned calibration{" "}
              <span className="font-normal text-navy/55">— from your score adjustments</span>
            </h2>
            <p className="mt-1 text-sm text-navy/60">
              Claude distills your corrections into rules it applies on future reads. Global rules
              affect every seat; role rules affect {jobShortcode} only.
            </p>
            <div className="mt-4 grid gap-6 lg:grid-cols-2">
              <CalibrationCard title="Global — every seat" body={calibration.global} />
              <CalibrationCard title={`Role — ${jobShortcode}`} body={calibration.role} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CalibrationCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-navy/10 bg-white p-5">
      <p className="font-medium">{title}</p>
      {body.trim() ? (
        <pre className="mt-3 whitespace-pre-wrap font-mono text-xs leading-relaxed text-navy/75">
          {body.trim()}
        </pre>
      ) : (
        <p className="mt-3 text-sm text-navy/45">Nothing learned yet.</p>
      )}
    </div>
  );
}
