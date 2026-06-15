import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Renders AI-generated prose (summaries, investment reads, analysis blobs) as
 * readable text instead of one raw unformatted string. Handles paragraph breaks,
 * simple bullet / numbered lists, and lightweight inline markdown (**bold**,
 * *italic*). No external markdown dependency — the model emits near-plain text.
 */
export function FormattedText({
  text,
  className,
  paragraphClassName,
}: {
  text: string | null | undefined;
  className?: string;
  paragraphClassName?: string;
}) {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const blocks = splitIntoBlocks(trimmed);

  return (
    <div className={cn("space-y-2.5", className)}>
      {blocks.map((block, i) => {
        if (block.type === "ul") {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={i} className="list-decimal space-y-1 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i} className={paragraphClassName}>
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

const BULLET = /^\s*([-*•])\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function splitIntoBlocks(text: string): Block[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const blocks: Block[] = [];

  for (const para of paragraphs) {
    const lines = para.split("\n").map((l) => l.trim()).filter(Boolean);

    if (lines.length && lines.every((l) => BULLET.test(l))) {
      blocks.push({ type: "ul", items: lines.map((l) => l.replace(BULLET, "$2")) });
      continue;
    }
    if (lines.length && lines.every((l) => NUMBERED.test(l))) {
      blocks.push({ type: "ol", items: lines.map((l) => l.replace(NUMBERED, "$1")) });
      continue;
    }
    // Plain paragraph — collapse soft-wrapped single newlines into spaces.
    blocks.push({ type: "p", text: lines.join(" ") });
  }

  return blocks;
}

/** Lightweight inline markdown: **bold** and *italic*. */
function renderInline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const regex = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(<Fragment key={key++}>{text.slice(last, match.index)}</Fragment>);
    if (match[1] != null) nodes.push(<strong key={key++}>{match[1]}</strong>);
    else if (match[2] != null) nodes.push(<em key={key++}>{match[2]}</em>);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);

  return nodes;
}
