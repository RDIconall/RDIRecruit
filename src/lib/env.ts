import { z } from "zod";

const envSchema = z.object({
  WORKABLE_TOKEN: z.string().optional(),
  WORKABLE_API_KEY: z.string().optional(),
  WORKABLE_SUBDOMAIN: z.string().default("rditrials"),
  WORKABLE_WEBHOOK_SECRET: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  SUPABASE_DB_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  VIDEOASK_API_KEY: z.string().optional(),
  VIDEOASK_WEBHOOK_SECRET: z.string().optional(),
  CALENDLY_TOKEN: z.string().optional(),
  FIREFLIES_API_KEY: z.string().optional(),
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
