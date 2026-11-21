import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * tsx loads server modules as CommonJS. Next compiles those modules with the
 * `react-server` condition, where `server-only` is an empty file. The default
 * entry throws. Resolve that require to server-only@0.0.1's empty.js.
 */
const emptyFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/server-only/empty.js");

type ResolveFilename = (this: unknown, request: string, parent: unknown, isMain: boolean, options?: unknown) => string;

const runtime = Module as unknown as { _resolveFilename: ResolveFilename };
const original = runtime._resolveFilename;

runtime._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request === "server-only") return emptyFile;
  return original.call(this, request, parent, isMain, options);
};
