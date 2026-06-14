import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import { DEFAULT_RUBRIC_MD, parseRubricMarkdown } from "../rubric/parser";
import type {
  CategoryKey,
  CategoryScores,
  Confidence,
  ExtractedFeatures,
  SalaryValue,
} from "../types";

const MODEL = "claude-sonnet-4-6";

function getClient() {
  if (!hasAnthropic()) return null;
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export function computeCategoryScores(
  features: ExtractedFeatures,
  weights: Record<CategoryKey, number>,
): CategoryScores {
  const writingPenalty = features.aiBoilerplateTell ? 0.65 : 1;
  const tenureScore = Math.min(
    weights.tenure,
    Math.round((features.tenureMonths / 48) * weights.tenure),
  );

  return {
    principal: Math.round(weights.principal * (features.principalType.includes("owner") ? 0.95 : 0.75)),
    environment: Math.round(weights.environment * 0.8),
    scope: Math.min(
      weights.scope,
      Math.round((features.scopeVerbs.length / 6) * weights.scope),
    ),
    writing: Math.round(features.writingQuality * weights.writing * writingPenalty),
    tenure: tenureScore,
    local: Math.round(features.localFit * weights.local),
  };
}

export function totalFromCategories(scores: CategoryScores): number {
  return Object.values(scores).reduce((sum, value) => sum + value, 0);
}

export function salaryValueFromFeatures(
  features: ExtractedFeatures,
  total: number,
): SalaryValue {
  const salary = features.salaryExpectation?.toLowerCase() ?? "";
  if (!salary || salary.includes("market")) return "unstated";
  if (total >= 85) return "justified";
  if (total >= 75) return "great value";
  if (total >= 65) return "rich for fit";
  return "poor value";
}

export async function extractFeaturesFromCandidate(input: {
  name: string;
  resumeText: string;
  answers: Record<string, string>;
  coverLetter?: string | null;
  interviewEvidence?: string | null;
  recruiterComments?: string | null;
}): Promise<ExtractedFeatures> {
  const client = getClient();
  if (!client) {
    return heuristicExtraction(input);
  }

  const prompt = `Extract structured hiring features for RDI Trials. Return JSON only.
Candidate: ${input.name}
Resume/experience text:
${input.resumeText}

Application answers:
${JSON.stringify(input.answers, null, 2)}

Cover letter:
${input.coverLetter ?? "None"}

Interview / async video evidence (post-application — weight heavily when present):
${input.interviewEvidence?.trim() || "None yet"}

Recruiter notes from Workable (context only, not primary evidence):
${input.recruiterComments?.trim() || "None"}

Rules:
- Job-relevant evidence only. Never extract protected-class attributes.
- Each claim must include sourceType (resume|answer|application_field), sourceRef, and quote.
- Flag aiBoilerplateTell if writing mirrors job-post language with no concrete detail.

JSON shape:
{
  "principalType": "technician|owner|mixed",
  "companySize": "startup|mid|enterprise|unknown",
  "tenureMonths": number,
  "scopeVerbs": string[],
  "writingQuality": 0-1,
  "localFit": 0-1,
  "aiBoilerplateTell": boolean,
  "salaryExpectation": string|null,
  "claims": [{"category":"principal|environment|scope|writing|tenure|local","claim":"","sourceType":"","sourceRef":"","quote":""}]
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0]?.type === "text" ? response.content[0].text : "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch?.[0] ?? "{}") as ExtractedFeatures;
}

function heuristicExtraction(input: {
  resumeText: string;
  answers: Record<string, string>;
}): ExtractedFeatures {
  const combined = `${input.resumeText}\n${Object.values(input.answers).join("\n")}`.toLowerCase();
  const scopeVerbs = ["built", "led", "redesigned", "established", "managed", "owned"].filter(
    (verb) => combined.includes(verb),
  );
  const aiBoilerplateTell =
    combined.includes("positive working relationship") ||
    combined.includes("prevent recurrence");

  return {
    principalType: combined.includes("audit") || combined.includes("board")
      ? "owner"
      : "technician",
    companySize: "unknown",
    tenureMonths: 36,
    scopeVerbs,
    writingQuality: aiBoilerplateTell ? 0.45 : 0.72,
    localFit: combined.includes("los angeles") ? 0.9 : 0.6,
    aiBoilerplateTell,
    salaryExpectation: null,
    claims: scopeVerbs.slice(0, 3).map((verb, index) => ({
      category: "scope" as CategoryKey,
      claim: `Demonstrated ${verb} language in application materials`,
      sourceType: "resume",
      sourceRef: `resume:bullet-${index + 1}`,
      quote: verb,
    })),
  };
}

export function confidenceFromFeatures(features: ExtractedFeatures): Confidence {
  if (features.aiBoilerplateTell) return "text-unreliable";
  if (features.claims.length >= 4) return "high";
  return "medium";
}

export function getDefaultRubric() {
  return parseRubricMarkdown(DEFAULT_RUBRIC_MD);
}
