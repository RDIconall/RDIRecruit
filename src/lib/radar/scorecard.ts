import type { Pipeline, ScoreDimensionDef } from "./types";

// RDI's private scorecard for the Clinical Operations Lead / Study Control Lead
// role. Each dimension is scored 1-5 by the LLM. Weights sum to 1.00. The final
// dimension is a RISK (higher = worse) and is subtracted, not added.
export const RECRUITING_DIMENSIONS: ScoreDimensionDef[] = [
  {
    key: "small_cro_sponsor",
    label: "Small-CRO / sponsor-side ops",
    weight: 0.18,
    basis: "Clinical operations at a small CRO or sponsor-side (not just large-CRO process roles).",
  },
  {
    key: "site_startup",
    label: "Site startup / activation",
    weight: 0.14,
    basis: "Owned site identification, qualification, contracts/budgets, IRB, activation timelines.",
  },
  {
    key: "monitoring_query",
    label: "Monitoring / query / data readiness",
    weight: 0.14,
    basis: "Monitoring, query resolution, source data verification, database-lock / inspection readiness.",
  },
  {
    key: "sample_lab",
    label: "Sample-heavy / lab-connected",
    weight: 0.12,
    basis: "Studies with heavy specimen logistics, biorepository, central/local lab coordination.",
  },
  {
    key: "ivd_dx",
    label: "IVD / diagnostics",
    weight: 0.12,
    basis: "In-vitro diagnostics or diagnostic device studies (assay validation, clinical performance).",
  },
  {
    key: "hands_on_ambiguity",
    label: "Hands-on in ambiguity",
    weight: 0.12,
    basis: "Built process where none existed; executed directly in scrappy, under-resourced settings.",
  },
  {
    key: "sponsor_comms",
    label: "Sponsor-facing communication",
    weight: 0.1,
    basis: "Credible communicating with sponsors / clients / executives; can own the relationship.",
  },
  {
    key: "la_relocation",
    label: "LA-based / relocation plausible",
    weight: 0.08,
    basis: "Already in greater LA, or a realistic relocation (ties, prior moves, stated openness).",
  },
  {
    key: "big_company_risk",
    label: "Big-company / process-only risk",
    weight: 0.0,
    isRisk: true,
    basis: "Risk the person is only a large-org process operator who needs structure to function.",
  },
];

export const RECRUITING_SCORECARD_MD = `# RDI Clinical Operations Lead — Sourcing Scorecard

We are sourcing a **Clinical Operations Lead / Study Control Lead** for a small,
fast-moving, IVD/diagnostics-oriented sponsor. We need an operator who can run
clinical execution hands-on in an ambiguous, under-resourced environment — NOT a
large-CRO process administrator who needs a machine around them.

Score each dimension 1-5 (5 = strong evidence, 1 = none / contrary evidence):

1. **Small-CRO / sponsor-side ops** — clinical operations at a small CRO or on the
   sponsor side. Large-CRO line roles score lower unless they show real ownership.
2. **Site startup / activation** — owned site selection, contracts/budgets, IRB,
   and activation timelines end to end.
3. **Monitoring / query / data readiness** — monitoring, query resolution, SDV,
   database lock, and inspection/audit readiness.
4. **Sample-heavy / lab-connected** — specimen logistics, biorepository, central
   or local lab coordination in their studies.
5. **IVD / diagnostics** — in-vitro diagnostics or diagnostic device studies
   (assay validation, clinical performance, companion dx).
6. **Hands-on in ambiguity** — has built process where none existed and executed
   directly when the org was scrappy and under-resourced.
7. **Sponsor-facing communication** — credible owning sponsor/client/executive
   communication.
8. **LA-based / relocation plausible** — in greater Los Angeles, or relocation is
   realistic given their history and stated openness.
9. **Big-company / process-only risk (RISK)** — score HIGH when the person looks
   like a large-org process operator who only thrives with heavy structure. This
   is a concern, not a strength: a high score here pulls the recommendation down.

Be evidence-based and skeptical. A polished title at a big pharma/CRO is not, by
itself, evidence of the hands-on execution this role needs.`;

// A lightweight default BD scorecard so the same engine serves BD outreach.
export const BD_DIMENSIONS: ScoreDimensionDef[] = [
  { key: "ivd_dx", label: "IVD / diagnostics relevance", weight: 0.25, basis: "Works in IVD/diagnostics where RDI's services apply." },
  { key: "forward_demand", label: "Forward demand", weight: 0.25, basis: "Funding, hiring, pipeline, US entry, trial roadmap signals." },
  { key: "decision_access", label: "Decision-maker access", weight: 0.2, basis: "Seniority/role gives real access to clinical/dev decisions." },
  { key: "service_fit", label: "RDI service fit", weight: 0.2, basis: "A serviceable need RDI's clinical/lab modules address." },
  { key: "warmth", label: "Relationship warmth", weight: 0.1, basis: "Prior contact, mutual connections, or warm intro path." },
];

export const BD_SCORECARD_MD = `# RDI BD Outreach — Contact Fit Scorecard

Score each dimension 1-5 for how worth pursuing this contact is for RDI business
development (clinical trial + lab services to IVD/diagnostics sponsors):

1. **IVD / diagnostics relevance** — are they in a diagnostics/IVD context RDI serves?
2. **Forward demand** — signals of upcoming trial/lab need (funding, hiring, pipeline, US entry).
3. **Decision-maker access** — does their role/seniority give access to the relevant decision?
4. **RDI service fit** — is there a concrete, serviceable need RDI's modules address?
5. **Relationship warmth** — any warm path in (prior contact, mutuals, referral).`;

export function dimensionsFor(pipeline: Pipeline): ScoreDimensionDef[] {
  return pipeline === "bd" ? BD_DIMENSIONS : RECRUITING_DIMENSIONS;
}

export function defaultScorecard(pipeline: Pipeline): { name: string; content: string; dimensions: ScoreDimensionDef[] } {
  if (pipeline === "bd") {
    return { name: "RDI BD Outreach — Contact Fit", content: BD_SCORECARD_MD, dimensions: BD_DIMENSIONS };
  }
  return { name: "RDI Clinical Operations Lead — Sourcing", content: RECRUITING_SCORECARD_MD, dimensions: RECRUITING_DIMENSIONS };
}

/**
 * Weighted overall on a 1-5 scale. Risk dimensions are inverted (a 5 on a risk
 * dimension counts like a 1) so a high risk drags the overall down. Risk
 * dimensions with weight 0 still influence via a fixed penalty band.
 */
export function computeOverall(dims: { score: number; weight: number; isRisk?: boolean }[]): number | null {
  if (!dims.length) return null;
  let weighted = 0;
  let weightSum = 0;
  let riskPenalty = 0;
  for (const d of dims) {
    if (d.isRisk) {
      // Zero-weighted risk: apply a penalty proportional to how high the risk is.
      // score 1 -> 0 penalty, score 5 -> -1.0 on the final 1-5 scale.
      riskPenalty += ((d.score - 1) / 4) * (d.weight > 0 ? d.weight : 1.0);
      if (d.weight > 0) weightSum += d.weight;
      if (d.weight > 0) weighted += (6 - d.score) * d.weight;
      continue;
    }
    weighted += d.score * d.weight;
    weightSum += d.weight;
  }
  if (weightSum === 0) return null;
  const base = weighted / weightSum;
  const out = Math.max(1, Math.min(5, base - riskPenalty));
  return Math.round(out * 10) / 10;
}
