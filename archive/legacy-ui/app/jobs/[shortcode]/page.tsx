import { redirect } from "next/navigation";

export default async function JobBoardRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ shortcode: string }>;
  searchParams: Promise<{ tier?: string }>;
}) {
  const { shortcode } = await params;
  const { tier } = await searchParams;
  const qs = tier ? `&tier=${tier}` : "";
  redirect(`/board?job=${shortcode}${qs}`);
}
