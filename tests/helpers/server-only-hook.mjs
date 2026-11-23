// The product marks server modules with the `server-only` package, whose default
// entry throws outside the React server runtime. Redirect that specifier at the
// empty module the package ships for the server runtime so the grading path can
// load under the test runner.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      format: "module",
      shortCircuit: true,
      url: new URL("./server-only-empty.mjs", import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
}
