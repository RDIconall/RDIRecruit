"use client";

import { CSSProperties, useEffect, useRef, useState } from "react";
import {
  APP,
  DECISION_LABEL,
  valueDot,
  verdictDot,
  describeMissingInputs,
} from "@/lib/triage/app-theme";
import { standingLabel } from "@/lib/triage/ranking";
import type { Candidate, Decision, ValueRead, VerdictRead } from "@/lib/triage/types";

export const DECISION_OPTIONS: Decision[] = ["interview", "backup", "reject", "blocked"];

export const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: APP.mono, ...extra });
export const ellipsis: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

/**
 * Compacts a raw salary ask into a tight column-friendly form:
 * "$145,000-$160,000" → "$145–160k", "$130K" → "$130k", "$70,000" → "$70k".
 * Falls back to the raw string (truncated by the cell) when it can't parse.
 */
export function compactAsk(raw: string | null | undefined): string {
  if (!raw) return "—";
  if (/[mb]/i.test(raw)) return raw; // leave millions/billions untouched
  const nums = raw.match(/\d[\d,]*/g);
  if (!nums) return raw;
  const toK = (s: string): number | null => {
    const n = parseInt(s.replace(/,/g, ""), 10);
    if (!Number.isFinite(n)) return null;
    return n >= 1000 ? Math.round(n / 1000) : n;
  };
  const vals = nums.map(toK).filter((n): n is number => n != null);
  if (vals.length === 0) return raw;
  if (vals.length >= 2) return `$${vals[0]}–${vals[1]}k`;
  return `$${vals[0]}k`;
}

/**
 * Sub-line under a candidate's name: when the read is blocked, says exactly what
 * grading is waiting on; otherwise shows the ordinal pool standing ("3rd of 12
 * interview-ready"). Ordinal only — never a numeric score.
 */
export function StandingLine({ c }: { c: Candidate }) {
  if (c.decision === "blocked" && c.readiness && !c.readiness.ready) {
    if (c.readiness.resumeMissingFromSource) {
      return (
        <div
          style={mono({ fontSize: 11, color: APP.weak, lineHeight: 1.3, ...ellipsis })}
          title="Review blocked — no résumé on file in Workable, nothing to grade"
        >
          Blocked · no résumé on file
        </div>
      );
    }
    return (
      <div
        style={mono({ fontSize: 11, color: APP.weak, lineHeight: 1.3, ...ellipsis })}
        title={`Review blocked — waiting on ${describeMissingInputs(c.readiness.missing)}`}
      >
        Blocked · waiting on {describeMissingInputs(c.readiness.missing)}
      </div>
    );
  }
  // For the do-not-interview list, surface WHY so the reason is visible at a glance.
  if (c.decision === "reject") {
    const reason = c.cutReason || c.why;
    if (reason) {
      return (
        <div style={mono({ fontSize: 11, color: APP.weak, lineHeight: 1.3, ...ellipsis })} title={reason}>
          {reason}
        </div>
      );
    }
  }
  // Surface the verify-first caveat as a sub-line where present.
  if (c.caveat) {
    return (
      <div style={mono({ fontSize: 11, color: APP.secondary, lineHeight: 1.3, ...ellipsis })} title={c.caveat}>
        Confirm: {c.caveat}
      </div>
    );
  }
  const label = standingLabel(c.standing);
  if (!label) return null;
  return (
    <div style={mono({ fontSize: 11, color: APP.faint, lineHeight: 1.3, ...ellipsis })} title={`Pool standing: ${label}`}>
      {label}
    </div>
  );
}

export function ValueCell({ value }: { value: ValueRead | undefined }) {
  if (!value || value.level === "none") {
    return <span style={mono({ fontSize: 12, color: "#C9C9C9" })}>—</span>;
  }
  const d = valueDot(value.level);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }} title={value.detail || value.headline}>
      <span style={{ width: 8, height: 8, borderRadius: 9999, flexShrink: 0, background: d.fill, border: `1.5px solid ${d.color}` }} />
      <span style={{ fontSize: 13, color: d.color, ...ellipsis }}>{value.headline}</span>
    </div>
  );
}

/**
 * Accessible checkbox — a real <input type="checkbox"> styled with the app accent,
 * with indeterminate support for the header "select all" control. Stops click
 * propagation so ticking a row doesn't also open the candidate.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      onChange={onChange}
      style={{ width: 15, height: 15, accentColor: APP.accent, cursor: "pointer", margin: 0 }}
    />
  );
}

/**
 * Candidate avatar — renders the Workable profile photo (raw.image_url) when one
 * is on file, falling back to the deterministic initials tint when absent or when
 * the image fails to load.
 */
export function Avatar({ c, size = 30 }: { c: Candidate; size?: number }) {
  const [broken, setBroken] = useState(false);
  const showPhoto = !!c.photoUrl && !broken;
  if (showPhoto) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote Workable CDN photos, no domain allowlist
      <img
        src={c.photoUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBroken(true)}
        style={{ width: size, height: size, borderRadius: 9999, objectFit: "cover", background: APP.hair, flexShrink: 0, display: "block" }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        background: c.avatarColor,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size <= 22 ? 9 : 10,
        fontWeight: 600,
        fontFamily: APP.mono,
        flexShrink: 0,
      }}
      aria-hidden
    >
      {c.initials}
    </div>
  );
}

export function Dot({ read }: { read: VerdictRead }) {
  const d = verdictDot(read.level);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: 9999, flexShrink: 0, background: d.fill, border: `1.5px solid ${d.color}` }} />
      <span style={{ fontSize: 13, color: d.color, ...ellipsis }}>{read.label}</span>
    </div>
  );
}

export function StatusSelect({ value, onChange }: { value: Decision; onChange: (d: Decision) => void }) {
  return (
    <select
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        onChange(e.target.value as Decision);
      }}
      aria-label="Set status manually"
      title="Set status manually"
      style={mono({ fontSize: 11.5, color: APP.ink, background: APP.surface, border: `1px solid ${APP.hair}`, borderRadius: 4, padding: "3px 6px", cursor: "pointer", maxWidth: 120 })}
    >
      {DECISION_OPTIONS.map((d) => (
        <option key={d} value={d}>
          {DECISION_LABEL[d]}
        </option>
      ))}
    </select>
  );
}

export function DisqButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ cursor: "pointer", background: "transparent", color: APP.weak, border: `1px solid ${APP.weakBorder}`, borderRadius: 4, padding: "4px 9px", fontSize: 11.5, fontWeight: 500, whiteSpace: "nowrap" }}
    >
      Disqualify
    </button>
  );
}
