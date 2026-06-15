"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  advanceCandidate,
  denyCandidate,
  holdCandidate,
  restoreCandidate,
  withdrawCandidate,
} from "@/app/actions/candidates";
import { composePath } from "@/lib/routes";
import { wbCandidate } from "@/lib/workable/links";
import type { CandidateOverlayRow } from "@/lib/types";

export function CandidateActionBar({
  candidateId,
  jobShortcode,
  candidateName,
  stage,
  overlay,
}: {
  candidateId: string;
  jobShortcode: string;
  candidateName: string;
  stage: string | null;
  overlay: CandidateOverlayRow | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const inactive = overlay?.status === "disqualified" || overlay?.status === "withdrawn";

  function run(action: () => Promise<unknown>) {
    startTransition(async () => {
      await action();
      router.refresh();
    });
  }

  return (
    <div className="mt-[18px] flex flex-wrap items-center gap-2.5">
      <Link
        href={composePath(jobShortcode, candidateId)}
        className="rounded-full bg-orange px-[18px] py-2 text-[14px] font-semibold text-white"
      >
        Compose invite →
      </Link>
      {!inactive ? (
        <>
          <ActionBtn disabled={pending} onClick={() => run(() => advanceCandidate({ jobShortcode, candidateId }))}>
            Advance
          </ActionBtn>
          <ActionBtn disabled={pending} onClick={() => run(() => holdCandidate({ jobShortcode, candidateId }))}>
            Hold
          </ActionBtn>
          <ActionBtn disabled={pending} onClick={() => run(() => denyCandidate({ jobShortcode, candidateId }))}>
            Disqualify
          </ActionBtn>
          {overlay?.status === "disqualified" ? (
            <a
              href={wbCandidate(jobShortcode, candidateId)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] text-navy/55 hover:text-orange"
            >
              Set reason in Workable ↗
            </a>
          ) : null}
          <ActionBtn disabled={pending} onClick={() => run(() => withdrawCandidate({ jobShortcode, candidateId }))}>
            Mark withdrawn
          </ActionBtn>
        </>
      ) : (
        <ActionBtn
          disabled={pending}
          accent
          onClick={() => run(() => restoreCandidate({ jobShortcode, candidateId }))}
        >
          Restore
        </ActionBtn>
      )}
      <div className="flex-1" />
      <span className="font-mono text-[12px] text-navy/45">
        {overlay?.updated_by ? `owner: ${overlay.updated_by} · ` : ""}stage:{" "}
        {overlay?.status && overlay.status !== "active" ? overlay.status : stage ?? "—"}
      </span>
      <a
        href={wbCandidate(jobShortcode, candidateId)}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-full border border-navy/20 px-4 py-2 text-[14px] text-navy hover:border-orange hover:text-orange"
      >
        Open in Workable ↗
      </a>
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  disabled,
  accent,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        accent
          ? "rounded-full border border-orange/40 px-4 py-2 text-[14px] text-orange disabled:opacity-50"
          : "rounded-full border border-navy/20 px-4 py-2 text-[14px] text-navy disabled:opacity-50"
      }
    >
      {children}
    </button>
  );
}
