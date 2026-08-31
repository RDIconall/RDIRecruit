import Link from "next/link";
import { RADAR_DISABLED_MESSAGE } from "@/lib/radar/enabled";

export const dynamic = "force-dynamic";

/** Talent Radar product surface — currently hard-disabled to stop Claude spend. */
export default function RadarPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 32,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        background: "#f7f5f1",
        color: "#1c1917",
      }}
    >
      <div style={{ maxWidth: 480, textAlign: "center" }}>
        <p style={{ margin: 0, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase", color: "#78716c" }}>
          Talent Radar
        </p>
        <h1 style={{ margin: "8px 0 12px", fontSize: 28, fontWeight: 700 }}>Turned off</h1>
        <p style={{ margin: "0 0 24px", lineHeight: 1.5, color: "#44403c" }}>{RADAR_DISABLED_MESSAGE}</p>
        <Link href="/" style={{ color: "#1c1917", fontWeight: 600 }}>
          Back to triage
        </Link>
      </div>
    </main>
  );
}
