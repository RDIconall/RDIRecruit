"use client";

import { useTransition } from "react";
import Link from "next/link";
import {
  advanceCandidate,
  denyCandidate,
  holdCandidate,
} from "@/app/actions/candidates";

export function CandidateActions({
  candidateId,
  jobShortcode,
}: {
  candidateId: string;
  jobShortcode: string;
}) {
  const [pending, startTransition] = useTransition();

  function run(action: "advance" | "hold" | "deny") {
    startTransition(async () => {
      if (action === "advance") {
        await advanceCandidate({
          jobShortcode,
          candidateId,
          currentStage: undefined,
        });
      }
      if (action === "hold") await holdCandidate({ jobShortcode, candidateId });
      if (action === "deny") await denyCandidate({ jobShortcode, candidateId });
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <ActionButton disabled={pending} onClick={() => run("advance")} label="Advance" />
        <ActionButton disabled={pending} onClick={() => run("hold")} label="Hold" variant="secondary" />
        <ActionButton disabled={pending} onClick={() => run("deny")} label="Deny" variant="danger" />
      </div>
      <Link
        href={`/invite/${candidateId}?job=${jobShortcode}`}
        className="inline-flex rounded-lg bg-navy px-4 py-2 text-sm font-medium text-cream transition hover:bg-navy-muted"
      >
        Compose invite
      </Link>
      <p className="text-sm text-navy/60">
        Stage moves write back to Workable through the rate-limited queue and trigger Workable templates.
      </p>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  variant = "primary",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) {
  const styles = {
    primary: "bg-orange text-white hover:bg-orange-muted",
    secondary: "bg-white text-navy ring-1 ring-navy/10 hover:bg-cream",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${styles[variant]}`}
    >
      {label}
    </button>
  );
}
