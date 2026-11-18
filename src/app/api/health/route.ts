import { NextRequest, NextResponse } from "next/server";
import { hasAnthropic, hasSupabase, hasWorkable } from "@/lib/env";
import { isOperatorRequest } from "@/lib/operator-auth";
import { getServiceSupabase } from "@/lib/supabase/server";
import { getSeedMethod, getSeedRubricForJob } from "@/lib/docs/seed";
import { listJobs } from "@/lib/workable/client";
import { WorkableApiError } from "@/lib/workable/errors";

export async function GET(request: NextRequest) {
  // The route is public (uptime checks). Anything beyond liveness touches the
  // production Workable/Supabase credentials, so it is operator-only.
  if (!isOperatorRequest(request)) {
    return NextResponse.json({ ok: true });
  }

  const deep = request.nextUrl.searchParams.get("deep") === "1";
  const integrations = {
    workable: hasWorkable(),
    supabase: hasSupabase(),
    anthropic: hasAnthropic(),
  };

  // Upstream error text is logged, never returned: it can echo provider
  // response bodies.
  let supabaseStatus: "ok" | "not_configured" | "error" = "not_configured";
  let migrationsApplied = false;
  let supabaseError: string | undefined;

  if (hasSupabase()) {
    try {
      const supabase = getServiceSupabase();
      const { error: jobsError } = await supabase.from("jobs").select("shortcode").limit(1);
      if (jobsError?.code === "42P01") {
        supabaseStatus = "error";
        supabaseError = "Schema not migrated — run supabase/migrations SQL";
      } else if (jobsError) {
        console.error("Health check Supabase query failed", jobsError);
        supabaseStatus = "error";
        supabaseError = jobsError.code ? `Supabase query failed (${jobsError.code})` : "Supabase query failed";
      } else {
        supabaseStatus = "ok";
        migrationsApplied = true;

        const { error: overlayError } = await supabase
          .from("candidate_overlay")
          .select("candidate_id")
          .limit(1);
        if (overlayError?.code === "42P01") {
          migrationsApplied = false;
          supabaseError = "Migration 002 pending (candidate_overlay missing)";
        }
      }
    } catch (error) {
      console.error("Health check Supabase connection failed", error);
      supabaseStatus = "error";
      supabaseError = "Supabase connection failed";
    }
  }

  const body: Record<string, unknown> = {
    ok: supabaseStatus !== "error",
    integrations,
    supabase: {
      status: supabaseStatus,
      migrationsApplied,
      error: supabaseError,
    },
  };

  if (deep) {
    // Prove the docs/ markdown is actually readable at runtime (not silently
    // falling back to the thin default), and that the live Workable API answers.
    const method = await getSeedMethod().catch(() => null);
    const sampleTitles = [
      "Executive Assistant",
      "Senior Controller",
      "Principal CRA - Monitoring Standards & Training",
      "Clinical Data Manager - Data Integrity & Investigation",
    ];
    const rubricSeeds: Record<string, number> = {};
    for (const title of sampleTitles) {
      const r = await getSeedRubricForJob(title).catch(() => null);
      rubricSeeds[title] = r ? r.length : 0;
    }

    let workableLive: { ok: boolean; jobs?: number; status?: number; error?: string } = { ok: false };
    if (hasWorkable()) {
      try {
        const jobs = await listJobs({ state: "published", limit: 50 });
        workableLive = { ok: true, jobs: jobs.length };
      } catch (error) {
        console.error("Health check Workable listJobs failed", error);
        workableLive =
          error instanceof WorkableApiError
            ? { ok: false, status: error.status, error: "Workable API error" }
            : { ok: false, error: "listJobs failed" };
      }
    }

    body.diagnostics = {
      docs: {
        methodSeedChars: method ? method.length : 0,
        rubricSeedChars: rubricSeeds,
      },
      workableLive,
    };
  }

  return NextResponse.json(body);
}
