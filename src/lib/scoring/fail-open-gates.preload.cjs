/**
 * Next loads `server-only` as an empty module (server-only@0.0.1 empty.js via
 * the react-server export). The test runner does not set that condition, and
 * the default file throws. Point the specifier at empty.js before the grader
 * is imported. This file is required first from the test.
 */
const Module = require("module");
const path = require("path");

const empty = path.resolve(__dirname, "../../../node_modules/server-only/empty.js");
const original = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") return empty;
  return original.call(this, request, parent, isMain, options);
};
