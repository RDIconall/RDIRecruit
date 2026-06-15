"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { advanceCandidate } from "@/app/actions/candidates";

const TEMPLATES = [
  {
    id: "async-video",
    label: "Async interview invite",
    subject: "Next step: two short recorded answers",
    sendLabel: "Move to Async interview & send",
    targetStage: "assessment",
    body: (name: string, insert: string) =>
      `Hi ${name} — a short async step before we book a call. Please record answers to:\n\n${insert}\n\nWe use VideoAsk so you can respond unscripted. Consent line auto-appended.`,
  },
  {
    id: "phone-screen",
    label: "Phone screen (Calendly)",
    subject: "RDI Trials — phone screen",
    sendLabel: "Move to Phone screen & send",
    targetStage: "phone-screen",
    body: (name: string) =>
      `Hi ${name} — book a slot via the Calendly link in this template when you're ready.`,
  },
  {
    id: "hold",
    label: "Hold — keep warm",
    subject: "RDI Trials — holding your application",
    sendLabel: "Move to Hold",
    targetStage: "applied",
    body: (name: string) =>
      `Hi ${name} — we're pausing your file while we compare against the active pool. No action needed.`,
  },
  {
    id: "reject",
    label: "Early-stage rejection",
    subject: "RDI Trials — update on your application",
    sendLabel: "Move to Rejected & send",
    targetStage: "applied",
    body: (name: string) =>
      `Hi ${name} — thank you for applying. We won't be moving forward at this stage.`,
  },
];

const DEFAULT_QUESTIONS: Array<{ q: string; why: string }> = [
  {
    q: "Walk me through a time you had to push back on a principal — what did you say, and what happened?",
    why: "Integrity + ego read under pressure — the gate we can't backstop.",
  },
  {
    q: "Take a problem you've never worked and reason it out loud for two minutes.",
    why: "Tests portability, not recall — strips away domain coincidence.",
  },
  {
    q: "What would you need from us in the first 30 days to be effective in this seat?",
    why: "Surfaces whether they take intent or need everything specified.",
  },
];

export function ComposeClient({
  candidateId,
  jobShortcode,
  candidateName,
  workableEmailUrl,
  suggestedQuestions = [],
}: {
  candidateId: string;
  jobShortcode: string;
  candidateName: string;
  workableEmailUrl: string;
  suggestedQuestions?: Array<{ q: string; why: string }>;
}) {
  const router = useRouter();
  const questions = suggestedQuestions.length ? suggestedQuestions : DEFAULT_QUESTIONS;
  const [templateId, setTemplateId] = useState(TEMPLATES[0]!.id);
  const [selected, setSelected] = useState<Set<number>>(
    new Set(questions.map((_, i) => i).slice(0, 2)),
  );
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const template = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0]!;
  const firstName = candidateName.split(" ")[0] ?? "there";
  const insert = [...selected]
    .sort((a, b) => a - b)
    .map((i, n) => `${n + 1}. ${questions[i]?.q ?? ""}`)
    .join("\n");

  function toggleQuestion(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function sendViaStageMove() {
    if (selected.size === 0) {
      setMessage("Select at least one risk probe.");
      return;
    }
    startTransition(async () => {
      const result = await advanceCandidate({
        jobShortcode,
        candidateId,
        targetStage: template.targetStage,
      });
      if (result.ok) {
        setMessage(`Advanced — Workable will fire the ${template.label} template.`);
        router.refresh();
      } else {
        setMessage(result.error ?? "Stage move failed");
      }
    });
  }

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <div>
          <div className="text-[12px] font-semibold uppercase tracking-wide text-navy/50">Template</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplateId(t.id)}
                className={
                  t.id === templateId
                    ? "rounded-full bg-navy px-3.5 py-1.5 text-xs font-medium text-cream"
                    : "rounded-full border border-navy/18 px-3.5 py-1.5 text-xs text-navy/70"
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-[12px] font-semibold uppercase tracking-wide text-navy/50">Subject</label>
          <div className="mt-2 rounded-md border border-navy/15 bg-white px-3 py-2.5 text-sm">{template.subject}</div>
        </div>

        <div>
          <label className="text-[12px] font-semibold uppercase tracking-wide text-navy/50">Body preview</label>
          <div className="mt-2 whitespace-pre-wrap rounded-md border border-navy/15 bg-white px-4 py-3 text-[14px] leading-relaxed text-navy/82">
            {template.body(firstName, insert)}
          </div>
        </div>

        <div>
          <div className="text-[12px] font-semibold uppercase tracking-wide text-navy/50">
            AI-suggested risk questions (check to include)
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-navy/55">
            One repeated judgment anchor for the cross-modal check, plus tailored risk probes. The application
            gates are not re-asked.
          </p>
          <ul className="mt-3 space-y-2.5">
            {questions.map((item, index) => (
              <li
                key={item.q}
                onClick={() => toggleQuestion(index)}
                className={
                  selected.has(index)
                    ? "flex cursor-pointer items-start gap-3 border border-orange bg-orange/[0.04] p-3"
                    : "flex cursor-pointer items-start gap-3 border border-navy/15 p-3"
                }
              >
                <input
                  type="checkbox"
                  checked={selected.has(index)}
                  onChange={() => toggleQuestion(index)}
                  className="mt-1 accent-orange"
                />
                <div className="min-w-0">
                  <div className="text-[14px] leading-relaxed text-navy">{item.q}</div>
                  {item.why ? (
                    <div className="mt-1.5 text-[12px] leading-snug text-navy/55">{item.why}</div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="text-[12px] font-semibold uppercase tracking-wide text-navy/50">
            VideoAsk capture
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2.5">
            <div>
              <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-navy">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-cream/15">
                  <div className="ml-0.5 h-0 w-0 border-y-[6px] border-l-[10px] border-y-transparent border-l-cream" />
                </div>
                <span className="absolute right-1.5 bottom-1.5 bg-black/45 px-1.5 font-mono text-[9px] text-cream">
                  1:48
                </span>
              </div>
              <div className="mt-1.5 font-mono text-[10px] text-navy/55">Intro · reused</div>
            </div>
            {[...selected]
              .sort((a, b) => a - b)
              .map((qIndex, n) => (
                <div key={qIndex}>
                  <div className="flex aspect-video items-center justify-center border border-dashed border-navy/25 font-mono text-[10px] text-navy/40">
                    slot · Q{n + 1}
                  </div>
                  <div className="mt-1.5 font-mono text-[10px] text-navy/55">Answer {n + 1}</div>
                </div>
              ))}
            {selected.size === 0 ? (
              <div className="col-span-2 flex aspect-video items-center justify-center border border-dashed border-navy/20 font-mono text-[10px] text-navy/40">
                select a question to add an answer slot
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <aside className="space-y-4">
        <div className="border border-navy/12 border-t-2 border-t-navy p-4">
          <div className="text-sm font-semibold">Send path</div>
          <ol className="mt-3 space-y-2 text-[14px] leading-relaxed text-navy/75">
            <li>1. Check ≥1 risk probe</li>
            <li>2. Advance stage → Workable fires template</li>
            <li>3. VideoAsk captures spoken answers</li>
            <li>4. Webhook re-scores on new evidence</li>
          </ol>
        </div>

        <button
          type="button"
          disabled={pending || selected.size === 0}
          onClick={sendViaStageMove}
          className="block w-full rounded-full bg-orange py-2.5 text-center text-[14px] font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Moving stage…" : template.sendLabel}
        </button>

        <a
          href={workableEmailUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full rounded-full border border-navy/20 py-2.5 text-center text-[14px] text-navy hover:border-orange hover:text-orange"
        >
          Open in Workable to send ↗
        </a>

        {message ? <p className="text-xs text-navy/60">{message}</p> : null}
      </aside>
    </div>
  );
}
