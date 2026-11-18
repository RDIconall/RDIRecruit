import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverOnlyEmpty = pathToFileURL(path.join(root, "node_modules/server-only/empty.js")).href;
const fakeSupabase = pathToFileURL(path.join(root, "tests/fake-service-supabase.mjs")).href;
const fakeAnalysisRun = pathToFileURL(path.join(root, "tests/fake-analysis-run.mjs")).href;

function redirected(specifier, resolvedUrl) {
  const request = `${specifier} ${resolvedUrl ?? ""}`;
  if (specifier === "server-only" || request.includes("/node_modules/server-only/index.js")) return serverOnlyEmpty;
  if (request.includes("/supabase/server.ts") || request.includes("/supabase/server.js") || request.endsWith("/supabase/server")) {
    return fakeSupabase;
  }
  if (request.includes("/analysis/run.ts") || request.includes("/analysis/run.js") || request.endsWith("/analysis/run")) {
    return fakeAnalysisRun;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const direct = redirected(specifier, "");
    if (direct && specifier === "server-only") {
      return { url: direct, shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    const replacement = redirected(specifier, resolved?.url);
    if (!replacement) return resolved;
    return { url: replacement, shortCircuit: true };
  },
});
