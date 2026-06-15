import { redirect } from "next/navigation";

export default async function JobCandidateRedirect({
  params,
}: {
  params: Promise<{ shortcode: string; cid: string }>;
}) {
  const { shortcode, cid } = await params;
  redirect(`/candidates/${cid}?job=${shortcode}`);
}
