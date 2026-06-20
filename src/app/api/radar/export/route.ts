import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { hasSupabase } from "@/lib/env";
import { contactsToCsv } from "@/lib/radar/csv";
import { loadContacts } from "@/lib/radar/store";
import type { Pipeline } from "@/lib/radar/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Authenticated CSV export of the current pipeline/search view.
export async function GET(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasSupabase()) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  const pipeline = (request.nextUrl.searchParams.get("pipeline") as Pipeline) || "recruiting";
  const searchId = request.nextUrl.searchParams.get("searchId");

  const contacts = await loadContacts({ pipeline, searchId: searchId || null });
  const csv = contactsToCsv(contacts);
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="talent-radar-${pipeline}-${stamp}.csv"`,
    },
  });
}
