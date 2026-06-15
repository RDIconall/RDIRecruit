import Image from "next/image";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { jobBoardPath } from "@/lib/routes";

export function AppHeader({
  activeJob,
  crumbs,
  alertCount,
}: {
  activeJob?: string;
  crumbs?: Array<{ label: string; href?: string }>;
  alertCount?: number;
}) {
  return (
    <header className="sticky top-0 z-40 flex h-[52px] items-center gap-[18px] border-b border-navy/15 bg-white px-6">
      <Link href={activeJob ? jobBoardPath(activeJob) : "/board"} className="flex shrink-0 items-center gap-2.5">
        <Image src="/logo-mark.svg" alt="RDI" width={22} height={22} />
        <span className="font-mono text-[12px] tracking-wide text-navy/55">Hiring layer</span>
      </Link>
      <div className="h-[22px] w-px bg-navy/15" />
      <nav className="flex shrink-0 items-center gap-2 text-[14px] whitespace-nowrap">
        {(crumbs ?? [{ label: "Pipeline", href: activeJob ? jobBoardPath(activeJob) : "/board" }]).map(
          (crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex items-center gap-2">
              {index > 0 ? <span className="text-navy/35">›</span> : null}
              {crumb.href ? (
                <Link href={crumb.href} className="text-navy/80 hover:text-orange">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-navy">{crumb.label}</span>
              )}
            </span>
          ),
        )}
      </nav>
      <div className="flex-1" />
      <span className="shrink-0 font-mono text-[11px] text-navy/45 whitespace-nowrap">
        Synced from Workable
      </span>
      <Link
        href={activeJob ? `/rubrics?job=${activeJob}` : "/rubrics"}
        className="shrink-0 text-xs text-navy/60 hover:text-orange"
      >
        Docs
      </Link>
      <Link href="/notifications" className="flex shrink-0 items-center gap-1.5 text-xs text-navy/60">
        Alerts
        {(alertCount ?? 0) > 0 ? (
          <span className="min-w-4 rounded-full bg-orange px-1 text-center font-mono text-[10px] leading-4 text-white">
            {alertCount}
          </span>
        ) : null}
      </Link>
      <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
    </header>
  );
}
