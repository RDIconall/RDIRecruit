/**
 * Dynamic import("@clerk/nextjs/server") bypasses the CommonJS resolver
 * patch. The hooks thread does not see env vars set by the test, so this
 * file is registered only by the founder-identity test and always redirects
 * that specifier to the session stand-in.
 */
const clerkUrl = new URL("./clerk-mock.cjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@clerk/nextjs/server") {
    return { url: clerkUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
