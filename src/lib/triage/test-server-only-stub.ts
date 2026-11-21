/**
 * Lets node:test import server modules that mark themselves `server-only`.
 * Next resolves that package to an empty module under the react-server
 * condition; plain `tsx --test` does not, so the marker throws on load.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const resolved = require.resolve("server-only");
const cached = new (require("node:module").Module)(resolved);
cached.filename = resolved;
cached.loaded = true;
cached.exports = {};
require.cache[resolved] = cached;
