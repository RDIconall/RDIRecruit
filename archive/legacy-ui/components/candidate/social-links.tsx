/**
 * Social-profile links for the candidate view, so a reviewer can click through
 * and confirm the profile matches the candidate.
 *
 * INFRASTRUCTURE NOTE: there is no people-search / enrichment API wired into this
 * app, so we cannot scrape or resolve a profile server-side. Two sources, in
 * priority order:
 *   1. REAL profile URLs already on the candidate record — Workable's
 *      `social_profiles` array (verified links, opened directly).
 *   2. GENERATED search links — a name-seeded, platform-scoped Google search the
 *      recruiter clicks to find and verify the profile by hand.
 * The derivation is kept inline here (no shared lib) so the component is
 * self-contained and stable.
 */

type SocialPlatform = "linkedin" | "facebook" | "instagram";

interface SocialLink {
  platform: SocialPlatform;
  label: string;
  url: string;
  /** true = real profile URL on file; false = generated search to verify by hand. */
  found: boolean;
}

const PLATFORMS: Array<{ platform: SocialPlatform; label: string; domain: string }> = [
  { platform: "linkedin", label: "LinkedIn", domain: "linkedin.com/in" },
  { platform: "facebook", label: "Facebook", domain: "facebook.com" },
  { platform: "instagram", label: "Instagram", domain: "instagram.com" },
];

/** Map a Workable social-profile `type`/`name`/url onto one of our three platforms. */
function platformOf(value: string | undefined | null): SocialPlatform | null {
  const v = (value ?? "").toLowerCase();
  if (v.includes("linkedin")) return "linkedin";
  if (v.includes("facebook") || v === "fb" || v.includes("fb.com")) return "facebook";
  if (v.includes("instagram") || v === "ig") return "instagram";
  return null;
}

/** Pull any real profile URLs Workable already stored on the candidate. */
function realProfiles(raw: Record<string, unknown> | null | undefined): Partial<Record<SocialPlatform, string>> {
  const out: Partial<Record<SocialPlatform, string>> = {};
  const list = raw?.["social_profiles"];
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const url = typeof e.url === "string" ? e.url : null;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const platform = platformOf(typeof e.type === "string" ? e.type : null) ??
      platformOf(typeof e.name === "string" ? e.name : null) ??
      platformOf(url);
    if (platform && !out[platform]) out[platform] = url;
  }
  return out;
}

/** Build a name-seeded, platform-scoped Google search the recruiter can click. */
function searchUrl(domain: string, name: string, context: string[]): string {
  const cleanName = name.replace(/^Dr\.\s*/i, "").trim();
  const query = [`"${cleanName}"`, ...context, `site:${domain}`].filter(Boolean).join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function deriveLinks(input: {
  name: string | null | undefined;
  location?: string | null;
  company?: string | null;
  raw?: Record<string, unknown> | null;
}): SocialLink[] {
  const name = (input.name ?? "").trim();
  if (!name) return [];

  const real = realProfiles(input.raw);
  const city = input.location?.replace(/^remote\s*[—-]\s*/i, "").split(",")[0]?.trim();
  const context = [input.company?.trim(), city].filter((v): v is string => Boolean(v));

  return PLATFORMS.map(({ platform, label, domain }) => {
    const realUrl = real[platform];
    if (realUrl) return { platform, label, url: realUrl, found: true };
    return { platform, label, url: searchUrl(domain, name, context), found: false };
  });
}

export function SocialLinks({
  name,
  location,
  company,
  raw,
}: {
  name: string | null | undefined;
  location?: string | null;
  company?: string | null;
  raw?: Record<string, unknown> | null;
}) {
  const links = deriveLinks({ name, location, company, raw });
  if (!links.length) return null;
  const anyFound = links.some((l) => l.found);

  return (
    <div className="mt-[18px] flex flex-wrap items-center gap-2.5">
      <span className="font-mono text-[12px] text-navy/45">verify identity:</span>
      {links.map((link) => (
        <a
          key={link.platform}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-full border border-navy/20 px-4 py-1.5 text-[13px] text-navy hover:border-orange hover:text-orange"
          title={link.found ? `${link.label} profile on file` : `Search ${link.label} to verify identity`}
        >
          {link.label}
          <span className="text-navy/35">{link.found ? " ↗" : " ↗ search"}</span>
        </a>
      ))}
      {!anyFound ? (
        <span className="font-mono text-[11px] text-navy/35">
          generated lookups — confirm the result is the same person
        </span>
      ) : null}
    </div>
  );
}
