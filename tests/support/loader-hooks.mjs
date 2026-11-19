import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverOnly = pathToFileURL(path.join(here, "server-only-stub.mjs")).href;
const anthropic = pathToFileURL(path.join(here, "fake-anthropic-esm.mjs")).href;
const supabase = pathToFileURL(path.join(here, "fake-supabase-esm.mjs")).href;

function isSupabaseServer(specifier) {
  return typeof specifier === "string" && /supabase[/\\]server(\.|$)/.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: serverOnly, shortCircuit: true };
  if (specifier === "@anthropic-ai/sdk" || specifier.startsWith("@anthropic-ai/sdk/")) {
    return { url: anthropic, shortCircuit: true };
  }
  if (isSupabaseServer(specifier)) return { url: supabase, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.startsWith("file:")) {
    let filename = "";
    try {
      filename = fileURLToPath(resolved.url);
    } catch {
      filename = "";
    }
    if (isSupabaseServer(filename)) return { url: supabase, shortCircuit: true };
  }
  return resolved;
}
