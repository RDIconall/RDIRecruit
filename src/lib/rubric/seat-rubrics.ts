import type { SeatDimension } from "../types";

export const HEAD_CLINICAL_OPS = "78878F5978";
export const PROPOSAL_MANAGER = "D8F97498A4";
export const FOUNDING_ENGINEER = "690A1C7603";
export const CLINICAL_DATA_MANAGER = "379AA16E8F";
export const MONITORING_STANDARDS = "ADF58FBB86";
export const MULTI_ROLE_POOL = "814E984F30";
export const LAB_DIRECTOR = "LAB_DIRECTOR";

export interface BuiltinSeatRubric {
  shortcode: string;
  title: string;
  mission: string;
  dimensions: SeatDimension[];
  gates: string[];
  alternateSeatRules?: string[];
  aliases: RegExp[];
  routingOnly?: boolean;
}

const dim = (
  key: string,
  label: string,
  weight: number,
  description: string,
  evidenceRequirements: string[],
  criticalMinimum?: number,
): SeatDimension => ({
  key,
  label,
  weight,
  description,
  evidenceRequirements,
  ...(criticalMinimum != null ? { criticalMinimum } : {}),
});

export const BUILTIN_SEAT_RUBRICS: BuiltinSeatRubric[] = [
  {
    shortcode: HEAD_CLINICAL_OPS,
    title: "Head of Clinical Operations & Study Delivery",
    mission:
      "Take a difficult clinical study, diagnose the real constraint, recover delivery, and build the clinical operations system so routine CEO/COO intervention is no longer required.",
    aliases: [/head of clinical/i, /head of clinical operations/i, /study delivery/i],
    dimensions: [
      dim("study_diagnosis_rescue", "Study diagnosis & rescue", 20, "Personally entered troubled studies, found the root constraint, changed the plan, and recovered enrollment/timeline/data/site/sample execution.", ["failing study inherited", "root constraint named", "personal decision/change", "measurable recovery"]),
      dim("end_to_end_delivery", "End-to-end clinical delivery ownership", 20, "Owned meaningful portions of protocol, startup, sites, enrollment, monitoring, samples, data, and closeout.", ["timelines", "budgets", "recruitment/sites/vendors", "samples/data/regulatory or quality interfaces"], 8),
      dim("hands_on_depth", "Hands-on clinical operating depth", 15, "Can personally inspect enrollment, site performance, monitoring, consent/source issues, samples, deviations, queries, and closeout readiness.", ["hands-on inspection", "below-title detail", "study-status reality checks"]),
      dim("operating_system_team", "Operating system + team building", 15, "Built or improved clinical teams, standards, dashboards, accountability, and escalation systems from incomplete infrastructure.", ["team build", "process standardization", "dashboard/accountability system", "improved PM/CRA/site/sample/data work"]),
      dim("client_commercial_judgment", "Client + commercial judgment", 10, "Understands scope, budget, timeline, client commitments, change control, and difficult tradeoffs.", ["scope/budget/timeline tradeoff", "client communication", "change control"]),
      dim("decisiveness_adaptability", "Decisiveness + adaptability", 10, "Makes defensible calls with incomplete information and changes course when evidence changes.", ["incomplete-information decision", "course correction", "live validation if evidence is only adjectives"]),
      dim("ivd_site_sample_data", "IVD / site / sample / data integration", 5, "Understands specimen collection, diagnostics, sites, lab workflow, traceability, and downstream data consequences.", ["IVD/site/sample/data integration"]),
      dim("builder_motivation", "Builder motivation / RDI environment", 5, "Evidence candidate wants meaningful ownership and can operate close to the work.", ["builder appetite", "small-company portability", "close-to-work motivation"]),
    ],
    gates: [
      "material misrepresentation or synthetic expertise",
      "unwilling to perform hands-on work",
      "no credible clinical research delivery history",
      "required onsite arrangement cannot be satisfied",
      "verified ego/coachability hard no",
    ],
    alternateSeatRules: [
      "Strong laboratory builders with limited end-to-end CRO study delivery should surface as Laboratory Director rather than disappear.",
    ],
  },
  {
    shortcode: PROPOSAL_MANAGER,
    title: "Proposal Manager - Study Design",
    mission:
      "Turn incomplete client information into a clinical study RDI can sell and deliver: scope, operating model, assumptions, economics, proposal, and follow-through to signature.",
    aliases: [/proposal/i, /study design/i, /commercial scoping/i],
    dimensions: [
      dim("proposal_commercial_scoping", "Demonstrated proposal / commercial scoping ownership", 20, "Personally owned RFP/RFQ responses, SOWs, client proposals, budgets, bid defense, revisions, negotiation, or comparable project scoping.", ["RFP/RFQ/proposal ownership", "SOW/scope ownership", "bid defense/revisions/negotiation"]),
      dim("study_design_modeling", "Study design & operational modeling", 20, "Converts requirements into assumptions, sites, enrollment, recruitment, sample flow, testing workflow, timeline, staffing, and deliverables.", ["operational model", "site/enrollment/recruitment assumptions", "sample/testing/timeline/staffing model"]),
      dim("economics_pricing", "Economics / budget / pricing", 20, "Understands cost drivers, site payments, labor, pass-throughs, margin, pricing, scenarios, scope changes, and tradeoffs.", ["personally built/materially owned budgets or pricing", "cost driver reasoning", "scope/economic tradeoffs"]),
      dim("ambiguity_assumptions", "Ambiguity / assumption judgment", 15, "Separates material unknowns from immaterial ones, makes defensible assumptions, challenges bad assumptions, and keeps work moving.", ["defensible assumptions", "client-clarification judgment", "challenge/reconcile bad inputs"]),
      dim("client_revisions_signature", "Client ownership / revisions / signature", 10, "Handles client questions, revises scope, negotiates tradeoffs, and closes the loop.", ["client questions", "scope revisions", "signature/close-loop ownership"]),
      dim("writing_explanation", "Writing + explanation", 10, "Plain-English explanation of what RDI will do, assumptions, tradeoffs, costs, and responsibilities.", ["plain English", "commercial usefulness", "precision supported by experience"]),
      dim("proposal_system_building", "Proposal system building", 5, "Improves templates, assumptions libraries, pricing models, reusable data, turnaround time, and consistency without bureaucracy.", ["template/model/library improvement", "turnaround/consistency improvement"]),
    ],
    gates: [
      "synthetic expertise or material misrepresentation",
      "cannot work with numbers",
      "cannot reason from incomplete information",
      "no credible commercial/project scoping evidence when presenting as a proposal expert",
      "required onsite arrangement cannot be satisfied",
    ],
  },
  {
    shortcode: FOUNDING_ENGINEER,
    title: "Founding Product Engineer - Clinical Systems",
    mission:
      "Own the technical/product system RDI runs on: understand workflow, decide what to build, code it, ship it, operate it, and remain accountable when it fails.",
    aliases: [/founding product engineer/i, /product engineer/i, /clinical systems engineer/i],
    dimensions: [
      dim("production_system_ownership", "Production system ownership", 25, "Owned consequential production systems with real users and reliability/data/financial/regulatory consequences after launch.", ["production ownership", "real users", "post-launch accountability", "consequential data/financial/regulatory/safety impact"], 1),
      dim("architecture_reliability", "Architecture + reliability", 20, "Evidence of architecture, testing, CI/CD, observability, incidents, migrations, distributed systems, error handling, and production debugging.", ["architecture", "testing/CI/CD", "observability/incidents", "migrations/root cause"]),
      dim("product_user_judgment", "Product / user judgment", 15, "Understands user problems directly and makes workflows materially simpler.", ["direct user problem", "workflow simplification", "product tradeoff"]),
      dim("ambiguous_to_outcome", "Ambiguous problem -> outcome ownership", 15, "Operates without a PM, designer, QA department, or detailed tickets: understands problem, defines solution, ships, and learns.", ["ambiguous brief", "solution definition", "shipped outcome"]),
      dim("technical_breadth", "Technical breadth / full-stack ability", 10, "Enough breadth to own a small-company platform; exact stack match is secondary.", ["full-stack breadth", "unfamiliar code ownership", "small-team platform scope"]),
      dim("ai_stewardship", "AI engineering stewardship", 5, "Uses AI aggressively while verifying output, understanding architecture, testing, and owning consequences.", ["AI use with verification", "model output not treated as authority"]),
      dim("security_data_integrity", "Security / data integrity / consequential systems", 5, "Evidence from healthcare, fintech, payments, identity, regulated, sensitive, safety-critical, or similarly consequential systems.", ["security/data integrity", "regulated/sensitive consequences"]),
      dim("builder_trajectory", "Builder trajectory", 5, "Increasing scope and appetite for whole-system responsibility.", ["increasing scope", "appetite for whole-system ownership"]),
    ],
    gates: [
      "no meaningful coding anymore",
      "requires complete tickets/specifications",
      "unwilling to inherit unfamiliar code",
      "cannot meet onsite requirement",
      "synthetic technical expertise unsupported by career evidence",
      "verified unwillingness to own production consequences",
    ],
  },
  {
    shortcode: CLINICAL_DATA_MANAGER,
    title: "Clinical Data Manager - Data Integrity & Investigation",
    mission:
      "Own the dataset that tells the true story of what happened in the study and investigate every material inconsistency to root cause.",
    aliases: [/clinical data manager/i, /data integrity/i, /data management/i],
    dimensions: [
      dim("data_investigation_root_cause", "Data investigation / root cause", 25, "Personally chased anomalies, discordant results, outliers, drift, transcription/lineage errors, and determined why, not merely what.", ["anomaly/root-cause investigation", "discordance/outlier/drift", "personal diagnosis"]),
      dim("source_verification_reconciliation", "Source verification + reconciliation", 20, "Reconciles source, EDC, lab results, samples, demographics, visit dates, and external data.", ["source/EDC/lab/sample reconciliation", "query resolution", "traceability"]),
      dim("regulated_data_integrity", "Regulated data integrity", 15, "Evidence of ALCOA+, Part 11, SDV, query management, audit trails, traceability, and regulated clinical data.", ["ALCOA+/Part 11/SDV", "audit trail", "regulated data"]),
      dim("database_lock_audit", "Database lock / audit defensibility", 10, "Can own the final dataset and defend why values are correct.", ["database lock", "audit defensibility", "final dataset ownership"]),
      dim("edc_ecrf_raw_data", "EDC / eCRF / edit check / raw data depth", 10, "Hands-on use of EDC/raw data and improvement of collection design to prevent bad data.", ["EDC/eCRF", "edit checks", "raw data"]),
      dim("stats_method_literacy", "Statistical / method-comparison literacy", 10, "Enough quantitative judgment to distinguish signal, artifact, concordance, outlier, and method-comparison issues.", ["signal vs artifact", "method comparison", "quantitative literacy"]),
      dim("truth_telling_judgment", "Truth-telling / cross-functional judgment", 5, "Will state what the data actually shows rather than optimize the story; must be evidence-backed.", ["truth-telling evidence", "cross-functional pressure handled"]),
      dim("system_team_standards", "System / team standard building", 5, "Sets standards for clean data and teaches junior/offshore data team members.", ["standards", "training", "team quality system"]),
    ],
    gates: [
      "material data-integrity misrepresentation",
      "evidence of manipulating interpretation toward desired conclusion",
      "no meaningful regulated clinical-data experience",
      "refuses hands-on data work",
      "cannot meet active onsite requirement",
    ],
  },
  {
    shortcode: MONITORING_STANDARDS,
    title: "Clinical Monitoring Standards Lead",
    mission:
      "Be the master of RDI's monitoring craft: personally capable of the work, able to teach it, inspect it, and build systems that keep every study audit-ready.",
    aliases: [/monitoring standards/i, /principal cra/i, /clinical research associate/i, /clinical monitoring/i],
    dimensions: [
      dim("hands_on_monitoring", "Hands-on monitoring mastery", 25, "Actually monitored studies and can inspect consent, source, CRF, compliance, deviations, queries, reports, and site files.", ["monitoring performed personally", "source/consent/CRF/protocol/deviation inspection", "site file/report quality"]),
      dim("audit_readiness_systems", "Audit readiness / inspection systems", 20, "Maintained or built systems keeping multiple studies inspection-ready.", ["audit prep/inspection response", "TMF/site files/CAPA", "documentation completeness"]),
      dim("monitoring_quality_judgment", "Monitoring quality judgment", 15, "Distinguishes material threats to subject protection, data integrity, protocol compliance, and submission defensibility from checklist noise.", ["risk judgment", "quality materiality", "subject/data/protocol consequences"]),
      dim("teaching_developing_cras", "Teaching / developing CRAs", 15, "Can train, coach, review work, identify weak judgment, and improve junior CRA quality.", ["training/coaching", "work review", "judgment development"]),
      dim("risk_based_monitoring", "Risk-based / modern monitoring", 10, "Understands RBM, centralized review, remote monitoring, targeted SDV/SDR, real-time oversight, and responsible AI assistance.", ["RBM/centralized review", "remote/targeted SDV", "responsible AI assistance"]),
      dim("monitoring_metrics", "Monitoring systems / metrics", 10, "Makes study quality/status visible through cadence, findings, open actions, deviations, queries, risk signals, and audit readiness.", ["monitoring metrics", "quality/status visibility", "open-action system"]),
      dim("ivd_regulatory_depth", "IVD / diagnostic regulatory depth", 5, "IVD experience is a strong advantage, not a substitute for monitoring craft.", ["IVD/diagnostic regulatory understanding"]),
    ],
    gates: [
      "knowledge appears checklist-only",
      "cannot personally perform monitoring work",
      "synthetic regulatory expertise",
      "no credible clinical monitoring history",
      "verified quality/integrity problem",
    ],
  },
  {
    shortcode: LAB_DIRECTOR,
    title: "Laboratory Director / Director of Laboratory Operations",
    mission:
      "Own RDI's clinical laboratory as an operating and technical system: quality, instruments, people, assay implementation, capacity, compliance, troubleshooting, and reliability.",
    aliases: [/laboratory director/i, /lab operations/i, /clinical laboratory/i, /dabcc/i, /lc-ms/i],
    dimensions: [
      dim("lab_leadership", "Clinical laboratory leadership", 20, "Operated consequential clinical laboratory functions.", ["clinical lab operation", "lab leadership", "throughput responsibility"]),
      dim("technical_ivd_depth", "Technical / IVD / clinical chemistry depth", 20, "Can challenge methods, understand assay behavior, troubleshoot, and oversee technical work relevant to RDI's testing scope.", ["IVD/clinical chemistry", "assay behavior", "technical oversight"]),
      dim("quality_system", "CLIA / CAP / quality system ownership", 15, "Owned inspections, proficiency, SOPs, QC/QA, deviations, corrective action, and regulatory readiness.", ["CLIA/CAP/quality system", "inspection/proficiency", "SOP/QC/QA/CAPA"]),
      dim("instrument_validation_transfer", "Instrumentation / validation / technology transfer", 15, "Implemented analyzers, validation, method transfer, IQ/OQ/PQ where applicable, assay rollout, multi-site transfer, or instrument standardization.", ["instrument implementation", "validation/method transfer", "multi-site standardization"]),
      dim("lab_operations_capacity", "Lab operations / capacity / workflow", 10, "Can make a physical lab run: throughput, staffing, scheduling, maintenance, supplies, turnaround, and bottlenecks.", ["capacity/workflow", "staffing/scheduling", "maintenance/supplies/TAT"]),
      dim("people_training_standards", "People / training / standard setting", 10, "Builds technicians/scientists and maintains technical standards.", ["training", "technical standard setting", "team development"]),
      dim("root_cause_troubleshooting", "Root cause / troubleshooting", 5, "Personally investigates things that do not behave as expected.", ["technical root cause", "hands-on troubleshooting"]),
      dim("economics_vendors_assets", "Economics / vendors / asset judgment", 5, "Understands maintenance costs, instrument decisions, vendors, make/buy, and capacity economics.", ["vendor/instrument decision", "capacity economics", "maintenance cost"]),
    ],
    gates: [
      "licensing/regulatory eligibility unresolved where required",
      "material quality/integrity concern",
      "unwillingness to remain close to work",
      "synthetic technical expertise",
    ],
  },
  {
    shortcode: MULTI_ROLE_POOL,
    title: "We are hiring across multiple roles",
    mission:
      "Routing and talent-pool entry point. Evaluate person quality, strongest demonstrated capabilities, and best matches against active RDI seats; do not invent a fake seat-fit score.",
    aliases: [/multiple roles/i, /talent pool/i, /hiring across/i],
    routingOnly: true,
    dimensions: [
      dim("person_quality", "Person quality", 35, "Quality of demonstrated judgment, ownership, integrity, progression, and current capability.", ["demonstrated judgment", "ownership", "integrity", "progression"]),
      dim("strongest_capabilities", "Strongest demonstrated capabilities", 25, "What the person has actually done that transfers into an RDI seat.", ["verified capabilities", "transferable work"]),
      dim("best_active_seat_match", "Best active seat match", 25, "Evidence overlap with real active RDI seat rubrics.", ["matched active seat", "specific evidence overlap"]),
      dim("open_risks_to_verify", "Open risks to verify", 15, "Missing proof, gates, compensation/logistics, or live-validation questions that control routing.", ["unproven areas", "gates/logistics", "live verification"]),
    ],
    gates: ["material misrepresentation or synthetic expertise", "no job-relevant evidence", "cannot meet non-negotiable role constraints"],
  },
];

export function isGenericMultiRoleShortcode(shortcode: string | null | undefined): boolean {
  return shortcode === MULTI_ROLE_POOL;
}

export function getBuiltinSeatRubric(input: {
  shortcode?: string | null;
  title?: string | null;
}): BuiltinSeatRubric | null {
  const shortcode = input.shortcode?.trim();
  if (shortcode) {
    const byCode = BUILTIN_SEAT_RUBRICS.find((r) => r.shortcode === shortcode);
    if (byCode) return byCode;
  }
  const title = input.title ?? "";
  return BUILTIN_SEAT_RUBRICS.find((r) => r.aliases.some((rx) => rx.test(title))) ?? null;
}

export function dimensionsWeightTotal(dimensions: SeatDimension[]): number {
  return dimensions.reduce((sum, d) => sum + d.weight, 0);
}

export function seatRubricMarkdown(rubric: BuiltinSeatRubric): string {
  const dimensions = rubric.dimensions
    .map((d, index) => {
      const critical = d.criticalMinimum != null ? `\nCRITICAL: below ${d.criticalMinimum}/${d.weight} caps below Interview-First.` : "";
      const evidence = d.evidenceRequirements.map((e) => `- ${e}`).join("\n");
      return `${index + 1}. ${d.label.toUpperCase()} - ${d.weight}\n\n${d.description}\n\nEvidence requirements:\n${evidence}${critical}`;
    })
    .join("\n\n");
  const gates = rubric.gates.map((g) => `- ${g}`).join("\n");
  const alternates = rubric.alternateSeatRules?.length
    ? `\n\n## Alternate-seat rules\n${rubric.alternateSeatRules.map((r) => `- ${r}`).join("\n")}`
    : "";
  const routing = rubric.routingOnly
    ? "\n\nROUTING ONLY: do not treat this posting as a specific seat. Use the best verified active-seat match for ranking and explain the routing."
    : "";

  return `# ${rubric.title}\n\nSHORTCODE: ${rubric.shortcode}\n\nSCHEMA: seat-dimensions-v2\n\n## Mission\n\n${rubric.mission}${routing}\n\n## Dimensions\n\n${dimensions}\n\n## Gates\n\n${gates}${alternates}\n\n## Output requirements\n\nSeparate person quality, seat fit, evidence confidence, integrity/authenticity gates, alternate-seat signals, RO diagnostic, and live-validation questions. Do not let polished prose unsupported by career evidence become capability credit.`;
}

export function alternateSeatRubricBlock(appliedShortcode: string | null | undefined): string {
  const seats = BUILTIN_SEAT_RUBRICS.filter(
    (r) => r.shortcode !== appliedShortcode && r.shortcode !== MULTI_ROLE_POOL,
  );
  return seats
    .map((r) => {
      const dims = r.dimensions.map((d) => `${d.label} (${d.weight})`).join("; ");
      return `- ${r.title} [${r.shortcode}]: ${r.mission} Dimensions: ${dims}`;
    })
    .join("\n");
}
