import { pathToFileURL } from "node:url";
import path from "node:path";

const memoryUrl = pathToFileURL(path.resolve("tests/support/memory-supabase.mjs")).href;
const serverOnlyUrl = pathToFileURL(path.resolve("tests/support/server-only-stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: serverOnlyUrl, shortCircuit: true };
  }
  if (specifier.includes("supabase/server")) {
    return { url: memoryUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
