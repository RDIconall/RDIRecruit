"use client";

import { useEffect, useState } from "react";

export function ResumeViewer({
  candidateId,
  fallbackUrl,
}: {
  candidateId: string;
  fallbackUrl: string | null;
}) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [mime, setMime] = useState<string>("application/pdf");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/candidates/${candidateId}/resume`);
        if (res.ok) {
          const data = (await res.json()) as { url: string; mime: string };
          if (!cancelled) {
            setSignedUrl(data.url);
            setMime(data.mime);
          }
          return;
        }
        if (!cancelled && fallbackUrl) {
          setSignedUrl(fallbackUrl);
        } else if (!cancelled) {
          setError("Résumé not available — sync to ingest from Workable.");
        }
      } catch {
        if (!cancelled && fallbackUrl) setSignedUrl(fallbackUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [candidateId, fallbackUrl]);

  const displayUrl = signedUrl ?? fallbackUrl;
  const isPdf = mime.includes("pdf") || displayUrl?.toLowerCase().includes(".pdf");

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between rounded-t-md bg-navy px-4 py-2 text-cream">
        <span className="text-xs font-medium">Résumé</span>
        {displayUrl ? (
          <a
            href={displayUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-cream/80 hover:text-orange"
          >
            Download ↗
          </a>
        ) : null}
      </div>
      {displayUrl && isPdf ? (
        <iframe
          title="Résumé"
          src={displayUrl}
          className="h-[480px] w-full rounded-b-md border border-t-0 border-navy/12 bg-white"
        />
      ) : displayUrl ? (
        <div className="rounded-b-md border border-t-0 border-navy/12 bg-white p-4 text-sm text-navy/70">
          <p>DOCX stored in Supabase — open download to view the original file.</p>
          <a href={displayUrl} className="mt-2 inline-block text-orange hover:underline">
            Download résumé file
          </a>
        </div>
      ) : (
        <p className="rounded-b-md border border-t-0 border-navy/12 px-4 py-6 text-[13px] text-navy/55">
          {error ?? "Résumé loads after sync + ingest."}
        </p>
      )}
    </div>
  );
}
