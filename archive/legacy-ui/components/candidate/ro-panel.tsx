import type { RoAssessmentRow } from "@/lib/types";
import { confidenceLabel } from "@/lib/ro/assessment";
import { Card } from "@/components/ui/shell";

export function RoPanel({ ro }: { ro: RoAssessmentRow | null }) {
  if (!ro) {
    return (
      <Card>
        <h2 className="text-lg font-medium">RO read</h2>
        <p className="mt-2 text-sm text-navy/60">No RO assessment yet.</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">RO read</h2>
          <p className="mt-1 text-sm text-navy/70">
            Seat band: {ro.seat_stratum} · Current: {ro.current_capability}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-medium capitalize">{ro.trajectory?.replace(/-/g, " ")}</p>
          <p className="text-xs text-navy/60">{confidenceLabel(ro.text_confidence ?? "confirmed")}</p>
          <p className="text-xs text-navy/50">Basis: {ro.basis}</p>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        {ro.per_role.map((role) => (
          <div key={`${role.company}-${role.role}`} className="rounded-lg bg-cream p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">{role.role}</p>
                <p className="text-sm text-navy/70">
                  {role.company} · {role.years} yrs
                </p>
              </div>
              <span className="rounded-full bg-navy px-3 py-1 text-xs text-cream">
                {role.stratum}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              {(["I", "II", "III"] as const).map((level) => (
                <div key={level} className="rounded-md border border-navy/10 p-2">
                  <p className="font-medium text-navy/60">Stratum {level}</p>
                  <p className="mt-1 text-navy/80">
                    {role.verbs[level].length ? role.verbs[level].join(", ") : "—"}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
