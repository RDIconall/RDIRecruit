import Module from "node:module";

/**
 * The grading modules import `server-only`, which throws outside the Next.js
 * server compiler. Tests load those modules through Node, so replace that
 * marker with an empty module before they evaluate.
 */
const loader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
