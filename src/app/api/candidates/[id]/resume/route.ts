import { NextResponse } from "next/server";
import { checkHiringAdmin } from "@/lib/auth/hiring-admin";
import { getSignedResumeUrl } from "@/lib/resume/ingest";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const access = await checkHiringAdmin();
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const { id } = await context.params;
  const signed = await getSignedResumeUrl(id, access.admin.userId);

  if (!signed) {
    return NextResponse.json({ error: "Résumé not ingested yet" }, { status: 404 });
  }

  return NextResponse.json(signed);
}
