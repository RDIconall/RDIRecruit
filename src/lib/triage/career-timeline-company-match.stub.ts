/**
 * Lets the dossier module load under tsx. The component imports a server action,
 * and that action imports server-only, which throws outside a server component.
 * The company-match code under test still runs; this only replaces that guard.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("module") as {
  prototype: { require: (this: unknown, id: string, ...rest: unknown[]) => unknown };
};
const original = Module.prototype.require;
Module.prototype.require = function patched(this: unknown, id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return original.call(this, id, ...rest);
};
