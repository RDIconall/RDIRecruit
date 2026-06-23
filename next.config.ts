import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  serverExternalPackages: ["pdf-parse", "mammoth"],
  // pdf-parse → pdfjs-dist sets up a "fake worker" by dynamically importing
  // `pdf.worker.mjs`. That dynamic path is invisible to @vercel/nft, so the
  // worker file (and its sibling build assets) are NOT traced into the
  // serverless bundle, and every PDF parse fails at runtime with
  // "Cannot find module .../pdfjs-dist/legacy/build/pdf.worker.mjs".
  // Force-include the whole legacy build dir for any route that ingests
  // résumés (cron + the triage server actions invoked from the app).
  outputFileTracingIncludes: {
    "/": ["./node_modules/pdfjs-dist/legacy/build/**"],
    "/api/cron/backfill-resumes": ["./node_modules/pdfjs-dist/legacy/build/**"],
    "/api/**": ["./node_modules/pdfjs-dist/legacy/build/**"],
    "/**": ["./node_modules/pdfjs-dist/legacy/build/**"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
};

export default nextConfig;
