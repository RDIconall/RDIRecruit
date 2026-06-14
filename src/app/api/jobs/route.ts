import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getPublishedJobs } from "@/lib/jobs/service";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const jobs = await getPublishedJobs();
  return NextResponse.json({ jobs });
}
