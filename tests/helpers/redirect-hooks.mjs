import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const double = pathToFileURL(path.join(dir, "supabase-double.cjs")).href;
const empty = pathToFileURL(path.join(dir, "../../node_modules/server-only/empty.js")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: empty, shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.includes("/src/lib/supabase/server.ts")) {
    return { url: double, shortCircuit: true };
  }
  return resolved;
}
