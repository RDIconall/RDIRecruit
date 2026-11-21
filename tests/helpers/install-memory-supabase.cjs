const Module = require("node:module");
const path = require("node:path");

const emptyServerOnly = path.join(__dirname, "empty-server-only.cjs");
const memoryModule = path.join(__dirname, "memory-supabase-module.cjs");

let installed = false;

function installMemorySupabaseHook() {
  if (installed) return;
  installed = true;
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === "server-only") return emptyServerOnly;
    if (
      request === "@/lib/supabase/server" ||
      request.endsWith("/lib/supabase/server") ||
      request.endsWith("/lib/supabase/server.ts") ||
      request.endsWith("\\lib\\supabase\\server") ||
      request.endsWith("\\lib\\supabase\\server.ts")
    ) {
      return memoryModule;
    }
    const resolved = original.call(this, request, parent, isMain, options);
    if (
      typeof resolved === "string" &&
      resolved.includes(`${path.sep}supabase${path.sep}server.`)
    ) {
      return memoryModule;
    }
    return resolved;
  };
}

module.exports = { installMemorySupabaseHook };
