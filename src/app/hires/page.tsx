import { HiresApp } from "@/components/hires/hires-app";
import { loadHireInbox } from "@/lib/hires/load";

// Cross-job New Hires inbox. Auth enforced by Clerk middleware. Read status
// persists via src/app/actions/hires.ts; hire rows sync from setProcessStatus.
export const dynamic = "force-dynamic";

export default async function HiresPage() {
  const data = await loadHireInbox();
  return <HiresApp data={data} />;
}
