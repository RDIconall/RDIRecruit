"use client";

// Unauthenticated visual-inspection harness for the pool data grid. Renders the
// REAL <PoolTable> with synthetic, deliberately-messy data (full addresses,
// salary asks with notes, long caveats) so the column normalizers and layout can
// be screenshotted without Clerk auth or live Supabase data. Mock data only.

import { useState } from "react";
import type { RowSelectionState } from "@tanstack/react-table";
import { PoolTable } from "@/components/triage/pool-table";
import { cityState } from "@/lib/triage/format";
import { avatarColor, initialsOf } from "@/lib/triage/app-theme";
import type { Candidate, Decision, ValueLevel, VerdictLevel } from "@/lib/triage/types";

let seq = 0;
function mock(p: {
  name: string;
  role: string;
  company: string;
  rawLocation: string;
  rawSalary: string;
  decision: Decision;
  valueLevel: ValueLevel;
  valueHeadline: string;
  answers: VerdictLevel;
  spec: VerdictLevel;
  roLevel: string;
  experience: string;
  groupRank?: number;
  groupTotal?: number;
  caveat?: string;
  cutReason?: string;
}): Candidate {
  const id = `mock-${++seq}`;
  return {
    id,
    rank: seq,
    name: p.name,
    role: p.role,
    company: p.company,
    appliedAt: seq === 1 ? new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() : new Date(Date.now() - seq * 86_400_000).toISOString(),
    salary: p.rawSalary,
    salaryNum: 0,
    decision: p.decision,
    rev: "none",
    revNote: "",
    why: p.cutReason ?? "",
    flag: "",
    next: "",
    survivor: p.decision === "interview",
    value: { headline: p.valueHeadline, level: p.valueLevel, detail: "Synthetic strength-vs-salary read for layout preview." },
    caveat: p.caveat,
    askTier: "mid",
    askNote: "",
    roLevel: p.roLevel,
    roVsPool: "—",
    mismatch: false,
    mismatchRead: "",
    timeline: [],
    cover: { hasLetter: false, lines: [] },
    answers: [],
    logistics: { mode: "—", location: "—", distance: "—", likelihood: "—", read: "—", signals: [] },
    redFlags: [],
    resume: { hasResume: false, roles: [] },
    workableUrl: "#",
    initials: initialsOf(p.name),
    avatarColor: avatarColor(id),
    locationShort: cityState(p.rawLocation),
    experience: p.experience,
    answersRead: { label: p.answers === "strong" ? "Strong" : p.answers === "weak" ? "Thin" : p.answers === "none" ? "—" : "Mixed", level: p.answers },
    specRead: { label: p.spec === "strong" ? "Strong fit" : p.spec === "weak" ? "Weak fit" : p.spec === "none" ? "—" : "Partial fit", level: p.spec },
    standing:
      p.groupRank && p.groupTotal
        ? { overallRank: seq, activeTotal: 11, groupRank: p.groupRank, groupTotal: p.groupTotal, groupLabel: groupLabel(p.decision) }
        : undefined,
  };
}

function groupLabel(d: Decision): string {
  return d === "interview" ? "to interview" : d === "backup" ? "in the backup group" : d === "reject" ? "on the do-not-interview list" : "blocked";
}

const CANDIDATES: Candidate[] = [
  mock({ name: "Joe Rogers", role: "Executive Assistant", company: "Capital Group", rawLocation: "1200 Wilshire Blvd Apt 14, Pasadena, California 91101, USA", rawSalary: "$110,000-$130,000", decision: "interview", valueLevel: "strong", valueHeadline: "Strong operator, fair ask", answers: "strong", spec: "strong", roLevel: "IIb", experience: "20 yr", groupRank: 1, groupTotal: 2, caveat: "Confirm the Capital Group / City of Rice overlap — +17 months concurrent on the resume as written; was one role part-time or contract." }),
  mock({ name: "Krystal Morris", role: "Executive Assistant", company: "Behavioral Education Inc.", rawLocation: "Los Angeles, California", rawSalary: "$118k", decision: "interview", valueLevel: "fair", valueHeadline: "Solid operator, fair ask", answers: "weak", spec: "mixed", roLevel: "IIb", experience: "18 yr", groupRank: 2, groupTotal: 2, caveat: "Confirm real reason for leaving GingerLevak after 18 months and why she stepped down to a director-level role." }),
  mock({ name: "Yasmina Boubess", role: "Executive Assistant", company: "HOSPITAL REVAMP", rawLocation: "400 Hacker Blvd Ste 200, San Diego, CA 92101", rawSalary: "—", decision: "backup", valueLevel: "fair", valueHeadline: "Solid executive, fair ask", answers: "weak", spec: "mixed", roLevel: "IIb", experience: "16 yr", caveat: "Salary expectation not stated — must be confirmed before any interview. The 16-month gap (mid-2017 to late-2019) must be explained." }),
  mock({ name: "Polin Yehyavi", role: "Program Manager and Executive Assistant", company: "Micro Medical Devices", rawLocation: "California", rawSalary: "$120k (excluding $110-135k stated range)", decision: "backup", valueLevel: "fair", valueHeadline: "Operates average, fair ask", answers: "weak", spec: "mixed", roLevel: "IIa", caveat: "Salary expectation not stated — confirm it before an interview.", experience: "14 yr" }),
  mock({ name: "Heidi Hintz", role: "Executive Assistant", company: "Dole Food Company", rawLocation: "4717 E Los Angeles Ave, Simi Valley, CA 93063", rawSalary: "$112k", decision: "backup", valueLevel: "weak", valueHeadline: "Thin candidate, rich ask", answers: "weak", spec: "weak", roLevel: "IIb", experience: "30+ yr", caveat: "Before any interview, confirm the Solo Group principal role actually was, and why the stack is so generalist." }),
  mock({ name: "Lauren Pizzi", role: "Interim Associate", company: "Original Producers", rawLocation: "Los Angeles, California, United States", rawSalary: "$100-135k", decision: "reject", valueLevel: "weak", valueHeadline: "Overpriced for the level", answers: "mixed", spec: "weak", roLevel: "TTa", experience: "6 yr", cutReason: "A long career of misdirection (PR/comms) followed by a one-year creative production stint; the seat needs a steadier operator." }),
  mock({ name: "Brandon Frank", role: "Marketing Manager", company: "Sleepgram & Zoham", rawLocation: "California, United States", rawSalary: "$100-175k", decision: "reject", valueLevel: "weak", valueHeadline: "Role mismatch at any ask", answers: "mixed", spec: "weak", roLevel: "TTa", experience: "7 yr", cutReason: "Career is marketing/brand — adjacent but not executive support; misaligned with the spec." }),
  mock({ name: "Lacianno Hill", role: "Residential Assistant", company: "—", rawLocation: "11126 Aqua Vista St Apt 3, Studio City, CA 91602", rawSalary: "$100-135k", decision: "reject", valueLevel: "weak", valueHeadline: "Overpriced for the level", answers: "none", spec: "none", roLevel: "I", experience: "26 yr", cutReason: "Resume is single-employer hospitality; no executive-support depth for the ask." }),
  mock({ name: "Kimberly Stephens", role: "Administrative Office Assistant", company: "Cessleth Plastic Surgery", rawLocation: "Beverly Hills, CA", rawSalary: "$95-105k", decision: "reject", valueLevel: "weak", valueHeadline: "Below spec for the ask", answers: "weak", spec: "weak", roLevel: "TTa", experience: "5 yr", cutReason: "Front-desk / scheduling background; the spec calls for chief-of-staff-level support." }),
  mock({ name: "Natalie Gurevich", role: "Account Services Coordinator", company: "Steve Madden", rawLocation: "New York, New York", rawSalary: "$125k", decision: "reject", valueLevel: "weak", valueHeadline: "Overpriced for the level", answers: "mixed", spec: "weak", roLevel: "I", experience: "25 yr", cutReason: "Coordinator-level scope; not enough autonomous executive support for the band." }),
  mock({ name: "Devon Park", role: "Chief of Staff", company: "Northwind Health", rawLocation: "Remote", rawSalary: "$140000 to 160000 negotiable", decision: "blocked", valueLevel: "none", valueHeadline: "No read yet", answers: "none", spec: "none", roLevel: "—", experience: "—" }),
];

export default function PoolTablePreview() {
  const [sel, setSel] = useState<RowSelectionState>({});
  return (
    <div style={{ minHeight: "100vh", background: "#fff", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif", color: "#1A1A1A" }}>
      <div style={{ height: 54, borderBottom: "1px solid #E6E6E6", display: "flex", alignItems: "center", padding: "0 28px", position: "sticky", top: 0, background: "#fff", zIndex: 40, fontWeight: 700 }}>
        RDIRecruit · table preview (mock data)
      </div>
      <div style={{ padding: "24px 28px 90px" }}>
        <PoolTable
          active={CANDIDATES}
          rowSelection={sel}
          onRowSelectionChange={setSel}
          openCandidate={() => {}}
          onDisqualify={() => {}}
          onSetDecision={() => {}}
          syncUrl={false}
        />
      </div>
    </div>
  );
}
