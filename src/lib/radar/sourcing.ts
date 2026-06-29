import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env, hasAnthropic } from "../env";
import { EMPTY_CRITERIA, type Pipeline, type SearchCriteria } from "./types";

const MODEL = "claude-sonnet-4-6";

export interface SourcingPlan {
  title: string;
  rationale: string;
  searches: { label: string; criteria: SearchCriteria }[];
}

const DEFAULT_RECRUITING_BRIEF = `Clinical Operations Lead / Study Control Lead for a small, fast-moving IVD/diagnostics sponsor. Need hands-on clinical execution, site startup, monitoring/query readiness, sample-heavy or lab-connected studies, sponsor communication, and comfort in ambiguity. Avoid large-company process-only operators.`;

function arr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
}

function criteriaFrom(raw: unknown): SearchCriteria {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    titles: arr(r.titles).slice(0, 10),
    keywords: arr(r.keywords).slice(0, 10),
    companies: arr(r.companies).slice(0, 20),
    locations: arr(r.locations).slice(0, 10),
    relocationAllowed: r.relocationAllowed !== false,
    mustHave: arr(r.mustHave),
    exclude: arr(r.exclude),
  };
}

function fallbackPlan(pipeline: Pipeline, brief: string): SourcingPlan {
  const isBd = pipeline === "bd";
  const text = brief.trim() || (isBd ? "IVD diagnostics business development contacts" : DEFAULT_RECRUITING_BRIEF);
  return {
    title: isBd ? "AI BD sourcing" : "AI recruiting sourcing",
    rationale: "Fallback plan generated without Claude.",
    searches: [
      {
        label: "Core fit",
        criteria: {
          ...EMPTY_CRITERIA,
          titles: isBd
            ? ["Clinical Affairs", "Medical Affairs", "Business Development", "Product Development"]
            : ["Clinical Operations Lead", "Clinical Study Manager", "Clinical Project Manager"],
          keywords: isBd
            ? ["IVD", "diagnostics", "clinical trials", "assay"]
            : ["IVD", "diagnostics", "GCP", "site activation", "monitoring"],
          mustHave: text ? [text.slice(0, 120)] : [],
        },
      },
    ],
  };
}

function systemPrompt(pipeline: Pipeline, scorecardMd: string): string {
  return `You are RDI's sourcing strategist. Convert a plain-English ${pipeline} brief into concrete people-search queries for APIs like Seamless/Apollo.

Rules:
- Return JSON only.
- Do not ask the user to tune Boolean syntax.
- Generate 2-4 search variants.
- Use actual job titles in "titles".
- Use concepts/skills/industries in "keywords".
- Put "companies" only when the brief names real company names; never put broad categories like "small CROs" or "startup diagnostics companies" there.
- Use broad adjacent titles so we can discover good career paths, not only exact title matches.
- Keep every array short and high-signal.
- Respect compliance: do not suggest scraping LinkedIn. The app will use permitted provider data/imported profile data only.

Scorecard context:
"""
${scorecardMd.slice(0, 6000)}
"""

Return exactly:
{
  "title": "<short saved search title>",
  "rationale": "<one sentence explaining the sourcing strategy>",
  "searches": [
    {
      "label": "<variant label>",
      "criteria": {
        "titles": ["..."],
        "keywords": ["..."],
        "companies": ["real company names only, otherwise empty"],
        "locations": ["country/state/city terms if specified"],
        "relocationAllowed": true,
        "mustHave": ["..."],
        "exclude": ["..."]
      }
    }
  ]
}`;
}

export async function planSourcingSearches(input: {
  pipeline: Pipeline;
  brief: string;
  scorecardMd: string;
}): Promise<SourcingPlan> {
  const brief = input.brief.trim();
  if (!hasAnthropic()) return fallbackPlan(input.pipeline, brief);

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1800,
      system: systemPrompt(input.pipeline, input.scorecardMd),
      messages: [{ role: "user", content: brief || fallbackPlan(input.pipeline, brief).searches[0].criteria.mustHave.join("\n") }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] ?? "{}") as Record<string, unknown>;
    const searchesRaw = Array.isArray(parsed.searches) ? parsed.searches.slice(0, 4) : [];
    const searches = searchesRaw
      .map((s, idx) => {
        const row = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
        return {
          label: String(row.label ?? `Variant ${idx + 1}`).trim(),
          criteria: criteriaFrom(row.criteria),
        };
      })
      .filter((s) => s.criteria.titles.length || s.criteria.keywords.length || s.criteria.companies.length);

    if (!searches.length) return fallbackPlan(input.pipeline, brief);

    return {
      title: String(parsed.title ?? "").trim().slice(0, 80) || fallbackPlan(input.pipeline, brief).title,
      rationale: String(parsed.rationale ?? "").trim().slice(0, 500),
      searches,
    };
  } catch (error) {
    console.error("Radar sourcing plan failed", error);
    return fallbackPlan(input.pipeline, brief);
  }
}
