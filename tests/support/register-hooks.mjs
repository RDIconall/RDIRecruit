import Module from "node:module";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Parsed once, at first import of src/lib/env.ts. Placeholders only: the tests
// never open a network client.
process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_KEY = "placeholder-supabase-service-key";
process.env.ANTHROPIC_API_KEY = "placeholder-anthropic-key";
process.env.CRON_SECRET = "placeholder-cron-secret";
delete process.env.VIDEOASK_WEBHOOK_SECRET;
delete process.env.WORKABLE_TOKEN;
delete process.env.WORKABLE_API_KEY;
delete process.env.WORKABLE_WEBHOOK_SECRET;

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(here, "server-only-stub.cjs");
const anthropic = path.join(here, "fake-anthropic.cjs");
const supabase = path.join(here, "fake-supabase.cjs");

// tsx compiles the server entrypoints to CommonJS require(). Redirect those
// requires before the throwing `server-only` package or a live client loads.
register("./loader-hooks.mjs", pathToFileURL(path.join(here, "register-hooks.mjs")));

const original = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request === "server-only") return stub;
  if (request === "@anthropic-ai/sdk" || request.startsWith("@anthropic-ai/sdk/")) return anthropic;
  if (typeof request === "string" && request.includes(`${path.sep}supabase${path.sep}server`)) return supabase;
  const resolved = original.call(this, request, parent, isMain, options);
  if (
    typeof resolved === "string" &&
    resolved.includes(`${path.sep}src${path.sep}lib${path.sep}supabase${path.sep}server.`)
  ) {
    return supabase;
  }
  return resolved;
};
