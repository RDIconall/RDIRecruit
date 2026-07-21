import { z } from "zod";

const envSchema = z.object({
  WORKABLE_TOKEN: z.string().optional(),
  WORKABLE_API_KEY: z.string().optional(),
  WORKABLE_SUBDOMAIN: z.string().default("rditrials"),
  WORKABLE_WEBHOOK_SECRET: z.string().optional(),
  // Member id credited with candidate write actions (move/disqualify/revert/
  // comment). Required by the SPI v3 action endpoints; when unset those writes
  // skip gracefully (logged, no throw). Discover it via GET /members.
  WORKABLE_MEMBER_ID: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  SUPABASE_DB_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  // Outbound email (SMTP) for the daily applicant summary. Defaults are tuned
  // for Google Workspace / Gmail with an app password, so the summary is sent
  // from your own address to you + Lara — no third-party service, no domain to
  // verify. All optional: when unset the cron still runs and skips the send.
  SMTP_HOST: z.string().default("smtp.gmail.com"),
  SMTP_PORT: z.string().optional(), // 465 (SSL, default) or 587 (STARTTLS)
  SMTP_USER: z.string().optional(), // your full email address
  SMTP_PASS: z.string().optional(), // a Google "app password" (needs 2FA on the account)
  // Optional "from" override, e.g. "RDIRecruit <you@rditrials.com>". Defaults to SMTP_USER.
  SUMMARY_EMAIL_FROM: z.string().optional(),
  // Comma-separated recipient list for the daily summary (you + Lara).
  SUMMARY_EMAIL_TO: z.string().optional(),
  VIDEOASK_API_KEY: z.string().optional(),
  VIDEOASK_WEBHOOK_SECRET: z.string().optional(),
  CALENDLY_TOKEN: z.string().optional(),
  FIREFLIES_API_KEY: z.string().optional(),
  // Geoapify (free tier: 3,000 credits/day, no card) — geocoding + driving-time
  // for the candidate commute read. Optional: when unset we fall back to the
  // Claude geographic estimate. https://www.geoapify.com/
  GEOAPIFY_API_KEY: z.string().optional(),
  // The office candidates commute to. Configurable so the address lives in one
  // place; defaults to the RDI Van Nuys office.
  RDI_OFFICE_ADDRESS: z.string().default("Van Nuys, CA, USA"),
  // Talent Radar people/contact enrichment providers. Both optional: when a key
  // is unset the provider is simply skipped (the UI still works via CSV/manual).
  SEAMLESS_API_KEY: z.string().optional(),
  APOLLO_API_KEY: z.string().optional(),
  // Public base URL used to build outbound unsubscribe links. Falls back to
  // VERCEL_URL (auto-set on Vercel) so opt-out links resolve in every env.
  RADAR_PUBLIC_URL: z.string().optional(),
  VERCEL_URL: z.string().optional(),
  // Comma-separated Clerk login allowlist. When unset, any authenticated user may
  // access the app. Set in production to restrict who can use RDIRecruit.
  APP_ALLOWED_EMAILS: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export function getWorkableToken(): string {
  const token = env.WORKABLE_TOKEN ?? env.WORKABLE_API_KEY;
  if (!token) {
    throw new Error("WORKABLE_TOKEN or WORKABLE_API_KEY is required");
  }
  return token;
}

export function hasWorkable(): boolean {
  return Boolean(env.WORKABLE_TOKEN ?? env.WORKABLE_API_KEY);
}

export function hasSupabase(): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

export function hasAnthropic(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/** Outbound email is configured when we have SMTP creds and a recipient. */
export function hasEmail(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SUMMARY_EMAIL_TO);
}

/** Parsed recipient list for the daily summary (comma-separated env var). */
export function summaryRecipients(): string[] {
  return (env.SUMMARY_EMAIL_TO ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}

export function hasGeoapify(): boolean {
  return Boolean(env.GEOAPIFY_API_KEY);
}

export function hasSeamless(): boolean {
  return Boolean(env.SEAMLESS_API_KEY);
}

export function hasApollo(): boolean {
  return Boolean(env.APOLLO_API_KEY);
}

/** Public origin for building outbound links (e.g. unsubscribe). */
export function publicBaseUrl(): string {
  if (env.RADAR_PUBLIC_URL) return env.RADAR_PUBLIC_URL.replace(/\/$/, "");
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL.replace(/\/$/, "")}`;
  return "http://localhost:3000";
}
