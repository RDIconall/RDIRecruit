"use client";

import { useState } from "react";
import type { ScoreInputRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ClaimWithSource({ input }: { input: ScoreInputRow }) {
  const [open, setOpen] = useState(false);
  const [capture, setCapture] = useState<{
    quote?: string;
    source_ref?: string;
  } | null>(null);

  async function loadCapture() {
    if (capture) return;
    try {
      const res = await fetch(`/api/score-inputs/${input.id}/capture`);
      if (res.ok) setCapture(await res.json());
    } catch {
      setCapture({ quote: input.quote ?? undefined, source_ref: input.source_ref ?? undefined });
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="group w-full rounded-lg border border-transparent px-3 py-2 text-left hover:border-orange/30 hover:bg-orange/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange"
        onMouseEnter={() => {
          setOpen(true);
          void loadCapture();
        }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => {
          setOpen(true);
          void loadCapture();
        }}
        onBlur={() => setOpen(false)}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-navy">{input.claim}</p>
          <span className="shrink-0 text-xs uppercase tracking-wide text-navy/50">
            {input.category}
          </span>
        </div>
      </button>

      {open ? (
        <div
          className={cn(
            "absolute left-0 top-full z-20 mt-2 w-[min(24rem,calc(100vw-3rem))]",
            "rounded-lg border border-navy/10 bg-white p-4 shadow-lg",
          )}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-navy/50">
            {input.source_type} · {input.source_ref}
          </p>
          <blockquote className="mt-2 border-l-2 border-orange pl-3 text-sm italic text-navy/80">
            {capture?.quote ?? input.quote ?? "No quote captured"}
          </blockquote>
        </div>
      ) : null}
    </div>
  );
}
