"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { saveMethod, extractRubricFromFile } from "@/app/actions/rubrics";
import { FormattedText } from "@/components/ui/formatted-text";

/**
 * Read-only render of the method markdown so the doc can be *read* (not just
 * edited). Handles `#`/`##`/`###` headings; everything between headings is handed
 * to FormattedText for paragraphs, lists and inline emphasis.
 */
function MethodView({ markdown }: { markdown: string }) {
  const blocks: Array<{ heading?: { level: number; text: string }; body?: string }> = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) blocks.push({ body: text });
    buffer = [];
  };
  for (const line of markdown.split("\n")) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line.trim());
    if (h) {
      flush();
      blocks.push({ heading: { level: h[1].length, text: h[2].trim() } });
    } else {
      buffer.push(line);
    }
  }
  flush();

  return (
    <div className="space-y-2 text-sm leading-relaxed text-navy/80">
      {blocks.map((b, i) => {
        if (b.heading) {
          const { level, text } = b.heading;
          if (level <= 1) {
            return (
              <h3 key={i} className="pt-1 text-lg font-semibold text-navy">
                {text}
              </h3>
            );
          }
          if (level === 2) {
            return (
              <h4 key={i} className="pt-3 text-sm font-semibold text-navy">
                {text}
              </h4>
            );
          }
          return (
            <h5 key={i} className="pt-2 text-xs font-semibold uppercase tracking-wide text-navy/70">
              {text}
            </h5>
          );
        }
        return <FormattedText key={i} text={b.body} />;
      })}
    </div>
  );
}

export function MethodEditor({ initialMarkdown }: { initialMarkdown: string }) {
  const router = useRouter();
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function onSave() {
    startTransition(async () => {
      const result = await saveMethod(markdown);
      if (result.ok) {
        const rescored = "rescored" in result ? (result.rescored ?? 0) : 0;
        const remaining = "remaining" in result ? (result.remaining ?? 0) : 0;
        setMessage(
          `Saved method v${result.version}. Re-scored ${rescored} candidate${rescored === 1 ? "" : "s"} now` +
            (remaining ? ` · ${remaining} more refresh on the next sync.` : "."),
        );
        router.refresh();
      } else {
        setMessage(result.error ?? "Save failed");
      }
    });
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await extractRubricFromFile(formData);
      if (result.ok) {
        setMarkdown(result.text.trim());
        setMessage(`Loaded ${file.name}. Review below, then Save to version and re-score.`);
      } else {
        setMessage(result.error);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="rounded-xl border border-navy/10 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">How we evaluate &amp; hire — global method</h2>
          <p className="mt-0.5 text-xs text-navy/55">
            The doc read on every candidate, for every seat — how we evaluate and how we hire.
            Upload or paste <span className="font-mono">RDI_How_We_Evaluate.md</span>, then save to apply.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-full border border-navy/15 px-4 py-1.5 text-xs font-medium text-navy/75 hover:bg-cream"
        >
          {open ? "Close" : "Edit method"}
        </button>
      </div>

      {open ? (
        <div className="mt-4">
          <div className="flex items-center justify-end gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.pdf,.doc,.docx,text/markdown,text/plain,application/pdf"
              onChange={onFile}
              className="hidden"
              id="method-file"
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full border border-navy/15 px-4 py-1.5 text-xs font-medium text-navy/75 hover:bg-cream disabled:opacity-50"
            >
              {uploading ? "Reading…" : "Upload file (.md/.txt/.pdf)"}
            </button>
          </div>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            className="mt-3 h-[28rem] w-full rounded-lg border border-navy/10 bg-cream p-4 font-mono text-sm"
          />
          <button
            type="button"
            disabled={pending}
            onClick={onSave}
            className="mt-3 rounded-full bg-orange px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Saving & re-scoring…" : "Save method & re-score"}
          </button>
          {message ? <p className="mt-3 text-sm text-navy/65">{message}</p> : null}
        </div>
      ) : (
        <div className="mt-4 max-h-[32rem] overflow-y-auto rounded-lg border border-navy/10 bg-cream/40 p-5">
          <MethodView markdown={markdown} />
        </div>
      )}
    </div>
  );
}
