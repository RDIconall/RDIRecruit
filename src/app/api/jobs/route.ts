import { NextResponse } from "next/server";
import { checkHiringAdmin } from "@/lib/auth/hiring-admin";
import { getPublishedJobs } from "@/lib/jobs/service";

export async function GET() {
  const access = await checkHiringAdmin();
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }
  const jobs = await getPublishedJobs();
  return NextResponse.json({ jobs });
}
