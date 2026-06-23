import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// Files the résumé pipeline loads at RUNTIME via dynamic/string requires that
// @vercel/nft cannot see, so they must be force-traced into every serverless
// function that can ingest a résumé.
//
//  - pdfjs-dist legacy build: pdf-parse dynamically imports `pdf.worker.mjs`.
//  - mupdf / tesseract.js(-core): WASM + worker assets for the scanned-PDF OCR
//    fallback. Both are in `serverExternalPackages`, so nft does NOT follow
//    their internal requires — and tesseract's worker-script does runtime
//    `require('bmp-js')`, `zlibjs`, `node-fetch`, etc. Those transitive deps
//    must be traced explicitly or the worker thread crashes with
//    "Cannot find module 'bmp-js'" and the function hangs to its timeout.
const RESUME_PIPELINE_TRACE = [
  "./node_modules/pdfjs-dist/legacy/build/**",
  "./node_modules/mupdf/dist/**",
  "./node_modules/tesseract.js/**",
  "./node_modules/tesseract.js-core/**",
  // tesseract.js runtime dependency closure (dynamically required in its worker):
  "./node_modules/bmp-js/**",
  "./node_modules/idb-keyval/**",
  "./node_modules/is-url/**",
  "./node_modules/node-fetch/**",
  "./node_modules/regenerator-runtime/**",
  "./node_modules/tr46/**",
  "./node_modules/wasm-feature-detect/**",
  "./node_modules/webidl-conversions/**",
  "./node_modules/whatwg-url/**",
  "./node_modules/zlibjs/**",
];

const nextConfig: NextConfig = {
  turbopack: {
    root: projectRoot,
  },
  // mupdf + tesseract.js are the WASM-only OCR fallback for scanned PDFs. They
  // load their own .wasm / worker assets at runtime, so they must stay external
  // (un-bundled) and their package dirs traced into the serverless function.
  serverExternalPackages: ["pdf-parse", "mammoth", "mupdf", "tesseract.js"],
  outputFileTracingIncludes: {
    "/": RESUME_PIPELINE_TRACE,
    "/api/cron/backfill-resumes": RESUME_PIPELINE_TRACE,
    "/api/**": RESUME_PIPELINE_TRACE,
    "/**": RESUME_PIPELINE_TRACE,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
};

export default nextConfig;
