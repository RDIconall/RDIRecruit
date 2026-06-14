"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitReadAdjustment, type AdjustDirection } from "@/app/actions/calibration";

const DIRECTIONS: Array<{ value: AdjustDirection; label: string }> = [
  { value: "lower", label: "Scored too high" },
  { value: "higher", label: "Scored too low" },
  { value: "right", label: "Right — add context" },
];

export function ReadAdjuster({
  candidateId,
  jobShortcode,
  candidateName,
  aiTotal,
  isOverridden,
}: {
  candidateId: string;
  jobShortcode: string;
  candidateName: string;
  aiTotal: number | null;
  isOverridden?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<AdjustDirection>("higher");
  const [correctedTotal, setCorrectedTotal] = useState<string>("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  function onSubmit() {
    if (!note.trim()) {
      setResult("Add your reasoning so Claude can learn from it.");
      return;
    }
    startTransition(async () => {
      const parsedTotal = correctedTotal.trim() === "" ? null : Number(correctedTotal);
      const res = await submitReadAdjustment({
        candidateId,
        jobShortcode,
        candidateName,
        direction,
        correctedTotal: parsedTotal != null && Number.isFinite(parsedTotal) ? parsedTotal : null,
        note,
      });
      if (res.ok) {
        const scopeText = res.scope === "global" ? "every seat" : `the ${jobShortcode} seat`;
        setResult(
          (res.overridden ? `Pinned your read on ${candidateName}. ` : `Re-scored ${candidateName}. `) +
            (res.lesson
              ? `Claude learned a rule for ${scopeText}: “${res.lesson}”`
              : "Calibration updated."),
        );
        setNote("");
        setCorrectedTotal("");
        router.refresh();
      } else {
        setResult(res.error ?? "Could not save adjustment.");
      }
    });
  }

  return (
    <div className="mt-4 rounded-xl border border-navy/12 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            Adjust the read
            {isOverridden ? (
              <span className="ml-2 rounded-full bg-orange/15 px-2 py-0.5 font-mono text-[10px] text-orange">
                reviewer-adjusted
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-xs text-navy/55">
            Correct the score and tell Claude why — it learns and applies it going forward.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-full border border-navy/15 px-4 py-1.5 text-xs font-medium text-navy/75 hover:bg-cream"
        >
          {open ? "Close" : "Adjust"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {DIRECTIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => setDirection(d.value)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                  direction === d.value
                    ? "border-orange bg-orange/10 text-orange"
                    : "border-navy/15 text-navy/70 hover:bg-cream"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="corrected" className="text-xs text-navy/65">
              Your fit{aiTotal != null ? ` (AI: ${aiTotal})` : ""}
            </label>
            <input
              id="corrected"
              type="number"
              min={0}
              max={100}
              value={correctedTotal}
              onChange={(e) => setCorrectedTotal(e.target.value)}
              placeholder="optional"
              className="w-28 rounded-lg border border-navy/12 bg-cream px-3 py-1.5 text-sm"
            />
            <span className="text-xs text-navy/45">Leave blank to nudge by reasoning only.</span>
          </div>

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why would you adjust this? e.g. 'The AI-sounding answers shouldn't tank the score — the role history and reference carry it.' Claude decides if this is a rule for this seat or for all hiring."
            className="h-28 w-full rounded-lg border border-navy/12 bg-cream p-3 text-sm"
          />

          <button
            type="button"
            disabled={pending}
            onClick={onSubmit}
            className="rounded-full bg-orange px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Saving & teaching…" : "Save adjustment & teach Claude"}
          </button>
        </div>
      ) : null}

      {result ? <p className="mt-3 text-sm text-navy/70">{result}</p> : null}
    </div>
  );
}
