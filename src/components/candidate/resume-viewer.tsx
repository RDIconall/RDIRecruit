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
  const [zoom, setZoom] = useState(100);

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
      <div className="flex items-center justify-between gap-3 rounded-t-md bg-navy px-4 py-2 text-cream">
        <span className="text-xs font-medium">Résumé</span>
        <div className="flex items-center gap-3">
          {isPdf ? (
            <>
              <span className="font-mono text-[10px] text-cream/55">Page 1</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.max(50, z - 10))}
                  className="rounded px-1.5 py-0.5 text-xs text-cream/80 hover:bg-cream/10"
                  aria-label="Zoom out"
                >
                  −
                </button>
                <span className="font-mono text-[10px] text-cream/70">{zoom}%</span>
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.min(150, z + 10))}
                  className="rounded px-1.5 py-0.5 text-xs text-cream/80 hover:bg-cream/10"
                  aria-label="Zoom in"
                >
                  +
                </button>
              </div>
            </>
          ) : null}
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
      </div>
      {displayUrl && isPdf ? (
        <div
          className="overflow-auto rounded-b-md border border-t-0 border-navy/12 bg-white"
          style={{ height: 480 }}
        >
          <iframe
            title="Résumé"
            src={displayUrl}
            className="h-full w-full origin-top-left border-0"
            style={{
              transform: `scale(${zoom / 100})`,
              width: `${10000 / zoom}%`,
              height: `${10000 / zoom}%`,
            }}
          />
        </div>
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
