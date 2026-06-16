"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { saveRubricAndRecompute } from "@/app/actions/recompute";
import { extractRubricFromFile } from "@/app/actions/rubrics";
import { parseRubricMarkdown } from "@/lib/rubric/parser";

export function RubricEditor({
  jobShortcode,
  initialMarkdown,
}: {
  jobShortcode: string;
  initialMarkdown: string;
}) {
  const router = useRouter();
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const parsed = parseRubricMarkdown(markdown);

  function onSave() {
    startTransition(async () => {
      const result = await saveRubricAndRecompute({ jobShortcode, markdown });
      if (result.ok && "version" in result) {
        const count = "recomputed" in result ? (result.recomputed ?? 0) : 0;
        const remaining = "remaining" in result ? (result.remaining ?? 0) : 0;
        setMessage(
          `Saved rubric v${result.version}. Re-scored ${count} candidate${count === 1 ? "" : "s"} now` +
            (remaining ? ` · ${remaining} more refresh automatically on the next sync.` : "."),
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
        const heading = `\n\n## Job spec — what we're looking for (from ${file.name})\n`;
        setMarkdown((prev) => `${prev.trimEnd()}${heading}\n${result.text.trim()}\n`);
        setMessage(`Loaded job spec from ${file.name}. Review below, then Save & version to apply.`);
      } else {
        setMessage(result.error);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-xl border border-navy/10 bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="rubric-md" className="text-sm font-medium">
            Rubric markdown · {jobShortcode}
          </label>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.pdf,.doc,.docx,text/markdown,text/plain,application/pdf"
              onChange={onFile}
              className="hidden"
              id="rubric-file"
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full border border-navy/15 px-4 py-1.5 text-xs font-medium text-navy/75 hover:bg-cream disabled:opacity-50"
            >
              {uploading ? "Reading…" : "Upload job spec (.md/.txt/.pdf)"}
            </button>
          </div>
        </div>
        <textarea
          id="rubric-md"
          value={markdown}
          onChange={(event) => setMarkdown(event.target.value)}
          className="mt-3 h-[32rem] w-full rounded-lg border border-navy/10 bg-cream p-4 font-mono text-sm"
        />
        <button
          type="button"
          disabled={pending}
          onClick={onSave}
          className="mt-4 rounded-full bg-orange px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Saving & re-scoring…" : "Save & version rubric"}
        </button>
        {message ? <p className="mt-3 text-sm text-navy/65">{message}</p> : null}
      </div>

      <div className="rounded-xl border border-navy/10 bg-white p-5">
        <h2 className="text-lg font-medium">Parsed preview</h2>
        <p className="mt-1 text-xs text-navy/55">
          Weights and tiers steer scoring; the prose below them is read by the evaluator as
          guidance for what &ldquo;good&rdquo; looks like on this seat.
        </p>
        <div className="mt-4 space-y-4 text-sm">
          <div>
            <p className="font-medium">Weights</p>
            <ul className="mt-2 space-y-1 font-mono text-xs text-navy/70">
              {Object.entries(parsed.weights).map(([key, value]) => (
                <li key={key}>
                  {key}: {value}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-medium">Tiers</p>
            <p className="mt-2 text-navy/70">
              Strong {parsed.definition.tiers.strong} · Viable {parsed.definition.tiers.viable} · Hold{" "}
              {parsed.definition.tiers.hold}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
