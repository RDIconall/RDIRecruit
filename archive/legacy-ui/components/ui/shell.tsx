import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { SyncButton } from "@/components/board/sync-button";
import { cn } from "@/lib/utils";

export function AppShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-navy/10 bg-navy text-cream">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <Link href="/board" className="font-hero text-2xl tracking-tight">
              RDI Hiring Layer
            </Link>
            {subtitle ? <p className="mt-1 text-sm text-cream/70">{subtitle}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <SyncButton />
            <nav className="flex gap-4 text-sm">
              <Link href="/board" className="hover:text-orange transition-colors">Board</Link>
              <Link href="/rubrics" className="hover:text-orange transition-colors">Rubrics</Link>
              <Link href="/notifications" className="hover:text-orange transition-colors">Alerts</Link>
            </nav>
            <UserButton appearance={{ elements: { avatarBox: "h-8 w-8 ring-2 ring-cream/20" } }} />
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-6 pb-5">
          <h1 className="text-xl font-medium">{title}</h1>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-navy/10 bg-white p-5 shadow-sm", className)}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

export function ScoreRing({ total, max = 100 }: { total: number | null; max?: number }) {
  const value = total ?? 0;
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="relative flex h-28 w-28 items-center justify-center">
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 36 36">
        <path
          className="text-navy/10"
          stroke="currentColor"
          strokeWidth="3"
          fill="none"
          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
        />
        <path
          className="text-orange"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${pct}, 100`}
          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
        />
      </svg>
      <div className="text-center">
        <p className="text-3xl font-semibold tabular-nums">{total ?? "—"}</p>
        <p className="text-[10px] uppercase tracking-wider text-navy/50">Fit</p>
      </div>
    </div>
  );
}
