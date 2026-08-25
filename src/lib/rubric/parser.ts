import type { CategoryKey, RubricSchemaVersion, SeatDimension } from "../types";

export interface RubricDefinition {
  schemaVersion: RubricSchemaVersion;
  categories: CategoryKey[];
  dimensions: SeatDimension[];
  tiers: {
    strong: number;
    viable: number;
    hold: number;
  };
  gates: string[];
  dangerousFlags: string[];
  deductionRules: Array<{ category: CategoryKey; rule: string }>;
  deductions: string[];
  alternateSeatRules: string[];
}

export interface ParsedRubric {
  version: number;
  name: string;
  rawMd: string;
  schemaVersion: RubricSchemaVersion;
  definition: RubricDefinition;
  weights: Record<CategoryKey, number>;
  dimensions: SeatDimension[];
}

const DEFAULT_WEIGHTS: Record<CategoryKey, number> = {
  principal: 25,
  environment: 20,
  scope: 20,
  writing: 15,
  tenure: 10,
  local: 10,
};

export const DEFAULT_RUBRIC_MD = `# RDI Default Rubric

## Weights
- Principal: 25
- Environment: 20
- Scope: 20
- Writing: 15
- Tenure: 10
- Local: 10

## Tiers
- Strong: 85
- Viable: 70
- Hold: 55

## Dangerous candidate flags
- Material misrepresentation across sources
- Ego / coachability hard no
- Protected-class inference attempts

## Deduction rules
- Writing: Generic AI boilerplate without concrete detail
- Tenure: Short stints without explanation
- Scope: Task-level verbs only for a judgment seat
`;

function slugLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function sectionAfter(rawMd: string, heading: string): string {
  const lines = rawMd.split("\n");
  const headingRx = new RegExp(`^#{0,3}\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:?\\s*$`, "i");
  const start = lines.findIndex((line) => headingRx.test(line.trim()));
  if (start === -1) return "";

  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    const uppercaseBlockHeading =
      /^[A-Z][A-Z0-9 /&+.-]{3,}:$/.test(trimmed) && trimmed === trimmed.toUpperCase();
    if (/^#{1,3}\s+/.test(trimmed) || uppercaseBlockHeading) break;
    out.push(lines[i]!);
  }
  return out.join("\n");
}

function parseCriticalMinimum(block: string, weight: number): number | undefined {
  if (!/critical/i.test(block)) return undefined;
  const explicit = block.match(/below\s+(\d+)\s*\/\s*(\d+)/i);
  if (explicit) return Math.min(weight, Number(explicit[1]));
  const scoreBelow = block.match(/score\s+is\s+below\s+(\d+)/i);
  if (scoreBelow) return Math.min(weight, Number(scoreBelow[1]));
  const noEvidence = block.match(/without\s+credible|no\s+experience-backed|no\s+meaningful/i);
  return noEvidence ? 1 : undefined;
}

function parseEvidenceRequirements(block: string): string[] {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const evidence: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (/^(evidence|high evidence|strongest evidence|high signal|must understand)/i.test(line)) {
      collecting = true;
      continue;
    }
    if (/^(medium|low|critical|gates|do not|target phenotype|location):?/i.test(line)) {
      collecting = false;
    }
    const bullet = line.replace(/^[-*]\s*/, "").trim();
    if (collecting && bullet && !/^[A-Z][A-Z /&+.-]+:?$/.test(bullet)) evidence.push(bullet);
  }
  return [...new Set(evidence)].slice(0, 12);
}

function parseSeatDimensions(rawMd: string): SeatDimension[] {
  const dimensionsBlock = sectionAfter(rawMd, "Dimensions") || rawMd.split(/\bDIMENSIONS:\s*/i)[1]?.split(/\bGATES:\s*/i)[0] || "";
  if (!dimensionsBlock.trim()) return [];

  const matches = [...dimensionsBlock.matchAll(/^\s*(\d+)\.\s+(.+?)\s+(?:--?|—|–)\s*(\d{1,3})\s*$/gim)];
  if (!matches.length) return [];

  return matches.map((match, index) => {
    const label = match[2]!.trim().replace(/\s+/g, " ");
    const weight = Number(match[3]);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? dimensionsBlock.length;
    const block = dimensionsBlock.slice(start, end).trim();
    const description = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^[-*]\s+/.test(line) && !/^(high|medium|low|critical|evidence requirements?):?/i.test(line))
      .slice(0, 4)
      .join(" ")
      .slice(0, 700);
    return {
      key: slugLabel(label),
      label,
      weight,
      description,
      evidenceRequirements: parseEvidenceRequirements(block),
      ...(parseCriticalMinimum(block, weight) != null ? { criticalMinimum: parseCriticalMinimum(block, weight) } : {}),
    };
  });
}

function parseListSection(rawMd: string, headings: string[]): string[] {
  for (const heading of headings) {
    const section = sectionAfter(rawMd, heading) || rawMd.split(new RegExp(`\\b${heading}:\\s*`, "i"))[1]?.split(/\n[A-Z][A-Z /&+.-]{3,}:\s*\n/)[0] || "";
    const items = section
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line && !/^[A-Z][A-Z /&+.-]+:?$/.test(line));
    if (items.length) return items;
  }
  return [];
}

export function rubricWeightTotal(dimensions: SeatDimension[]): number {
  return dimensions.reduce((sum, d) => sum + d.weight, 0);
}

export function hasValidSeatDimensions(dimensions: SeatDimension[]): boolean {
  return dimensions.length > 0 && rubricWeightTotal(dimensions) === 100;
}

export function parseRubricMarkdown(rawMd: string, name = "Default"): ParsedRubric {
  const weights = { ...DEFAULT_WEIGHTS };
  const weightLine = rawMd.match(/Principal:\s*(\d+)/i);
  if (weightLine) {
    const lines = rawMd.split("\n");
    for (const line of lines) {
      const match = line.match(/^-\s*(\w+):\s*(\d+)/i);
      if (!match) continue;
      const key = match[1]!.toLowerCase();
      if (key in weights) {
        weights[key as CategoryKey] = Number(match[2]);
      }
    }
  }

  const strong = Number(rawMd.match(/Strong:\s*(\d+)/i)?.[1] ?? 85);
  const viable = Number(rawMd.match(/Viable:\s*(\d+)/i)?.[1] ?? 70);
  const hold = Number(rawMd.match(/Hold:\s*(\d+)/i)?.[1] ?? 55);

  const dangerousFlags = rawMd
    .split("## Dangerous candidate flags")[1]
    ?.split("##")[0]
    ?.split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean) ?? [];

  const deductionRules =
    rawMd
      .split("## Deduction rules")[1]
      ?.split("##")[0]
      ?.split("\n")
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter(Boolean)
      .map((line) => {
        const [category, ...rest] = line.split(":");
        return {
          category: (category?.trim().toLowerCase() ?? "writing") as CategoryKey,
          rule: rest.join(":").trim(),
        };
      }) ?? [];

  const dimensions = parseSeatDimensions(rawMd);
  const schemaVersion: RubricSchemaVersion = hasValidSeatDimensions(dimensions)
    ? "seat-dimensions-v2"
    : "legacy-v1";
  const gates = parseListSection(rawMd, ["Gates", "Dangerous candidate flags"]);
  const deductions = parseListSection(rawMd, ["Deductions", "Deduction rules", "Do not over-reward"]);
  const alternateSeatRules = parseListSection(rawMd, ["Alternate-seat rules", "Alternate seat rules"]);

  return {
    version: 1,
    name,
    rawMd,
    schemaVersion,
    weights,
    dimensions,
    definition: {
      schemaVersion,
      categories: Object.keys(weights) as CategoryKey[],
      dimensions,
      tiers: { strong, viable, hold },
      gates,
      dangerousFlags,
      deductionRules,
      deductions,
      alternateSeatRules,
    },
  };
}

export function tierForScore(total: number, rubric: ParsedRubric): string {
  if (total >= rubric.definition.tiers.strong) return "Strong";
  if (total >= rubric.definition.tiers.viable) return "Viable";
  if (total >= rubric.definition.tiers.hold) return "Hold";
  return "Low";
}
