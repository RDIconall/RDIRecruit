import { NextRequest, NextResponse } from "next/server";
import { env, hasAnthropic, hasSupabase } from "@/lib/env";
import { getActiveScorecard, loadContacts, saveScore } from "@/lib/radar/store";
import { scoreContact } from "@/lib/radar/score";
import type { Pipeline } from "@/lib/radar/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Background enrichment: scores any not-yet-scored contacts against the active
// scorecard, time-budgeted so it stays within a serverless invocation. Public
// route gated by CRON_SECRET (mirrors the other /api/cron/* handlers).
const BUDGET_MS = 50_000;

export async function GET(request: NextRequest) {
  const authz = request.headers.get("authorization");
  if (env.CRON_SECRET && authz !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasSupabase()) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  if (!hasAnthropic()) return NextResponse.json({ ok: true, skipped: "no ANTHROPIC_API_KEY", scored: 0 });

  const started = Date.now();
  const pipelines: Pipeline[] = ["recruiting", "bd"];
  let scored = 0;
  const remaining: Record<string, number> = {};

  for (const pipeline of pipelines) {
    const scorecard = await getActiveScorecard(pipeline);
    const contacts = await loadContacts({ pipeline });
    const unscored = contacts.filter((c) => !c.score && !c.optOut);
    remaining[pipeline] = unscored.length;
    for (const contact of unscored) {
      if (Date.now() - started > BUDGET_MS) break;
      const result = await scoreContact(contact, pipeline, scorecard.content);
      if (!result) continue;
      await saveScore({
        contactId: contact.id,
        pipeline,
        scorecardName: scorecard.name,
        dimensions: result.dimensions,
        overall: result.overall,
        recommendation: result.recommendation,
        summary: result.summary,
        strongestSignal: result.strongestSignal,
        biggestConcern: result.biggestConcern,
        nextAction: result.nextAction,
        model: result.model,
      });
      scored++;
      remaining[pipeline]--;
    }
    if (Date.now() - started > BUDGET_MS) break;
  }

  return NextResponse.json({ ok: true, scored, remaining, elapsedMs: Date.now() - started });
}
