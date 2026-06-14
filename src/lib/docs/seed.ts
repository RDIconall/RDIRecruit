import { promises as fs } from "fs";
import path from "path";

/**
 * The docs/ folder is the canonical source for the markdown the grader reads:
 * the global "How We Evaluate" method and each seat's rubric. These files are the
 * SEED / fallback — once edited in-app, the DB version takes precedence.
 */
const DOCS_DIR = path.join(process.cwd(), "docs");

export const METHOD_DOC_FILE = "RDI_How_We_Evaluate.md";

/** Job rubric files keyed by the title tokens that should resolve to them. */
const RUBRIC_FILES: Array<{ file: string; match: RegExp }> = [
  {
    file: "RDI_Senior_Controller_Candidate_Grading_Rubric_COMPLETE_v2.md",
    match: /controller|finance|accounting/i,
  },
  {
    file: "RDI_Executive_Assistant_Candidate_Grading_Rubric_COMPLETE_v2.md",
    match: /executive assistant|\bea\b|assistant/i,
  },
  {
    file: "RDI_Principal_CRA_Monitoring_Standards_Training_Rubric_COMPLETE_v2.md",
    match: /principal|\bcra\b|monitoring standards|clinical research associate/i,
  },
];

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
export async function getSeedRubricForJob(title: string | null | undefined): Promise<string | null> {
  if (!title) return null;
  const entry = RUBRIC_FILES.find((r) => r.match.test(title));
  if (!entry) return null;
  return readDoc(entry.file);
}

/** All known rubric doc filenames (for listing / tooling). */
export function listRubricDocFiles(): string[] {
  return RUBRIC_FILES.map((r) => r.file);
}
