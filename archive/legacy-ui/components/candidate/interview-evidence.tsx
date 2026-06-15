"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addInterviewEvidence,
  addVideoAskAnswers,
  type InterviewKind,
} from "@/app/actions/interviews";
import { FormattedText } from "@/components/ui/formatted-text";
import type { EvidenceRow } from "@/lib/types";

const SOURCE_META: Record<string, { label: string; tone: string }> = {
  interview: { label: "Interview", tone: "#162335" },
  phone_screen: { label: "Phone screen", tone: "#0f766e" },
  async_video: { label: "Async video", tone: "#b45309" },
  fireflies: { label: "Fireflies", tone: "#7c3aed" },
};

type Mode = null | "interview" | "videoask";

export function InterviewEvidence({
  candidateId,
  jobShortcode,
  evidence,
}: {
  candidateId: string;
  jobShortcode: string;
  evidence: EvidenceRow[];
}) {
  const [mode, setMode] = useState<Mode>(null);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-navy/15 pb-2.5">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight">Interviews &amp; evidence</h2>
          <p className="mt-0.5 text-xs text-navy/55">
            Paste transcripts or enter VideoAsk answers — each is weighed heavily and re-scores the read.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setMode((m) => (m === "interview" ? null : "interview"))}
            className={`rounded-full border px-4 py-1.5 text-xs font-medium transition ${
              mode === "interview"
                ? "border-orange bg-orange/10 text-orange"
                : "border-navy/15 text-navy/75 hover:bg-cream"
            }`}
          >
            Add interview
          </button>
          <button
            type="button"
            onClick={() => setMode((m) => (m === "videoask" ? null : "videoask"))}
            className={`rounded-full border px-4 py-1.5 text-xs font-medium transition ${
              mode === "videoask"
                ? "border-orange bg-orange/10 text-orange"
                : "border-navy/15 text-navy/75 hover:bg-cream"
            }`}
          >
            Add VideoAsk answers
          </button>
        </div>
      </div>

      {mode === "interview" ? (
        <InterviewForm
          candidateId={candidateId}
          jobShortcode={jobShortcode}
          onDone={() => setMode(null)}
        />
      ) : null}
      {mode === "videoask" ? (
        <VideoAskForm
          candidateId={candidateId}
          jobShortcode={jobShortcode}
          onDone={() => setMode(null)}
        />
      ) : null}

      {evidence.length === 0 ? (
        <p className="mt-5 text-sm text-navy/50">
          No interview evidence yet. Add a transcript or VideoAsk answers to enrich the read.
        </p>
      ) : (
        <div className="mt-5 space-y-3">
          {evidence.map((row) => (
            <EvidenceCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function EvidenceCard({ row }: { row: EvidenceRow }) {
  const [open, setOpen] = useState(false);
  const meta = SOURCE_META[row.source_type] ?? { label: row.source_type, tone: "#162335" };
  const transcript = row.transcript ?? "";
  const long = transcript.length > 420;
  const shown = open || !long ? transcript : `${transcript.slice(0, 420).trimEnd()}…`;
  const when = row.captured_at ?? row.created_at;

  return (
    <div className="rounded-xl border border-navy/12 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-white"
          style={{ background: meta.tone }}
        >
          {meta.label}
        </span>
        <span className="text-sm font-semibold text-navy">{row.label ?? meta.label}</span>
        {row.author ? <span className="text-xs text-navy/55">· {row.author}</span> : null}
        <span className="flex-1" />
        {when ? (
          <span className="font-mono text-[11px] text-navy/45">{formatDate(when)}</span>
        ) : null}
      </div>
      {transcript ? (
        <FormattedText
          text={shown}
          className="mt-3 text-sm leading-relaxed text-navy/82"
        />
      ) : (
        <p className="mt-3 text-sm text-navy/45">No transcript text captured.</p>
      )}
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-2 text-xs font-medium text-orange hover:underline"
        >
          {open ? "Show less" : "Show full transcript"}
        </button>
      ) : null}
    </div>
  );
}

function InterviewForm({
  candidateId,
  jobShortcode,
  onDone,
}: {
  candidateId: string;
  jobShortcode: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<InterviewKind>("interview");
  const [label, setLabel] = useState("");
  const [author, setAuthor] = useState("");
  const [date, setDate] = useState("");
  const [transcript, setTranscript] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  function onSubmit() {
    if (!transcript.trim()) {
      setResult("Paste the interview transcript first.");
      return;
    }
    startTransition(async () => {
      const res = await addInterviewEvidence({
        candidateId,
        jobShortcode,
        kind,
        label,
        author,
        date,
        transcript,
      });
      if (res.ok) {
        setResult(
          res.scored
            ? "Saved — the read is recalculating with this interview."
            : "Saved. (Scoring not configured, so the read was not recalculated.)",
        );
        setLabel("");
        setAuthor("");
        setDate("");
        setTranscript("");
        router.refresh();
        if (res.scored) setTimeout(onDone, 1200);
      } else {
        setResult(res.error ?? "Could not save the transcript.");
      }
    });
  }

  return (
    <div className="mt-4 rounded-xl border border-navy/12 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex overflow-hidden rounded-full border border-navy/15">
          {(["interview", "phone_screen"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className="px-3.5 py-1.5 text-xs font-medium"
              style={{
                background: kind === k ? "#162335" : "#fff",
                color: kind === k ? "#FAFAF7" : "rgba(22,35,53,0.7)",
              }}
            >
              {k === "interview" ? "Interview" : "Phone screen"}
            </button>
          ))}
        </div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={kind === "phone_screen" ? "Phone screen" : "Onsite 1"}
          className="w-40 rounded-lg border border-navy/12 bg-cream px-3 py-1.5 text-sm"
        />
        <input
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="Interviewer (optional)"
          className="w-48 rounded-lg border border-navy/12 bg-cream px-3 py-1.5 text-sm"
        />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-navy/12 bg-cream px-3 py-1.5 text-sm text-navy/70"
        />
      </div>
      <textarea
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
        placeholder="Paste the interview transcript or notes here…"
        className="mt-3 h-44 w-full rounded-lg border border-navy/12 bg-cream p-3 text-sm"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={onSubmit}
          className="rounded-full bg-orange px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Saving & re-scoring…" : "Add interview & re-score"}
        </button>
        {result ? <span className="text-sm text-navy/70">{result}</span> : null}
      </div>
    </div>
  );
}

function VideoAskForm({
  candidateId,
  jobShortcode,
  onDone,
}: {
  candidateId: string;
  jobShortcode: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [date, setDate] = useState("");
  const [answers, setAnswers] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  function onSubmit() {
    if (!answers.trim()) {
      setResult("Enter the candidate's VideoAsk answers first.");
      return;
    }
    startTransition(async () => {
      const res = await addVideoAskAnswers({ candidateId, jobShortcode, label, date, answers });
      if (res.ok) {
        setResult(
          res.scored
            ? "Saved — the read is recalculating with these answers."
            : "Saved. (Scoring not configured, so the read was not recalculated.)",
        );
        setLabel("");
        setDate("");
        setAnswers("");
        router.refresh();
        if (res.scored) setTimeout(onDone, 1200);
      } else {
        setResult(res.error ?? "Could not save the answers.");
      }
    });
  }

  return (
    <div className="mt-4 rounded-xl border border-navy/12 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="VideoAsk answers"
          className="w-52 rounded-lg border border-navy/12 bg-cream px-3 py-1.5 text-sm"
        />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-navy/12 bg-cream px-3 py-1.5 text-sm text-navy/70"
        />
      </div>
      <textarea
        value={answers}
        onChange={(e) => setAnswers(e.target.value)}
        placeholder="Paste or type the candidate's VideoAsk answers — one per line or as a block…"
        className="mt-3 h-40 w-full rounded-lg border border-navy/12 bg-cream p-3 text-sm"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={onSubmit}
          className="rounded-full bg-orange px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Saving & re-scoring…" : "Save answers & re-score"}
        </button>
        {result ? <span className="text-sm text-navy/70">{result}</span> : null}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
