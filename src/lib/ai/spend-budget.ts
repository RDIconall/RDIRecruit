import "server-only";
import { getServiceSupabase } from "../supabase/server";

/**
 * Per-candidate, per-user, and global budgets for Claude calls started by a
 * person in the app (cron / webhook / batch work is not metered here).
 *
 * Each limit is a fixed set of numbered slots in `ai_spend_slots`. Taking a slot
 * is a single conditional write — an insert that is ignored on a duplicate
 * (bucket, slot), or a version compare-and-swap on an expired slot — so parallel
 * requests can never both hold the same slot. A held slot stays taken for the
 * window, so a limit of N allows at most N calls in any window-length period.
 */

const TABLE = "ai_spend_slots";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Window {
  limit: number;
  windowMs: number;
}

interface SpendPolicy {
  perSubject?: Window;
  perUser: Window;
  global: Window;
  label: string;
}

export const SPEND_POLICY = {
  // Candidate re-analysis (POST /v1/messages, max_tokens 8000).
  grading: {
    label: "re-analysis",
    perSubject: { limit: 2, windowMs: 10 * MINUTE },
    perUser: { limit: 30, windowMs: HOUR },
    global: { limit: 120, windowMs: HOUR },
  },
  // War-room turns (each up to 1 + MAX_TOOL_ROUNDS calls of 1500 tokens).
  chat: {
    label: "war-room",
    perSubject: { limit: 2, windowMs: MINUTE },
    perUser: { limit: 60, windowMs: HOUR },
    global: { limit: 240, windowMs: HOUR },
  },
  // Calibration lesson distilling; also bumps the job's scoring epoch.
  calibration: {
    label: "calibration",
    perSubject: { limit: 3, windowMs: HOUR },
    perUser: { limit: 20, windowMs: HOUR },
    global: { limit: 40, windowMs: HOUR },
  },
  // Rubric / method saves that re-score a whole pool via the scoring epoch.
  rescore: {
    label: "pool re-score",
    perSubject: { limit: 3, windowMs: HOUR },
    perUser: { limit: 6, windowMs: HOUR },
    global: { limit: 10, windowMs: HOUR },
  },
  // Talent Radar contact scoring, sourcing plans, and outreach drafts.
  radar: {
    label: "radar",
    perUser: { limit: 100, windowMs: HOUR },
    global: { limit: 300, windowMs: HOUR },
  },
} satisfies Record<string, SpendPolicy>;

export type SpendKind = keyof typeof SPEND_POLICY;

export interface SpendHold {
  /** Give the budget back when no model request was made after all. */
  release(): Promise<void>;
}

export type SpendReservation =
  | { ok: true; hold: SpendHold }
  | { ok: false; retryAt: string; message: string };

interface Limit extends Window {
  bucket: string;
}

interface HeldSlot {
  bucket: string;
  slot: number;
  version: number;
}

interface SlotRow {
  slot: number;
  version: number;
  reserved_until: string;
}

async function takeSlot(
  limit: Limit,
  meta: { kind: SpendKind; userId: string; subject: string | null },
): Promise<HeldSlot | { retryAt: number }> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .select("slot, version, reserved_until")
    .eq("bucket", limit.bucket);
  if (error) throw new Error(`Failed to read spend budget: ${error.message}`);

  const now = Date.now();
  const reservedUntil = new Date(now + limit.windowMs).toISOString();
  const rows = new Map(((data ?? []) as SlotRow[]).map((row) => [Number(row.slot), row]));
  const fields = {
    kind: meta.kind,
    user_id: meta.userId,
    subject: meta.subject,
    reserved_until: reservedUntil,
    updated_at: new Date(now).toISOString(),
  };
  let earliest = Number.POSITIVE_INFINITY;

  for (let slot = 1; slot <= limit.limit; slot += 1) {
    const row = rows.get(slot);
    if (!row) {
      const { data: inserted, error: insertError } = await supabase
        .from(TABLE)
        .upsert(
          { bucket: limit.bucket, slot, version: 1, ...fields },
          { onConflict: "bucket,slot", ignoreDuplicates: true },
        )
        .select("slot, version")
        .maybeSingle();
      if (insertError) throw new Error(`Failed to reserve spend budget: ${insertError.message}`);
      if (inserted) return { bucket: limit.bucket, slot, version: 1 };
      continue;
    }

    const expiresAt = Date.parse(row.reserved_until);
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      earliest = Math.min(earliest, expiresAt);
      continue;
    }
    const version = Number(row.version) + 1;
    const { data: taken, error: updateError } = await supabase
      .from(TABLE)
      .update({ version, ...fields })
      .eq("bucket", limit.bucket)
      .eq("slot", slot)
      .eq("version", Number(row.version))
      .select("slot, version")
      .maybeSingle();
    if (updateError) throw new Error(`Failed to reserve spend budget: ${updateError.message}`);
    if (taken) return { bucket: limit.bucket, slot, version };
  }

  return { retryAt: Number.isFinite(earliest) ? earliest : now + limit.windowMs };
}

async function releaseSlot(held: HeldSlot): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await getServiceSupabase()
    .from(TABLE)
    .update({ version: held.version + 1, reserved_until: now, updated_at: now })
    .eq("bucket", held.bucket)
    .eq("slot", held.slot)
    .eq("version", held.version);
  if (error) console.error("Failed to release spend budget", error.message);
}

function limitsFor(kind: SpendKind, userId: string, subject: string | null): Limit[] {
  const policy: SpendPolicy = SPEND_POLICY[kind];
  const limits: Limit[] = [];
  if (policy.perSubject && subject) {
    limits.push({ bucket: `${kind}:subject:${subject}`, ...policy.perSubject });
  }
  limits.push({ bucket: `${kind}:user:${userId}`, ...policy.perUser });
  limits.push({ bucket: `${kind}:global`, ...policy.global });
  return limits;
}

function retryText(retryAt: number): string {
  const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / MINUTE));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}

/**
 * Reserve one Claude call of `kind` for `userId` (and `subject`, e.g. a candidate
 * id) before the request is sent. Every limit must have room; otherwise nothing
 * is held. Fails closed: if the budget cannot be read or written, no call is
 * allowed.
 */
export async function reserveModelSpend(
  kind: SpendKind,
  who: { userId: string; subject?: string | null },
): Promise<SpendReservation> {
  const subject = who.subject?.trim() || null;
  const held: HeldSlot[] = [];
  const releaseAll = async () => {
    await Promise.all(held.splice(0).map((slot) => releaseSlot(slot)));
  };

  try {
    for (const limit of limitsFor(kind, who.userId, subject)) {
      const result = await takeSlot(limit, { kind, userId: who.userId, subject });
      if ("retryAt" in result) {
        await releaseAll();
        return {
          ok: false,
          retryAt: new Date(result.retryAt).toISOString(),
          message: `Rate limit reached for ${SPEND_POLICY[kind].label} — try again in ${retryText(result.retryAt)}.`,
        };
      }
      held.push(result);
    }
  } catch (error) {
    console.error(`Spend budget unavailable for ${kind}`, error);
    await releaseAll();
    return {
      ok: false,
      retryAt: new Date(Date.now() + MINUTE).toISOString(),
      message: "Claude budget check is unavailable right now, so no model call was made. Please retry shortly.",
    };
  }

  let released = false;
  return {
    ok: true,
    hold: {
      async release() {
        if (released) return;
        released = true;
        await releaseAll();
      },
    },
  };
}
