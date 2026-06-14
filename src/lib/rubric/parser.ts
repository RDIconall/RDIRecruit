import type { CategoryKey } from "../types";

export interface RubricDefinition {
  categories: CategoryKey[];
  tiers: {
    strong: number;
    viable: number;
    hold: number;
  };
  dangerousFlags: string[];
  deductionRules: Array<{ category: CategoryKey; rule: string }>;
}

export interface ParsedRubric {
  version: number;
  name: string;
  rawMd: string;
  definition: RubricDefinition;
  weights: Record<CategoryKey, number>;
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

  return {
    version: 1,
    name,
    rawMd,
    weights,
    definition: {
      categories: Object.keys(weights) as CategoryKey[],
      tiers: { strong, viable, hold },
      dangerousFlags,
      deductionRules,
    },
  };
}

export function tierForScore(total: number, rubric: ParsedRubric): string {
  if (total >= rubric.definition.tiers.strong) return "Strong";
  if (total >= rubric.definition.tiers.viable) return "Viable";
  if (total >= rubric.definition.tiers.hold) return "Hold";
  return "Low";
}
