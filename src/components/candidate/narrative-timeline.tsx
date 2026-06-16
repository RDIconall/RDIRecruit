import type { NarrativeSegment } from "@/lib/types";
import { Card } from "@/components/ui/shell";

export function NarrativeTimeline({
  segments,
}: {
  segments: NarrativeSegment[];
}) {
  return (
    <Card>
      <h2 className="text-lg font-medium">Life narrative</h2>
      <p className="mt-1 text-sm text-navy/60">
        Gap-free chronology with explicit assumptions.
      </p>
      <ol className="mt-6 space-y-4 border-l border-navy/10 pl-5">
        {segments.map((segment, index) => (
          <li key={`${segment.span}-${index}`} className="relative">
            <span className="absolute -left-[1.35rem] top-1.5 h-2.5 w-2.5 rounded-full bg-orange" />
            <p className="text-xs uppercase tracking-wide text-navy/50">{segment.span}</p>
            <p
              className={
                segment.assumption
                  ? "mt-1 text-sm italic text-navy/70"
                  : "mt-1 text-sm text-navy"
              }
            >
              {segment.text}
            </p>
          </li>
        ))}
        {!segments.length ? (
          <li className="text-sm text-navy/60">No narrative generated yet.</li>
        ) : null}
      </ol>
    </Card>
  );
}
