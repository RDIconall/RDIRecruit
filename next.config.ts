import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  serverExternalPackages: ["pdf-parse", "mammoth"],
  // Ship the canonical evaluation docs with every server function so the grader,
  // cron, and webhooks can read the global method + seat rubrics at runtime.
  outputFileTracingIncludes: {
    "/**/*": ["./docs/**/*.md"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
};

export default nextConfig;
