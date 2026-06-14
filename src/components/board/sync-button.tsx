"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { syncPipeline } from "@/app/actions/candidates";

const MAX_PASSES = 12;

export function SyncButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function run() {
    startTransition(async () => {
      let synced = 0;
      let analyzed = 0;
      let remaining = 0;

      // First pass loads + analyzes; keep going only while there's an
      // analysis backlog, so a big first import finishes on its own.
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
        router.refresh();
        if (remaining <= 0) break;
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={run}
        className="rounded-md border border-navy/18 px-2.5 py-1.5 text-xs text-navy/75 transition hover:border-orange hover:text-orange disabled:opacity-50"
        title="Load new candidates from Workable, analyze the ones missing intelligence, and save"
      >
        {pending ? "Syncing…" : "Sync"}
      </button>
      {message ? <span className="font-mono text-[10px] text-navy/45">{message}</span> : null}
    </div>
  );
}
