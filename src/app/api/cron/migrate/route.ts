import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { applyPendingMigrations } from "@/lib/db/apply-migrations";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await applyPendingMigrations();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Migration failed", error);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("DATABASE_URL not configured")) {
      return NextResponse.json(
        {
          error: "DATABASE_URL not configured",
          hint: "Add Supabase Postgres connection string to Vercel env, then redeploy.",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: "Migration failed", message }, { status: 500 });
  }
}
