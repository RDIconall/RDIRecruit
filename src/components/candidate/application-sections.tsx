"use client";

import type { EvaluationRow } from "@/lib/data/overlay";
import type { ParsedResumeReview } from "@/lib/resume/types";
import type {
  AnswerGradePayload,
  DigInPayload,
  ScoreInputRow,
  VerificationPayload,
} from "@/lib/types";
import { ClaimWithSource } from "@/components/candidate/claim-with-source";
import { ResumeViewer } from "@/components/candidate/resume-viewer";
import { FormattedText } from "@/components/ui/formatted-text";

const VERDICT_COLOR: Record<string, string> = {
  CONFIRMED: "#15803d",
  DISCREPANCY: "#b45309",
  UNVERIFIABLE: "rgba(22,35,53,0.5)",
};

const READ_COLOR: Record<string, string> = {
  Clean: "#15803d",
  "Minor flags": "#b45309",
  "Material discrepancy": "#b91c1c",
  "Unverified (no profile)": "rgba(22,35,53,0.55)",
};

const ANSWER_COLOR: Record<string, string> = {
  OWNED: "#15803d",
  SURFACE: "#b45309",
  EVASIVE: "#b91c1c",
};

export function VerificationSection({
  evaluations,
  dateFlags = [],
}: {
  evaluations: EvaluationRow[];
  dateFlags?: string[];
}) {
  const row = evaluations.find((e) => e.kind === "verification");
  const v = row?.payload as unknown as VerificationPayload | undefined;

  const sortedClaims = [...(v?.claims ?? [])].sort((a, b) => {
    const aNeeds = a.category?.includes("NEEDS YOU") || a.note?.includes("[NEEDS YOU]") ? 0 : 1;
    const bNeeds = b.category?.includes("NEEDS YOU") || b.note?.includes("[NEEDS YOU]") ? 0 : 1;
    return aNeeds - bNeeds;
  });

  return (
    <section className="mt-11">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-base font-semibold">Verification &amp; flags.</h2>
        {v?.read ? (
          <span className="text-[13px] font-semibold" style={{ color: READ_COLOR[v.read] ?? "#162335" }}>
            {v.read}
          </span>
        ) : null}
      </div>
      <p className="mt-1 max-w-[760px] text-[12px] leading-relaxed text-navy/55">
        Application compared against the public professional profile. Job-relevant claims only — protected
        attributes are never read. This is verification, not scoring: it does not change the fit number, and it
        flags claims, not the person.
      </p>

      {!v || !v.claims?.length ? (
        <p className="mt-4 text-[13px] text-navy/55">
          No verification rows yet — generated at scoring ingest.
        </p>
      ) : (
        <div className="mt-4">
          {dateFlags.map((flag) => (
            <div
              key={flag}
              className="grid grid-cols-[118px_1fr] gap-[18px] border-t border-navy/12 py-3.5"
            >
              <div>
                <div className="font-mono text-[10px] font-semibold text-orange">NEEDS YOU</div>
                <div className="mt-1 text-[13px] font-semibold">Chronology</div>
              </div>
              <div className="text-[13px] leading-relaxed text-navy/82">{flag}</div>
            </div>
          ))}
          {sortedClaims.map((claim, i) => (
            <div
              key={`${claim.category}-${i}`}
              className="grid grid-cols-[118px_1fr] gap-[18px] border-t border-navy/12 py-3.5"
            >
              <div>
                <div
                  className="font-mono text-[10px] font-semibold"
                  style={{ color: VERDICT_COLOR[claim.verdict] ?? "#162335" }}
                >
                  {claim.verdict}
                </div>
                <div className="mt-1 text-[13px] font-semibold">{claim.category}</div>
              </div>
              <div>
                <div className="text-[13px] leading-relaxed text-navy/82">{claim.note}</div>
                {claim.verdict === "DISCREPANCY" ? (
                  <div className="mt-2 text-[12px] leading-relaxed text-navy/62">
                    <span className="text-navy/45">Application —</span> {claim.application}
                    <br />
                    <span className="text-navy/45">Profile —</span> {claim.profile}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {v && (v.questions?.length || v.actions?.length) ? (
        <div className="mt-[18px] grid gap-7 md:grid-cols-2">
          {v.questions?.length ? (
            <div>
              <div className="text-[12px] font-semibold">Pinpoint questions to resolve live</div>
              {v.questions.map((q) => (
                <div key={q} className="mt-2 flex gap-2 text-[12px] leading-relaxed text-navy/75">
                  <span className="shrink-0 text-orange">→</span>
                  <span>{q}</span>
                </div>
              ))}
            </div>
          ) : null}
          {v.actions?.length ? (
            <div>
              <div className="text-[12px] font-semibold">Checks before an offer</div>
              {v.actions.map((a) => (
                <div key={a} className="mt-2 flex gap-2 text-[12px] leading-relaxed text-navy/75">
                  <span className="shrink-0 text-navy/35">·</span>
                  <span>{a}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ApplicationSection({
  candidateId,
  evaluations,
  coverLetter,
  fallbackResumeUrl,
  scoreInputs,
  resumeReview,
}: {
  candidateId: string;
  evaluations: EvaluationRow[];
  coverLetter: string | null;
  fallbackResumeUrl: string | null;
  scoreInputs: ScoreInputRow[];
  resumeReview?: ParsedResumeReview | null;
}) {
  const dig = evaluations.find((e) => e.kind === "dig_in")?.payload as unknown as DigInPayload | undefined;
  const answers = evaluations
    .filter((e) => e.kind === "answer_grade")
    .map((e) => e.payload as unknown as AnswerGradePayload);

  return (
    <section className="mt-11">
      <h2 className="border-b border-navy/15 pb-2 text-base font-semibold">The application — in full.</h2>

      {dig ? (
        <div className="mt-[18px] border border-navy/12 border-t-2 border-t-navy p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="text-sm font-semibold">Dig-in card</div>
            <div className="text-[13px]">
              <span className="text-navy/55">evidence quality </span>
              <span className="font-semibold text-[#15803d]">{dig.quality}</span>
            </div>
          </div>
          {dig.careerRead ? (
            <FormattedText
              text={dig.careerRead}
              className="mt-2.5 max-w-[760px] text-[13px] leading-relaxed text-navy/82"
            />
          ) : null}
          <div className="mt-3.5 grid gap-6 md:grid-cols-2">
            <div>
              <div className="text-[12px] font-semibold">Answers</div>
              <div className="mt-1 text-[12px] text-navy/70">{dig.mix || "—"}</div>
              <div className="mt-2.5 text-[12px] font-semibold">
                Integrity — <span className="text-[#b45309]">{dig.integrity}</span>
              </div>
              {dig.integrityNote ? (
                <div className="mt-1 text-[12px] leading-snug text-navy/65">{dig.integrityNote}</div>
              ) : null}
            </div>
            {dig.resolve?.length ? (
              <div>
                <div className="text-[12px] font-semibold">Settle live</div>
                {dig.resolve.map((r) => (
                  <div key={r} className="mt-1.5 flex gap-2 text-[12px] leading-snug text-navy/75">
                    <span className="shrink-0 text-orange">→</span>
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {answers.length ? (
        <>
          <div className="mt-7 text-sm font-semibold">Screening answers</div>
          <p className="mt-1 max-w-[760px] text-[12px] text-navy/55">
            Graded on substance against the concept key, not on fluency. The verdict says whether the answer owns
            the method or just names the tools.
          </p>
          {answers.map((a, i) => (
            <div key={`${a.question}-${i}`} className="mt-4 border-b border-navy/10 pb-4">
              <div className="flex items-baseline justify-between gap-3">
                <div className="max-w-[660px] text-[13px] font-semibold">{a.question}</div>
                <div
                  className="font-mono text-[11px] font-semibold"
                  style={{ color: ANSWER_COLOR[a.verdict] ?? "#162335" }}
                >
                  {a.verdict}
                </div>
              </div>
              {a.answer ? (
                <FormattedText
                  text={a.answer}
                  className="mt-1.5 max-w-[760px] text-[13px] leading-relaxed text-navy/78"
                />
              ) : null}
              {a.present?.length ? (
                <div className="mt-2 text-[12px] leading-snug text-[#15803d]">
                  Demonstrates — {a.present.join(" · ")}
                </div>
              ) : null}
              {a.note ? <p className="mt-1.5 text-[12px] text-navy/55">{a.note}</p> : null}
            </div>
          ))}
        </>
      ) : null}

      {scoreInputs.length ? (
        <div className="mt-8">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-navy/50">Claim ↔ source</div>
          <div className="mt-3 space-y-1">
            {scoreInputs.map((input) => (
              <ClaimWithSource key={input.id} input={input} />
            ))}
          </div>
        </div>
      ) : null}

      {coverLetter ? (
        <div className="mt-8">
          <div className="text-sm font-semibold">Cover letter</div>
          <p className="mt-2.5 max-w-[720px] whitespace-pre-wrap text-[14px] leading-[1.7] text-navy/85">
            {coverLetter}
          </p>
        </div>
      ) : null}

      <div className="mt-7">
        <div className="text-sm font-semibold">Résumé</div>
        <ResumeViewer candidateId={candidateId} fallbackUrl={fallbackResumeUrl} />
      </div>

    </section>
  );
}
