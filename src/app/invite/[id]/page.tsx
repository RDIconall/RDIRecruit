import { redirect } from "next/navigation";
import { composePath } from "@/lib/routes";

export default async function InviteRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ job?: string }>;
}) {
  const { id } = await params;
  const { job } = await searchParams;
  const { resolveActiveJobShortcode } = await import("@/lib/jobs/service");
  const jobShortcode = (await resolveActiveJobShortcode(job)) ?? "EA-001";
  redirect(composePath(jobShortcode, id));
}
