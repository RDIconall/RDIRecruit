import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSignedResumeUrl } from "@/lib/resume/ingest";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const signed = await getSignedResumeUrl(id, userId);

  if (!signed) {
    return NextResponse.json({ error: "Résumé not ingested yet" }, { status: 404 });
  }

  return NextResponse.json(signed);
}
