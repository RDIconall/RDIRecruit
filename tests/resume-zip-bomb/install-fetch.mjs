/**
 * Preload for resume decompression tests. Serves Workable candidate JSON from
 * FIXTURE_CONFIG and refuses every other non-loopback host, so a test cannot
 * reach the real ATS.
 */
import { readFileSync } from "node:fs";

const realFetch = globalThis.fetch.bind(globalThis);
const config = JSON.parse(readFileSync(process.env.FIXTURE_CONFIG, "utf8"));

function candidateIdFromPath(pathname) {
  const match = pathname.match(/\/candidates\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (!loopback) {
    if (parsed.hostname.endsWith(".workable.com")) {
      const id = candidateIdFromPath(parsed.pathname);
      const candidate = id ? config.candidates?.[id] : null;
      if (!candidate) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ candidate }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`blocked outbound request to ${parsed.hostname}`);
  }
  return realFetch(input, init);
};
