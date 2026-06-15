"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveMethod } from "@/app/actions/rubrics";

export function MethodEditor({ initialMarkdown }: { initialMarkdown: string }) {
  const router = useRouter();
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function onSave() {
    startTransition(async () => {
      const result = await saveMethod(markdown);
      if (result.ok) {
        setMessage(
          `Saved method v${result.version}. Every seat will re-score against it on the next sync.`,
        );
        router.refresh();
      } else {
        setMessage(result.error ?? "Save failed");
      }
    });
  }

  return (
    <div className="rounded-xl border border-navy/10 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">How we evaluate — global method</h2>
          <p className="mt-0.5 text-xs text-navy/55">
            Read on every candidate, for every seat. Paired with each job&rsquo;s rubric below.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-full border border-navy/15 px-4 py-1.5 text-xs font-medium text-navy/75 hover:bg-cream"
        >
          {open ? "Close" : "Edit method"}
        </button>
      </div>

      {open ? (
        <div className="mt-4">
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            className="h-[28rem] w-full rounded-lg border border-navy/10 bg-cream p-4 font-mono text-sm"
          />
          <button
            type="button"
            disabled={pending}
            onClick={onSave}
            className="mt-3 rounded-full bg-orange px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save method"}
          </button>
          {message ? <p className="mt-3 text-sm text-navy/65">{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
