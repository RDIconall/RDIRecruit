import "server-only";
import { getActiveRubricMarkdown } from "@/app/actions/rubrics";
import { getJobByShortcode } from "../jobs/service";

/**
 * Per-role hiring rubrics, fed to the triage model as SEAT CALIBRATION (not an
 * output contract). Each rubric is calibration-only: it shapes what ownership and
 * fit look like for that specific seat, but never changes the JSON output contract
 * or the six-value decision vocabulary (interview/short/verify/hold/cut/blocked).
 *
 * Resolution order in getRoleCalibration():
 *   1. an in-app saved rubric for this job_shortcode (rubrics table) wins, so
 *      future edits/uploads override the seed; then
 *   2. the built-in seed below, matched by EXPLICIT job_shortcode first, then by
 *      title regex.
 *
 * The default CDM pool (379AA16E8F) MUST resolve to the Clinical Data Manager
 * rubric and never to Principal CRA — shortcode matching guarantees this.
 */

const EXEC_ASSISTANT = `# RDI Hiring Rubric: Executive Assistant / Executive Operations

## Purpose

Use this rubric to decide the next recruiting action for an Executive Assistant / Executive Operations candidate.

Do not score the candidate.

This role is not a traditional calendar-only EA role. RDI needs someone who reduces CEO cognitive load, closes open loops, protects time, follows through without reminders, and takes practical operational work off the CEO's plate.

The core question:

Will this person reduce the CEO's cognitive load within 30 days, or become another person the CEO has to manage?

## What Ownership Looks Like

Strong candidates:
- Supported one demanding CEO, founder, owner, principal, or managing partner deeply
- Owned calendar, inbox, follow-up, meeting prep, travel, and logistics
- Closed loops without needing reminders
- Drafted clear communications in a principal's voice
- Handled unglamorous work without status friction
- Noticed loose ends and acted
- Built simple systems to prevent recurring problems
- Became more useful over time by learning the principal's patterns

Weak candidates:
- Only coordinated calendars
- Supported many executives shallowly
- Mostly office manager or admin coordinator
- Wants Chief of Staff / strategy more than EA execution
- Needs constant clarification
- Escalates routine decisions
- Sends polished updates but does not close the loop
- Requires the CEO to remember what they are supposed to remember

## Resume Signals

Strong:
- Primary EA to CEO/founder/principal
- Inbox/calendar ownership
- Executive drafting
- Follow-up tracking
- Meeting prep
- Travel/logistics ownership
- Small company, founder-led, private office, professional services, healthcare, biotech, legal, investment, or other demanding environment
- Evidence of increasing trust/responsibility

Weak:
- Generic admin support
- Team assistant across many executives
- Office manager with little principal support
- Event planning/luxury/high-profile proximity without ownership
- Duties/tools listed but no outcomes
- Big-company-only support with clean structure and no messy ownership

## Writing Signals

Strong writing is direct, short, specific, practical, and low-fluff.

Weak writing is vague, apologetic, corporate, inflated, overly emotional, or sounds AI-generated.

## Decision Guidance

Use interview (Leadership Interview) when:
- Clear evidence of deep principal support and closing open loops
- Strong writing
- No obvious logistics blocker

Use short (HR Screen) when:
- Candidate is plausible but ownership depth needs HR confirmation
- HR must confirm direct principal support, follow-through ownership, motivation, and comfort with unglamorous work

Use verify (Targeted Follow-Up / Video Question) when:
- One specific gate is unclear: onsite, compensation, direct CEO support, inbox ownership, writing experience

Use hold when:
- Candidate is plausible but not compelling; revisit only if pool weakens

Use cut (Reject) when:
- Low-effort application, generic writing, no ownership evidence, wrong motivation, coordinator profile, or role misfit

Use blocked only when:
- Materials are missing/corrupted or role/candidate cannot be evaluated

## HR Screen Confirmation

If decision is short, tell HR exactly what to confirm. Common HR screen targets:
- Did they personally own one principal's calendar/inbox/follow-up end to end?
- Can they give an example of reducing a principal's cognitive load?
- Are they comfortable with tactical/unsexy work?
- Do they want EA execution, not strategy/title?
- Can they work onsite and within compensation range?

## Targeted Video / Follow-Up Questions

Use for verify.

Examples:
- "Give one example of a category of work your principal stopped thinking about because you took it over."
- "Have you directly owned inbox triage and drafting for a CEO/principal? What did you send without approval?"
- "This role includes unglamorous work: chasing follow-ups, logistics, errands, vendors, and fixing small messes. What parts have you personally owned?"
`;

const CLINICAL_DATA_MANAGER = `# RDI Hiring Rubric: Clinical Data Manager

## Purpose

Use this rubric to decide the next recruiting action for a Clinical Data Manager candidate.

Do not score the candidate.

RDI is not looking for someone who merely held the same title before. RDI is not hiring a clinical data programmer, export manager, passive query processor, or database builder.

RDI needs a true owner of the data.

The core question:

Will this person fight to understand what the data is actually saying, or will they report discrepancies and move on?

## What Ownership Looks Like

Strong candidates:
- Chase anomalies to root cause
- Think in subjects, samples, sites, instruments, source documents, lab workflows, and collection timing
- Reconcile lab results, sample inventory, demographics, visit dates, source records, and EDC
- Investigate discordance instead of merely reporting it
- Understand whether disagreement is real signal or data artifact
- Are comfortable digging into raw exports and source documents
- Know ALCOA+, audit trails, query discipline, database lock, and Part 11
- Can explain data issues plainly to clinical, lab, regulatory, stats, and sponsor teams
- Hold the line when someone wants the cleaner story instead of the true story
- Fight to take on more work once they understand the dataset
- Improve edit checks, eCRFs, reconciliations, and workflows so errors are caught earlier

Weak candidates:
- Think the job is mostly building forms, issuing queries, exporting data, or moving data between systems
- Act like programmers rather than owners of data truth
- Focus on tools more than root cause
- Do not want to get into source/raw data
- Cannot explain where a data point came from
- Say "the data says X" without asking whether the data is trustworthy
- Treat database lock as checklist completion
- Start with the conclusion and backfill the data

## Resume Signals

Strong:
- Clinical data management in regulated studies
- IVD, diagnostics, lab, device, specimen, sample collection, method-comparison, or central lab exposure
- Lab data reconciliation
- Sample inventory reconciliation
- External data reconciliation
- EDC ownership: Castor, REDCap, Medidata, Veeva, Inform, Cloudbyz, or similar
- Query logic, edit checks, database lock, data review guidelines
- Work with clinical operations, lab, stats, regulatory, or sponsor teams
- Evidence of root-cause investigation or process improvement

Weak:
- Pure SAS/programming background
- Only report generation
- Only EDC build
- Only query processing
- Tool-heavy but concept-light
- No source-level investigation
- No sample/lab data ownership
- Resume lists systems but no decisions or outcomes

## Writing Signals

Strong writing:
- Separates fact, assumption, risk, and recommendation
- Names what they would check next
- Does not overstate certainty
- Explains data issues clearly

Weak writing:
- "I would clean the data and issue queries"
- Tool names without reasoning
- Generic quality language
- Heavy process language with no investigation
- No root-cause thinking

## Decision Guidance

Use interview (Leadership Interview) when:
- Clear evidence of data ownership, anomaly investigation, reconciliation, and root-cause thinking

Use short (HR Screen) when:
- Candidate has CDM experience but HR must confirm whether they investigate anomalies or merely process queries
- HR should confirm raw data/source comfort, ownership, and desire to take on more responsibility

Use verify (Targeted Follow-Up / Video Question) when:
- One specific claim needs confirmation: IVD exposure, raw data investigation, database lock ownership, reconciliation ownership, or stats/method-comparison literacy

Use hold when:
- Candidate has CDM background but looks passive or tool-based; revisit if pool weakens

Use cut (Reject) when:
- Candidate appears to be a programmer/export/query processor, has low-effort answers, or lacks evidence of owning data truth

Use blocked only when:
- Materials are missing/corrupted or role/candidate cannot be evaluated

## HR Screen Confirmation

If decision is short, HR must confirm:
- Can they give a real example of tracing a data issue to root cause?
- Do they work directly with raw/source/lab/sample data?
- Have they owned database lock judgment, not just query closure?
- Do they want broader ownership, or do they prefer narrow data tasks?
- Can they explain data issues clearly without hiding behind tools?

## Targeted Video / Follow-Up Questions

Use for verify.

Examples:
- "A new assay disagrees with the predicate for several subjects at one site. What do you check before deciding whether this is real signal or a data artifact?"
- "Tell us about a time the dataset appeared to say one thing, but investigation showed the true story was different."
- "What would make you uncomfortable locking a database even if all queries were technically closed?"
`;

const SENIOR_CONTROLLER = `# RDI Hiring Rubric: Senior Controller

## Purpose

Use this rubric to decide the next recruiting action for a Senior Controller candidate.

Do not score the candidate.

RDI does not need a bookkeeper. RDI needs an operational controller who reduces CEO dependency in finance.

The core question:

Can this person turn messy operational facts into GAAP financials, revenue recognition, lender reporting, forecasts, and board materials that survive scrutiny?

## What Ownership Looks Like

Strong candidates:
- Own monthly close
- Own or review GAAP financials
- Understand ASC 606 and project-based revenue recognition
- Understand EAC / ETC / TCV / cost-to-cost / percentage-of-completion concepts
- Can explain billing vs revenue vs cash
- Gather facts from non-finance teams
- Translate lab/project/vendor/client facts into accounting consequences
- Support audits, lenders, boards, or PE ownership
- Manage outsourced accounting or small teams
- Build a recurring finance cadence
- Tell the CEO what changed, why it matters, and what decision is needed
- Make the CEO less involved over time

Weak candidates:
- Mostly AP/AR/payroll/bookkeeping
- Need clean inputs handed to them
- Treat operations as the problem instead of the reality finance must understand
- Think revenue equals invoicing
- Hide behind accounting jargon
- Are too senior and review-only
- Are too junior and need too much training
- Leave Conall as the real finance judgment layer

## Resume Signals

Strong:
- Controller, Assistant Controller, Accounting Manager, Senior Manager
- CPA or strong public accounting foundation
- GAAP close ownership
- ASC 606
- Project accounting
- EAC / ETC
- Revenue recognition
- Board reporting
- Lender reporting
- Borrowing base / covenant compliance
- Audit support
- PE-backed company
- Outsourced accounting oversight
- Forecasting / cash visibility / billing tracker

Weak:
- Bookkeeping-heavy
- Transactional accounting only
- No close ownership
- No revenue recognition depth
- No project accounting
- No audit exposure
- No evidence of working with operators
- FP&A-only without controller foundation

## Writing Signals

Strong writing:
- Explains financial consequences in plain English
- Separates facts, assumptions, accounting treatment, and business risk
- Makes recommendations
- Names what needs to be verified
- Does not overcomplicate

Weak writing:
- Accounting jargon without judgment
- Generic policy references
- "I would check with the accountant/auditor"
- No practical next step
- No ownership

## Decision Guidance

Use interview (Leadership Interview) when:
- Strong evidence of controller ownership, project revenue recognition, operational finance translation, and external reporting credibility

Use short (HR Screen) when:
- Candidate is plausible but HR must confirm ownership depth, operational translation, compensation, or onsite fit

Use verify (Targeted Follow-Up / Video Question) when:
- One specific gate needs confirmation: ASC 606, EAC/project accounting, audit-ready close, onsite, compensation, outsourced accounting oversight

Use hold when:
- Candidate may be useful but appears narrower than the role; revisit if pool weakens

Use cut (Reject) when:
- Candidate is bookkeeping/transactional only, FP&A-only, too hands-off, too junior, low-effort, or unable to reduce founder dependency

Use blocked only when:
- Materials are missing/corrupted or role/candidate cannot be evaluated

## HR Screen Confirmation

If decision is short, HR must confirm:
- Did they personally own monthly close?
- Did they personally own ASC 606/project revenue recognition?
- Can they work directly with non-finance operators?
- Have they supported audits/lenders/boards?
- Are onsite and compensation workable?

## Targeted Video / Follow-Up Questions

Use for verify.

Examples:
- "Have you personally owned ASC 606 or project-based revenue recognition? Describe the model and your role."
- "Tell us about a time operations gave finance messy inputs. How did you get to the right accounting answer?"
- "What work would you personally inspect every month if managing an outsourced accounting partner?"
`;

const PRINCIPAL_CRA = `# RDI Hiring Rubric: Principal CRA - Monitoring Standards and Training

## Purpose

Use this rubric to decide the next recruiting action for a Principal CRA candidate.

Do not score the candidate.

RDI is not hiring a hero monitor, CTM, people manager, SOP writer, or travel CRA looking for less travel.

RDI is hiring a senior monitoring craftsperson who can raise the monitoring standard, teach judgment, and make the offshore team more independent over time.

The core question:

Can this person transfer monitoring judgment through real work, or will they keep the hard calls to themselves?

## What Ownership Looks Like

Strong candidates:
- Have deep monitoring craft
- Can explain why an issue matters
- Review real CRA work and teach from it
- Have mentored, trained, calibrated, or co-monitored
- Write practical standards/examples that people use
- Understand IVD/sample-focused monitoring
- Reason from protocol, consent, sample requirements, data purpose, and regulation
- Can triage many junior questions without becoming a help desk
- Respect offshore colleagues as capable peers
- Are willing to keep a small live caseload
- Want the team to need them less over time

Weak candidates:
- Mainly want less travel
- Want Director/people-management title
- Are checklist-dependent
- Rely on years of experience instead of reasoning
- Cannot teach
- Talk down to junior/offshore staff
- Treat communication differences as competence problems
- Write generic SOP language
- Escalate everything
- Cannot adapt to IVD/sample-focused studies

## Resume Signals

Strong:
- Senior CRA / Lead CRA / Principal CRA
- Monitoring oversight
- Co-monitoring
- CRA training
- Monitoring report review
- Deviation/CAPA involvement
- Consent/eligibility judgment
- Risk-based monitoring
- IVD, diagnostics, device, lab, sample collection, sample stability
- Global/offshore/remote team coaching
- Training materials, rubrics, monitoring plans, review tools

Weak:
- Years of travel monitoring with no teaching
- CTM/project management but no recent monitoring craft
- Narrow therapeutic repetition
- SOP writing without evidence it changed real work
- No IVD/sample-focused thinking
- No evidence of reviewing others' work

## Writing Signals

Strong writing:
- Practical
- Plainspoken
- Gives examples
- Explains why an issue matters
- Shows escalation thresholds
- Helps a junior CRA make a better decision next time

Weak writing:
- Dense SOP language
- Regulatory citations without operational meaning
- Vague quality language
- No examples
- No teaching value

## Decision Guidance

Use interview (Leadership Interview) when:
- Strong evidence of monitoring craft, teaching through real work, IVD portability, and ego-secure team calibration

Use short (HR Screen) when:
- Candidate is plausible but HR must confirm teaching instinct, interest in craft seat, offshore/team fit, schedule overlap, or motivation

Use verify (Targeted Follow-Up / Video Question) when:
- One specific gate needs confirmation: UTC+8 overlap, willingness to keep live caseload, teaching evidence, IVD/sample monitoring, or consent judgment

Use hold when:
- Strong CRA background but teaching/standards-building evidence is thin; revisit if pool weakens

Use cut (Reject) when:
- Candidate is hero monitor, checklist CRA, CTM-type, SOP writer only, low-effort, travel-avoidant without teaching motivation, or offshore/team misfit

Use blocked only when:
- Materials are missing/corrupted or role/candidate cannot be evaluated

## HR Screen Confirmation

If decision is short, HR must confirm:
- Do they actually want a senior IC craft/teaching role, not CTM/director role?
- Can they give an example of improving another CRA's monitoring judgment?
- Are they comfortable with offshore team collaboration?
- Can they hold required schedule overlap?
- Are they willing to keep a small live caseload?

## Targeted Video / Follow-Up Questions

Use for verify.

Examples:
- "Tell us about a time you reviewed another CRA's work and made them better."
- "What is critical to monitor in a sample stability study?"
- "A consent form is signed by the subject but missing printed name. Rare patient. Do you include the subject? Why?"
- "How would you manage 8 junior CRAs sending urgent questions?"
`;

interface RoleRubricSeed {
  key: string;
  /** Explicit job shortcodes that map to this rubric. Checked before title regex. */
  shortcodes: string[];
  /** Title fallback when the shortcode is unknown. */
  match: RegExp;
  md: string;
}

/**
 * Order matters: Clinical Data Manager is listed before Principal CRA so that a
 * "Clinical Data Manager" title can never be captured by CRA/monitoring patterns.
 * Shortcode matching (379AA16E8F -> CDM) is the primary guarantee.
 */
const ROLE_RUBRICS: RoleRubricSeed[] = [
  {
    key: "clinical-data-manager",
    shortcodes: ["379AA16E8F"],
    match: /clinical data|data manager|data integrity|data investigation/i,
    md: CLINICAL_DATA_MANAGER,
  },
  {
    key: "executive-assistant",
    shortcodes: ["EA-001"],
    match: /executive assistant|executive operations|\bea\b|\bassistant\b/i,
    md: EXEC_ASSISTANT,
  },
  {
    key: "senior-controller",
    shortcodes: ["CTRL-002"],
    match: /controller|\bfinance\b|accounting/i,
    md: SENIOR_CONTROLLER,
  },
  {
    key: "principal-cra",
    shortcodes: [],
    match: /principal cra|\bcra\b|monitoring standards|clinical research associate/i,
    md: PRINCIPAL_CRA,
  },
];

/** Built-in seed rubric for a job, matched by explicit shortcode first, then title. */
export function seedCalibrationFor(
  jobShortcode: string | null | undefined,
  jobTitle: string | null | undefined,
): string | null {
  if (jobShortcode) {
    const byCode = ROLE_RUBRICS.find((r) => r.shortcodes.includes(jobShortcode));
    if (byCode) return byCode.md;
  }
  if (jobTitle) {
    const byTitle = ROLE_RUBRICS.find((r) => r.match.test(jobTitle));
    if (byTitle) return byTitle.md;
  }
  return null;
}

/**
 * Resolve the seat calibration to feed the triage model for a candidate's job.
 * In-app saved rubric (rubrics table) wins; otherwise the built-in seed. Returns
 * null when nothing matches, so the caller's prompt degrades to global-only.
 */
export async function getRoleCalibration(
  jobShortcode: string | null | undefined,
): Promise<string | null> {
  if (!jobShortcode) return null;

  // 1) A human-saved rubric for this job overrides the seed.
  try {
    const saved = await getActiveRubricMarkdown(jobShortcode);
    if (saved.source === "saved" && saved.markdown) return saved.markdown;
  } catch {
    // fall through to the seed
  }

  // 2) Built-in seed: shortcode first (cheap, covers the default CDM pool)...
  const byCode = seedCalibrationFor(jobShortcode, null);
  if (byCode) return byCode;

  // 3) ...else resolve the job title and match on that.
  try {
    const job = await getJobByShortcode(jobShortcode);
    return seedCalibrationFor(jobShortcode, job?.title);
  } catch {
    return null;
  }
}
