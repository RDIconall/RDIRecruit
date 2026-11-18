/**
 * tsx loads these tests as CommonJS, so the Node ESM loader hook never sees
 * the require() calls. Patch module resolution for the modules the attack
 * path crosses: the server-only marker, Clerk's session, Next's cache
 * revalidation, the Supabase client, and the grading queue.
 */
const Module = require("node:module");
const path = require("node:path");

const dir = __dirname;
const original = Module._resolveFilename;

const exact = {
  "server-only": path.join(dir, "../../node_modules/server-only/empty.js"),
  "@clerk/nextjs/server": path.join(dir, "clerk-mock.cjs"),
  "next/cache": path.join(dir, "cache-mock.cjs"),
};

function mapped(request) {
  if (process.env.FOUNDER_IDENTITY_TEST !== "1") return null;
  if (exact[request]) return exact[request];
  const clerk = String(request).replace(/\\/g, "/");
  if (clerk.includes("/@clerk/nextjs/") && clerk.endsWith("/server/index.js")) {
    return exact["@clerk/nextjs/server"];
  }
  const norm = String(request).replace(/\\/g, "/");
  if (
    norm === "@/lib/supabase/server" ||
    norm.endsWith("/lib/supabase/server") ||
    norm.endsWith("/supabase/server") ||
    norm.endsWith("/supabase/server.ts") ||
    norm.endsWith("/supabase/server.js")
  ) {
    return path.join(dir, "supabase-mock.cjs");
  }
  if (
    norm === "@/lib/analysis/run" ||
    norm.endsWith("/lib/analysis/run") ||
    norm.endsWith("/analysis/run") ||
    norm.endsWith("/analysis/run.ts") ||
    norm.endsWith("/analysis/run.js")
  ) {
    return path.join(dir, "analysis-mock.cjs");
  }
  return null;
}

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  const hit = mapped(request);
  if (hit) return hit;
  return original.call(this, request, parent, isMain, options);
};
