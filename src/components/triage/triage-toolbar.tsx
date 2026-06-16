"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { syncPipeline } from "@/app/actions/candidates";
import { FONTS, ink } from "@/lib/triage/theme";

const MAX_PASSES = 12;

/**
 * Global triage controls: pull new candidates + résumés from Workable, and reach
 * the evaluation docs (job spec upload + "how we evaluate"/"how we hire").
 *
 * The board's SyncButton relies on router.refresh() because the board is
 * server-rendered. TriageApp instead seeds candidates into local React state, so
 * a refresh won't repaint the list — we hard-reload once the backlog is drained
 * to surface the freshly synced candidates and reads.
 */
export function TriageToolbar({
  jobShortcode,
  narrow,
}: {
  jobShortcode: string;
  narrow: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function run() {
    startTransition(async () => {
      let synced = 0;
      let analyzed = 0;
      let remaining = 0;

      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const result = await syncPipeline();
        if (!result.ok) {
          setMessage(result.error ?? "Sync failed");
          return;
        }
        synced += result.candidatesSynced ?? 0;
        analyzed += result.scored ?? 0;
        remaining = result.remaining ?? 0;
        setMessage(
          remaining > 0
            ? `${analyzed} analyzed · ${remaining} left…`
            : `${synced} synced · ${analyzed} analyzed`,
        );
        if (remaining <= 0) break;
      }

      window.location.reload();
    });
  }

  const docsHref = `/rubrics?job=${encodeURIComponent(jobShortcode)}`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
      {message && !narrow ? (
        <span
          style={{
            fontFamily: FONTS.mono,
            fontSize: 10.5,
            color: ink(0.45),
            whiteSpace: "nowrap",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {message}
        </span>
      ) : null}

      <button
        type="button"
        onClick={run}
        disabled={pending}
        title="Pull new candidates and résumés from Workable, analyze the ones missing a read, then refresh"
        style={{
          fontFamily: FONTS.sans,
          fontSize: 13,
          color: pending ? ink(0.4) : "#162335",
          background: "transparent",
          border: `1px solid ${ink(0.18)}`,
          borderRadius: 8,
          padding: "5px 12px",
          cursor: pending ? "default" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {pending ? "Syncing…" : "Sync"}
      </button>

      <Link
        href={docsHref}
        title="Upload the job spec, edit the rubric, and read how we evaluate / how we hire"
        style={{
          fontFamily: FONTS.sans,
          fontSize: 13,
          color: ink(0.6),
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        Docs
      </Link>
    </div>
  );
}
