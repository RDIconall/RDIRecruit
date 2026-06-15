"use client";

import { createContext, useContext } from "react";
import type { Candidate, JobOption, PoolMeta } from "@/lib/triage/types";
import type { Viewer } from "@/lib/triage/reviewer";

export interface TriageData {
  candidates: Candidate[];
  meta: PoolMeta;
  jobs: JobOption[];
  /** The signed-in reviewer (Clerk-derived) — seeds the corrections reviewer picker (#7). */
  viewer: Viewer;
  findCandidate: (id: string) => Candidate | undefined;
}

const TriageDataContext = createContext<TriageData | null>(null);

export function TriageDataProvider({
  value,
  children,
}: {
  value: TriageData;
  children: React.ReactNode;
}) {
  return <TriageDataContext.Provider value={value}>{children}</TriageDataContext.Provider>;
}

export function useTriageData(): TriageData {
  const ctx = useContext(TriageDataContext);
  if (!ctx) throw new Error("useTriageData must be used within a TriageDataProvider");
  return ctx;
}
