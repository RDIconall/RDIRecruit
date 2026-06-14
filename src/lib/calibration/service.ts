import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic, hasSupabase } from "../env";
import { getServiceSupabase } from "../supabase/server";

const MODEL = "claude-sonnet-4-6";
export const GLOBAL_SCOPE = "global";

export interface CalibrationDoc {
  scope: string;
  markdown: string;
  version: number;
}

/** Active calibration markdown for a scope ('global' or a job shortcode). */
export async function getCalibration(scope: string): Promise<CalibrationDoc | null> {
  if (!hasSupabase()) return null;
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("calibration")
    .select("scope, markdown, version")
    .eq("scope", scope)
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as CalibrationDoc | null) ?? null;
}

/** Both layers the evaluator reads for a job: org-wide + this role. */
export async function getCalibrationForJob(
  jobShortcode: string,
): Promise<{ global: string; role: string }> {
  const [global, role] = await Promise.all([
    getCalibration(GLOBAL_SCOPE),
    getCalibration(jobShortcode),
  ]);
  return { global: global?.markdown ?? "", role: role?.markdown ?? "" };
}

async function saveCalibration(scope: string, markdown: string) {
  if (!hasSupabase()) return;
  const supabase = getServiceSupabase();
  const { data: latest } = await supabase
    .from("calibration")
    .select("version")
    .eq("scope", scope)
    .order("version", { ascending: false })
    .limit(1);
  const version = ((latest?.[0]?.version as number | undefined) ?? 0) + 1;
  await supabase.from("calibration").update({ active: false }).eq("scope", scope);
  await supabase.from("calibration").insert({ scope, version, markdown, active: true });
}

/** sync_state key holding the per-scope "scoring epoch" — bumping it marks scores stale. */
function epochKey(scope: string) {
  return `scoring_epoch:${scope}`;
}

/** Bump the scoring epoch so the next sync re-scores affected candidates. */
export async function bumpScoringEpoch(scope: string) {
  const { writeSyncState } = await import("../sync/sync-state");
  await writeSyncState(epochKey(scope), { at: new Date().toISOString() });
}

/** The most recent epoch that applies to a job (max of its role epoch and global). */
export async function getEffectiveEpoch(jobShortcode: string): Promise<string | null> {
  const { readSyncState } = await import("../sync/sync-state");
  const [role, global] = await Promise.all([
    readSyncState<{ at: string | null }>(epochKey(jobShortcode), { at: null }),
    readSyncState<{ at: string | null }>(epochKey(GLOBAL_SCOPE), { at: null }),
  ]);
  const candidates = [role.at, global.at].filter(Boolean) as string[];
  if (!candidates.length) return null;
  return candidates.sort().at(-1) ?? null;
}

const DISTILL_SYSTEM = `You maintain the calibration notes for RDI Trials' hiring evaluator. A reviewer (a senior operator whose judgment is the ground truth) just corrected or annotated a candidate's read. Turn their correction into ONE durable, generalizable rule the evaluator should apply going forward — not a note about this one candidate.

Decide the SCOPE:
- "global": a rule about how RDI evaluates ANY role (a principle: e.g. how to weigh AI-sounding prose, how to read a salary ask, what counts as owner vs technician, an integrity/ego gate). Applies across all hiring.
- "role": a rule specific to THIS seat/role (e.g. "for the Controller seat, audit-defensibility outweighs raw modeling speed").

Then MERGE it into the existing notes for that scope: if it refines or contradicts an existing bullet, rewrite that bullet; otherwise add a concise new bullet. Keep the doc tight (markdown bullets, no preamble), dedupe, never let it sprawl. Keep every rule actionable and general.

Return JSON only: {"scope":"global"|"role","lesson":"the one-line rule you derived","markdown":"the FULL updated markdown doc for that scope after merging"}`;

interface DistillResult {
  scope: "global" | "role";
  lesson: string;
  markdown: string;
}

/**
 * Distill a reviewer correction into a durable rule, classify it as role vs
 * global, and merge it into the right calibration doc. Returns what it learned.
 */
export async function learnFromFeedback(input: {
  jobShortcode: string;
  jobTitle: string;
  candidateName: string;
  aiTotal: number | null;
  correctedTotal: number | null;
  direction: string;
  note: string;
}): Promise<{ scope: "global" | "role"; lesson: string } | null> {
  if (!hasSupabase()) return null;

  const [existingGlobal, existingRole] = await Promise.all([
    getCalibration(GLOBAL_SCOPE),
    getCalibration(input.jobShortcode),
  ]);

  if (!hasAnthropic()) {
    // No model: append the raw note to the role doc verbatim so nothing is lost.
    const base = existingRole?.markdown?.trim() || `# Calibration — ${input.jobTitle}`;
    const merged = `${base}\n- ${input.note.trim()}`;
    await saveCalibration(input.jobShortcode, merged);
    await bumpScoringEpoch(input.jobShortcode);
    return { scope: "role", lesson: input.note.trim() };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const userPrompt = `SEAT: ${input.jobTitle} (${input.jobShortcode})
CANDIDATE: ${input.candidateName}
AI FIT SCORE: ${input.aiTotal ?? "—"}
REVIEWER'S CORRECTED SCORE: ${input.correctedTotal ?? "(not given — directional only)"}
REVIEWER DIRECTION: ${input.direction}
REVIEWER REASONING: """${input.note.trim()}"""

EXISTING GLOBAL CALIBRATION:
"""${existingGlobal?.markdown?.trim() || "(empty)"}"""

EXISTING ROLE CALIBRATION (${input.jobShortcode}):
"""${existingRole?.markdown?.trim() || "(empty)"}"""`;

  let result: DistillResult;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: DISTILL_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
    const match = text.match(/\{[\s\S]*\}/);
    result = JSON.parse(match?.[0] ?? "{}") as DistillResult;
  } catch (error) {
    console.error("Calibration distill failed", error);
    return null;
  }

  const scope = result.scope === "global" ? GLOBAL_SCOPE : input.jobShortcode;
  const markdown = (result.markdown ?? "").trim();
  if (markdown) {
    await saveCalibration(scope, markdown);
    await bumpScoringEpoch(scope);
  }
  return { scope: result.scope === "global" ? "global" : "role", lesson: result.lesson ?? input.note };
}
