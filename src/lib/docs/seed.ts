import { promises as fs } from "fs";
import path from "path";
import { getBuiltinSeatRubric, seatRubricMarkdown } from "../rubric/seat-rubrics";

/**
 * The docs/ folder is the canonical source for the markdown the grader reads:
 * the global "How We Evaluate" method and each seat's rubric. These files are the
 * SEED / fallback — once edited in-app, the DB version takes precedence.
 */
const DOCS_DIR = path.join(process.cwd(), "docs");

export const METHOD_DOC_FILE = "RDI_How_We_Evaluate.md";

/**
 * Job rubric files keyed by the explicit seat titles that resolve to them.
 * Patterns name the seat itself: single words like "assistant", "finance", or
 * "principal" appear in unrelated requisitions and must never select a seat's
 * rubric. A title that names more than one seat resolves to none, so the
 * generic default applies instead of a guess.
 */
const RUBRIC_FILES: Array<{ file: string; titles: RegExp[] }> = [
  {
    file: "RDI_Senior_Controller_Candidate_Grading_Rubric_COMPLETE_v2.md",
    titles: [/\b(?:senior|financial|corporate)\s+controller\b/i],
  },
  {
    file: "RDI_Executive_Assistant_Candidate_Grading_Rubric_COMPLETE_v2.md",
    titles: [/\bexecutive\s+assistant\b/i],
  },
  {
    file: "RDI_Principal_CRA_Monitoring_Standards_Training_Rubric_COMPLETE_v2.md",
    titles: [
      /\bprincipal\s+cra\b/i,
      /\bprincipal\s+clinical\s+research\s+associate\b/i,
      /\bmonitoring\s+standards\b/i,
    ],
  },
];

function seedFileForTitle(title: string): string | null {
  const matches = RUBRIC_FILES.filter((r) => r.titles.some((rx) => rx.test(title)));
  return matches.length === 1 ? matches[0]!.file : null;
}

const cache = new Map<string, string | null>();

async function readDoc(file: string): Promise<string | null> {
  if (cache.has(file)) return cache.get(file) ?? null;
  try {
    const text = await fs.readFile(path.join(DOCS_DIR, file), "utf8");
    const trimmed = text.trim();
    cache.set(file, trimmed.length ? trimmed : null);
  } catch {
    cache.set(file, null);
  }
  return cache.get(file) ?? null;
}

/** The global method doc from docs/, or null if missing. */
export async function getSeedMethod(): Promise<string | null> {
  return readDoc(METHOD_DOC_FILE);
}

/** The best-matching seat rubric from docs/ for a job title, or null. */
export async function getSeedRubricForJob(
  title: string | null | undefined,
  shortcode?: string | null,
): Promise<string | null> {
  const builtin = getBuiltinSeatRubric({ shortcode, title });
  if (builtin) return seatRubricMarkdown(builtin);

  if (!title) return null;
  const file = seedFileForTitle(title);
  if (!file) return null;
  return readDoc(file);
}

/** All known rubric doc filenames (for listing / tooling). */
export function listRubricDocFiles(): string[] {
  return RUBRIC_FILES.map((r) => r.file);
}
