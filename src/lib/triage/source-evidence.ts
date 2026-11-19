/**
 * Deterministic check on the applicant's own materials that an Interview call
 * has to clear before it reaches the board.
 *
 * The résumé, screening answers, cover letter, and parsed role blurbs are all
 * written by the applicant and are read by the model that returns the hiring
 * JSON. So the model's verdict cannot be the call by itself: a file can only be
 * an Interview when the source materials carry dated work history to stand
 * behind it, and none of that text is addressed to the grader. A file that
 * fails either check holds as a Backup with the reason in its copy; the model's
 * prose stays on the file as commentary. A human's manual decision is untouched.
 */

export interface SourceMaterials {
  resumeText?: string | null;
  answers?: Record<string, unknown> | null;
  coverLetter?: string | null;
  roles?: Array<{
    title?: string | null;
    company?: string | null;
    start?: string | null;
    end?: string | null;
    summary?: string | null;
    resumeLine?: string | null;
  }> | null;
}

export interface GraderInstruction {
  /** Which applicant field carried it (résumé, screening answers, …). */
  field: string;
  /** A short excerpt around the match, for the red flag. */
  excerpt: string;
}

export interface SourceEvidence {
  clears: boolean;
  /** One sentence naming why an Interview call is held back (null when it clears). */
  reason: string | null;
  /** What a human has to settle before booking (null when it clears). */
  caveat: string | null;
  graderInstruction: GraderInstruction | null;
  datedRoles: number;
}

// Characters a reader cannot see but a model still reads (zero-width, bidi
// controls, soft hyphen, BOM).
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Unicode "tag" characters mirror ASCII invisibly; any of them in an
// application is hidden text aimed at a model.
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/u;
const TAG_CHARS_GLOBAL = /[\u{E0000}-\u{E007F}]/gu;

/** Strip text a human reviewer cannot see before it is sent to a model. */
export function stripHiddenText(text: string): string {
  return text.replace(TAG_CHARS_GLOBAL, "").replace(INVISIBLE, "");
}

const AGENT =
  "(?:ai|a\\.i\\.|llm|language model|model|grader|evaluator|screener|scorer|assistant|claude|chatgpt|gpt(?:-?\\d+)?|bot|automated (?:system|reviewer|screener|grader|evaluator|tools?)|ai (?:system|screener|recruiter|reviewer|tool)|(?:hiring|scoring|screening|recruiting|evaluation) (?:model|system|ai|software|engine|tool)|applicant tracking (?:system|software)|(?:resume|résumé|cv) (?:parser|screener|screening (?:software|tool)))";

// Latin look-alikes from Cyrillic and Greek, so "ignоre" (Cyrillic о) still reads as "ignore".
const CONFUSABLES: Record<string, string> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
  і: "i", ј: "j", ѕ: "s", ԁ: "d", ӏ: "l", ɡ: "g",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
};
const CONFUSABLE_CHARS = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

// Applied to lowercased, NFKC-normalized text.
const GRADER_INSTRUCTION_PATTERNS: RegExp[] = [
  // The grader's output schema. No résumé or answer has a reason to name it.
  /\b(?:person[_-]?quality|seat[_.-]?fit|strong[_-]seat|viable[_-]seat|wrong[_-]seat|answer[_-]?grades|category[_-]?scores|integrity[_-]?gate|seat[_-]?dimension[_-]?scores|candidate[_-]?evidence[_-]?credit|answer[_-]?provenance|authorship[_-]?confidence|decision[_-]?band|triage\.(?:why|risk|caveat|assessment|rubricfit))\b/,
  /\b(?:person quality|strong seat|viable seat|seat fit verdict)\b/,
  // Overriding the instructions or rubric.
  /\b(?:ignore|disregard|forget|override|disobey|do not follow|don'?t follow|stop following)\b[^.!?\n]{0,60}\b(?:instructions?|prompts?|rubrics?|guidelines|guidance|criteria|directions|scoring|grading|evaluation (?:rules|criteria|method)|(?:previous|prior|earlier|above|preceding|original) (?:text|messages?|content|context|rules))\b/,
  /(?:^|\n)\s*[#*>\s-]*(?:new |updated |additional |hidden |special )?(?:instructions?|system notice|note to reviewer)\s*:/,
  /\b(?:system|developer) (?:prompt|message)\b/,
  /\bprompt injection\b|\bjailbreak\b/,
  // Speaking to the model rather than about the work.
  new RegExp(`\\b(?:note|message|instructions?|directions?|reminder)s?\\s+(?:to|for)\\s+(?:the\\s+|any\\s+|all\\s+)?${AGENT}\\b`),
  new RegExp(`(?:^|[\\s,.;:!?])(?:dear|hey|hi|hello)\\s+${AGENT}\\b`),
  /\b(?:you are|you're|act as|pretend to be)\s+(?:an?\s+|the\s+)?(?:ai|language model|llm|grader|evaluator|screener|scorer|hiring model|scoring model)\b/,
  new RegExp(
    `\\b(?:if you are|if you're|to any|to the)\\s+(?:an?\\s+)?${AGENT}\\s+(?:reading|reviewing|evaluating|grading|screening|processing)\\b`,
  ),
  // Dictating the read.
  /(?:^|[.!?:;•*\n-]\s*)(?:please\s+)?(?:return|output|respond with|reply with|emit|answer with)\s+(?:only\s+)?(?:the following\s+|this\s+|valid\s+|a\s+)?json\b/,
  /\b(?:rate|score|grade|rank|classify|mark|label|treat)\s+this\s+(?:candidate|applicant|application|resume|résumé|profile|file|answers?|submission)\s+(?:as|at|with)\b/,
  /\b(?:set|make|give)\s+(?:every|all|each)\s+[a-z ]{0,30}\b(?:scores?|verdicts?|ratings?|grades?)\s+(?:to|at|a|an)\b/,
  /\b(?:your|the final)\s+(?:verdict|decision|recommendation|rating|assessment)\s+(?:should|must|has to)\s+be\b/,
  /\b(?:book|hire|shortlist|fast[\s-]?track|advance|interview)\s+this\s+(?:candidate|applicant)\b/,
  /\b(?:already|pre-?)\s*(?:been\s+)?(?:approved|cleared|vetted|selected|shortlisted)\s+(?:for|to)\s+(?:an?\s+|the\s+)?(?:interview|hire|next round)\b/,
  /\bhas been (?:approved|cleared|selected|shortlisted) (?:for|to) (?:an?\s+|the\s+)?(?:interview|hire|next round)\b/,
  /\b(?:summari[sz]e|describe|present|report|characteri[sz]e|portray|classify|list)\s+(?:this|the|my|them|him|her|it|me)\s+(?:candidate\s+|applicant\s+|application\s+|file\s+)?as\s+(?:the\s+|a\s+|an\s+)?(?:strongest|best|top|ideal|perfect|exceptional|excellent|outstanding|strong|high)\b/,
  /\b(?:strongest|best|top)\s+(?:candidate|applicant|hire)\s+(?:in|of)\s+(?:the|this)\s+(?:applicant\s+|candidate\s+)?pool\b/,
  // Chat-transcript or prompt framing.
  /\{\s*"[a-z_]+"\s*:/,
  /<\/?\s*(?:system|assistant|user|instructions?|candidate[_\s-]?materials)\b/,
  /<\|im_(?:start|end)\|>|\[\/?inst\]/,
  /(?:^|\n)\s*(?:human|assistant)\s*:/,
  /"""/,
  /<!--/,
];

// A long base64 run is an encoded payload, not résumé prose.
const ENCODED_BLOB = /(?:^|[^a-z0-9+/])[a-z0-9+/]{80,}={0,2}(?:$|[^a-z0-9+/=])/i;

const LETTER_SPACED_RUN = /\b(?:[a-z][\s._*|/-]){3,}[a-z]\b/g;
// Checked inside letter-spaced runs, which collapse adjacent words together.
// Spaced-out résumé headings ("e x p e r i e n c e") contain none of these.
const SPACED_KEYWORDS =
  /ignore|disregard|instruction|rubric|prompt|personquality|seatfit|strongseat|viableseat|json|grader|evaluator|verdict/;

/** Collapse letter-spaced words ("i g n o r e") so the patterns still apply. */
function collapseLetterSpacing(text: string): string {
  return text.replace(LETTER_SPACED_RUN, (run) => run.replace(/[\s._*|/-]/g, ""));
}

function spacedKeyword(text: string): string | null {
  for (const match of text.matchAll(LETTER_SPACED_RUN)) {
    if (SPACED_KEYWORDS.test(match[0].replace(/[\s._*|/-]/g, ""))) {
      return excerptAround(text, match.index ?? 0, match[0].length);
    }
  }
  return null;
}

function normalizeForScan(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(CONFUSABLE_CHARS, (ch) => CONFUSABLES[ch] ?? ch)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[ \t\f\v]+/g, " ");
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 50);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** The first passage in `text` that addresses or instructs the grader, if any. */
export function findGraderInstruction(text: string | null | undefined): string | null {
  if (!text) return null;
  if (TAG_CHARS.test(text)) return "Hidden (invisible) characters embedded in the text.";
  const encoded = ENCODED_BLOB.exec(text);
  if (encoded) return `Encoded block: ${encoded[0].trim().slice(0, 40)}…`;
  const normalized = normalizeForScan(text);
  for (const scanned of [normalized, collapseLetterSpacing(normalized)]) {
    for (const pattern of GRADER_INSTRUCTION_PATTERNS) {
      const match = pattern.exec(scanned);
      if (match) return excerptAround(scanned, match.index, match[0].length);
    }
  }
  return spacedKeyword(normalized);
}

function* applicantFields(m: SourceMaterials): Generator<[string, string]> {
  if (m.resumeText) yield ["résumé", m.resumeText];
  for (const answer of Object.values(m.answers ?? {})) {
    if (typeof answer === "string") yield ["screening answers", answer];
    else if (answer != null) yield ["screening answers", JSON.stringify(answer)];
  }
  if (m.coverLetter) yield ["cover letter", m.coverLetter];
  for (const role of m.roles ?? []) {
    for (const value of [role.title, role.company, role.start, role.end, role.summary, role.resumeLine]) {
      if (value) yield ["work history", String(value)];
    }
  }
}

function yearOf(value: string | null | undefined): number | null {
  const m = value?.match(/\b(19|20)\d{2}\b/);
  if (!m) return null;
  const year = Number(m[0]);
  return year >= 1950 && year <= new Date().getFullYear() + 1 ? year : null;
}

const RESUME_DATE_RANGE =
  /\b(?:19|20)\d{2}\s*(?:-|–|—|to|until|through)\s*(?:[a-z]{3,9}\.?\s+)?(?:(?:19|20)\d{2}|present|current|now|today)\b/gi;

function datedRoleCount(m: SourceMaterials): number {
  const parsed = (m.roles ?? []).filter(
    (r) => yearOf(r.start) != null && Boolean((r.title ?? "").trim() || (r.company ?? "").trim()),
  ).length;
  if (parsed > 0) return parsed;
  return (m.resumeText ?? "").match(RESUME_DATE_RANGE)?.length ?? 0;
}

export function assessSourceEvidence(materials: SourceMaterials): SourceEvidence {
  let graderInstruction: GraderInstruction | null = null;
  for (const [field, text] of applicantFields(materials)) {
    const excerpt = findGraderInstruction(text);
    if (excerpt) {
      graderInstruction = { field, excerpt };
      break;
    }
  }
  const datedRoles = datedRoleCount(materials);

  if (graderInstruction) {
    return {
      clears: false,
      reason: `Text addressed to the automated grader was found in the ${graderInstruction.field}, so the model read is not taken as the call — held as backup.`,
      caveat: "Read the submitted materials yourself before booking an interview.",
      graderInstruction,
      datedRoles,
    };
  }
  if (datedRoles === 0) {
    return {
      clears: false,
      reason: "No dated work history in the submitted materials backs an interview call — held as backup.",
      caveat: "Confirm the work history (roles and dates) before booking an interview.",
      graderInstruction: null,
      datedRoles,
    };
  }
  return { clears: true, reason: null, caveat: null, graderInstruction: null, datedRoles };
}
