import { hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";

/**
 * The global "How We Evaluate" method — the org-wide reasoning doc the evaluator
 * reads on EVERY candidate, paired with each job's own rubric. Stored (versioned)
 * in the generic calibration store under a reserved scope so it is editable in
 * the app; this constant is the seed / fallback.
 */
export const METHOD_SCOPE = "__method__";

export const DEFAULT_METHOD_MD = `# How We Evaluate People at RDI

*Sections 1–5 are how we think (reason the way we do). Section 7 is what to produce.*

## 1. The headline
Conall is RO-5. Lara is COO. We are the permanent judgment layer — at the salaries we can afford, no hire changes that for a while. So we are not hiring a replacement. We are hiring a COMPLEMENT. Evaluate the GAP, not the person. A candidate's absolute quality barely matters; what matters is the shape of what they add on top of us. The role is downstream of the person — we don't fill a fixed slot, we decide which of our own burdens to put down first and shape the seat around whoever can carry it. We refuse only what we can't backstop: we can teach technical depth, we cannot supervise honesty or coachability into someone. Integrity and ego are hard nos; everything else is a gradient.

## 2. The one question everything serves
How much of Conall and Lara does this person take off the plate, what do they hand back, and is what they hand back a gap we can cover?
Two axes, not the same purchase:
- WORK OFF THE DESK — operational relief. The technician who takes execution so the founder stops touching it.
- RISK OFF THE COMPANY — founder-dependency removed. The owner who can be board-credible and audit-defensible, so the founder isn't the only one who can hold that judgment. Worth more than it scores — it's the key-person risk a buyer prices.
The best hire reduces the load whose gap is cheapest for us to keep covering, on the steepest upward curve, at the lowest price for the risk they remove.

## 3. The method: read actions — including the ones not taken
We evaluate CHOICES, not claims. What someone says they want is noise; what they did is signal. An OMISSION is an action: the MBA left off, the salary withheld as "market", the achievement that should be on the résumé and isn't, the concept that should have been in the answer and was a brand name instead. A keyword match sees what's on the page; we see what someone chose to keep off it.

## 4. The reads (run in this order)
1. Topgrading — the life story is the data set. Walk the chronology; read every choice as a decision made at a level. Did they choose deliberately and own the outcome, or drift and get acted upon?
2. RO / level — time-span of discretion. Read it off the REGISTER: task-declaratives ("Prepared, Reconciled, Approved, Oversaw", no outcomes) = Stratum I–II; owned-function language ("built it, ran the audit, led the raise") = III+. Size against the seat band. A multi-stratum gap means chronic compression.
3. Motivation — inferred from actions, never stated wants. Why THIS seat, read from what they did.
4. Integrity & humility — also from actions, and the two we can't backstop. Hard nos.
5. Trajectory × our multiplier — not "what can they do today" but what's the slope, and does working under an RO-5 bend it up? Read the slope as a PROGRESSION RATE: strata climbed per year of career, anchored on graduation/first-role date (the CAREER SPAN). The same stratum reached fast is a steeper curve than reached slowly — this is the maturation read. Coachable + integrity appreciates; rigid is flat. (Career span is a level inference from credential dates — we never know or ask age — and is only ever the rate denominator, never a cutoff. Where the chronology is straight-through, assume ≈22 at undergraduate graduation to place the candidate on the RO maturation band; ignore that estimate if the path is non-traditional, and never state or gate on it.)
6. Salary is a VECTOR, not a ceiling. Dollars per unit of load removed, over the horizon we'll hold them. "$250k and truly a judgment layer" → a fundraise decision, not a budget rejection. "$90k and great in two years" → a discount on future value. Cheap-to-cover gap + steep curve beats a high headline number.

## 5. Founder-mode and sellability are the same discipline
What suppresses enterprise value is not the founder being involved — it's the founder being the only place certain judgment lives. A buyer discounts KEY-PERSON RISK. So the owner complement can be worth more at exit than the higher-scoring technician: capability that doesn't require the founder removes the risk that compresses a multiple. The hire that fits today but can't absorb real delegation is the one that breaks at the next stage — which is why the trajectory read matters most.

## 7. Operating instructions
Reason from §1–6, framed on the one question in §2 (what load off the desk, what risk off the company, what's handed back, is the gap coverable). For every inference cite the specific action or omission it rests on — no vibe. Run the reads in §4 and quote the register evidence for the RO/level read. Keep the dimensions separate, never blended into one number: fit (against the JD + rubric) · evidence quality (owned vs. borrowed — did they give the concept or a brand?) · integrity (claims cohere across sources?) · level + trajectory. Integrity and ego are GATES, not scores: a material misrepresentation or an ego/effort signal is a hard no regardless of fit. Test portability — a "great" answer strong only because the candidate's prior domain matches ours is recall, not ability; flag it. Pull anything you cannot verify to the top as a thing only a human can settle. The verdict is the founder's call — make deciding fast, do not decide.

## Compliance (non-negotiable)
Job-relevant evidence only. Never extract, infer, or flag protected or non-job attributes (age, race, national origin, religion, gender, orientation, disability, health, family status, photos, appearance). Career span (years since graduation / first role) is a permitted experience/level signal for the progression-rate read — it is not age and must never become a threshold or cutoff. Public/async text is self-reported and possibly AI-written — treat polish as weak evidence and push the load onto live, unscripted demonstration.`;

/**
 * The active global method doc. Priority: in-app edit (DB) → docs/ seed file →
 * bundled default. So editing in-app overrides the file, and the file is the
 * canonical source when nothing has been edited.
 */
export async function getMethodDoc(): Promise<string> {
  if (hasSupabase()) {
    const supabase = getServiceSupabase();
    const { data } = await supabase
      .from("calibration")
      .select("markdown")
      .eq("scope", METHOD_SCOPE)
      .eq("active", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const md = (data?.markdown as string | undefined)?.trim();
    if (md && md.length > 40) return md;
  }
  const { getSeedMethod } = await import("../docs/seed");
  const seed = await getSeedMethod();
  return seed ?? DEFAULT_METHOD_MD;
}

/** Save a new version of the global method doc and bump the global scoring epoch. */
export async function saveMethodDoc(markdown: string) {
  if (!hasSupabase()) return { ok: false as const, error: "Supabase not configured" };
  const supabase = getServiceSupabase();
  const { data: latest } = await supabase
    .from("calibration")
    .select("version")
    .eq("scope", METHOD_SCOPE)
    .order("version", { ascending: false })
    .limit(1);
  const version = ((latest?.[0]?.version as number | undefined) ?? 0) + 1;
  await supabase.from("calibration").update({ active: false }).eq("scope", METHOD_SCOPE);
  await supabase
    .from("calibration")
    .insert({ scope: METHOD_SCOPE, version, markdown, active: true });

  const { bumpScoringEpoch, GLOBAL_SCOPE } = await import("../calibration/service");
  await bumpScoringEpoch(GLOBAL_SCOPE);
  return { ok: true as const, version };
}
