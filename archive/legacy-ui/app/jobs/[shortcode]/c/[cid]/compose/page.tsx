import { redirect } from "next/navigation";

export default async function JobComposeRedirect({
  params,
}: {
  params: Promise<{ shortcode: string; cid: string }>;
}) {
  const { shortcode, cid } = await params;
  redirect(`/invite/${cid}?job=${shortcode}`);
}
