"use client";

import { CSSProperties } from "react";
import { ink } from "@/lib/triage/theme";

// Lightweight, glanceable data viz — thin bars and a tiny bar sparkline, in
// keeping with the "living briefing document" look. Color carries meaning only.

export function ProgressBar({
  value,
  max,
  color,
  height = 6,
  track = ink(0.08),
  rounded = true,
}: {
  value: number;
  max: number;
  color: string;
  height?: number;
  track?: string;
  rounded?: boolean;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div
      style={{
        width: "100%",
        height,
        background: track,
        borderRadius: rounded ? 9999 : 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct * 100}%`,
          height: "100%",
          background: color,
          borderRadius: rounded ? 9999 : 0,
          transition: "width 240ms ease",
        }}
      />
    </div>
  );
}

export interface Segment {
  value: number;
  color: string;
  label?: string;
}

// A single thin stacked bar that encodes a composition (e.g. pool funnel).
export function SegmentBar({
  segments,
  height = 10,
  gap = 2,
}: {
  segments: Segment[];
  height?: number;
  gap?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div style={{ display: "flex", gap, width: "100%", height }}>
      {segments
        .filter((s) => s.value > 0)
        .map((s, i) => (
          <div
            key={i}
            title={s.label ? `${s.label}: ${s.value}` : String(s.value)}
            style={{
              flex: `${(s.value / total) * 100} 0 0`,
              minWidth: 3,
              background: s.color,
              borderRadius: 3,
              transition: "flex-grow 240ms ease",
            }}
          />
        ))}
    </div>
  );
}

// Tiny "burn"-style bar sparkline for a short numeric series (e.g. an RO
// stratum trajectory across roles). Bars grow from a shared baseline.
export function BarSparkline({
  values,
  color,
  height = 26,
  barWidth = 7,
  gap = 3,
  track = ink(0.06),
  style,
}: {
  values: number[];
  color: string;
  height?: number;
  barWidth?: number;
  gap?: number;
  track?: string;
  style?: CSSProperties;
}) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap, height, ...style }}>
      {values.map((v, i) => {
        const h = Math.max(3, (v / max) * height);
        return (
          <div
            key={i}
            style={{ width: barWidth, height, display: "flex", alignItems: "flex-end", borderRadius: 3, background: track }}
          >
            <div style={{ width: "100%", height: h, background: color, borderRadius: 3 }} />
          </div>
        );
      })}
    </div>
  );
}
