import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("module");
const empty = fileURLToPath(new URL("../../node_modules/server-only/empty.js", import.meta.url));
const original = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") {
    return empty;
  }
  return original.call(this, request, parent, isMain, options);
};
