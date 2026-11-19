import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Attacker-controlled document for the librsvg use-after-free shipped in
// sharp 0.34.5 (librsvg 2.61.2). Bytes 4..11 are "ftypavif", which
// next 16.2.9 detectContentType classifies as image/avif, so the buffer is
// not treated as SVG and is passed to sharp. The duplicate-name XInclude
// entities are what make librsvg 2.61.2 free an xmlEntity libxml2 is still
// using. The fixed decoder in sharp 0.35.5 (librsvg 2.63.2) rasterizes it.
const XINCLUDE = "http://www.w3.org/2001/XInclude";
const AVIF_DISGUISE = "<!--ftypavif-->";

function includedEntity(name: string, value: string): string {
  return `<!DOCTYPE svg [<!ENTITY ${name} "${value}">]><svg xmlns="http://www.w3.org/2000/svg"/>`;
}

function duplicateEntitySvg(prefix: string, pairs: number, value: string): Buffer {
  const include = (href: string) =>
    `<xi:include xmlns:xi="${XINCLUDE}" href="${href}" parse="xml"/>`;
  const declarations = Array.from({ length: pairs }, (_, index) => {
    const name = `e${index}`;
    const href =
      "data:image/svg+xml;base64," +
      Buffer.from(includedEntity(name, value)).toString("base64");
    return `  <!ENTITY ${name} '${include(href)}'>\n`;
  }).join("");
  const uses = Array.from({ length: pairs }, (_, index) => `&e${index};`).join("");
  return Buffer.from(
    prefix +
      "<!DOCTYPE svg [\n" +
      declarations +
      "]>\n" +
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xi="${XINCLUDE}" width="64" height="64">` +
      uses +
      "\n</svg>\n",
  );
}

function isRaster(buffer: Buffer): boolean {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

const require = createRequire(import.meta.url);
const loadConfig = require("next/dist/server/config").default as (
  phase: string,
  dir: string,
  options: { silent: boolean },
) => Promise<{
  images: {
    unoptimized?: boolean;
    loader?: string;
    dangerouslyAllowLocalIP?: boolean;
    dangerouslyAllowSVG?: boolean;
    minimumCacheTTL?: number;
    remotePatterns?: Array<{ hostname?: string }>;
  };
  experimental: { imgOptSkipMetadata?: boolean | null; imgOptConcurrency?: number | null };
}>;
const { PHASE_PRODUCTION_SERVER } = require("next/dist/shared/lib/constants") as {
  PHASE_PRODUCTION_SERVER: string;
};
const { imageOptimizer, ImageOptimizerCache, detectContentType, fetchExternalImage } =
  require("next/dist/server/image-optimizer") as {
    imageOptimizer: (
      upstream: { buffer: Buffer; contentType: string | null; cacheControl: string | null; etag: string },
      params: { href: string; quality: number; width: number; mimeType: string },
      nextConfig: unknown,
      opts: { isDev: boolean; silent: boolean },
    ) => Promise<{ buffer: Buffer; contentType: string; error?: unknown }>;
    ImageOptimizerCache: {
      validateParams: (
        req: { headers: Record<string, string> },
        query: { url: string; w: string; q: string },
        nextConfig: unknown,
        isDev: boolean,
      ) => { href?: string; errorMessage?: string };
    };
    detectContentType: (
      buffer: Buffer,
      skipMetadata: boolean | null | undefined,
      concurrency: number | null | undefined,
    ) => Promise<string | null>;
    fetchExternalImage: (
      href: string,
      dangerouslyAllowLocalIP: boolean | undefined,
      maximumResponseBody: number,
      maximumRedirects: number,
    ) => Promise<unknown>;
  };

const ATTACKER_URL =
  "https://attacker-project.supabase.co/storage/v1/object/public/bucket/payload.svg";
const ENTITY_VALUE = `${"A".repeat(199)}Z`;

test("image optimization decodes an attacker Supabase image without hitting the librsvg use-after-free", async () => {
  const nextConfig = await loadConfig(PHASE_PRODUCTION_SERVER, process.cwd(), { silent: true });
  const params = ImageOptimizerCache.validateParams(
    { headers: { accept: "image/webp,image/avif,image/jpeg,*/*" } },
    { url: ATTACKER_URL, w: "64", q: "75" },
    nextConfig,
    false,
  );

  const optimizationOn =
    nextConfig.images.loader === "default" && nextConfig.images.unoptimized !== true;
  if (!optimizationOn || "errorMessage" in params) {
    // Route will not fetch this URL: images.unoptimized, a non-default loader,
    // or remotePatterns that do not match an attacker-controlled supabase host.
    return;
  }

  assert.equal(nextConfig.images.dangerouslyAllowLocalIP, false);
  await assert.rejects(
    () => fetchExternalImage("http://127.0.0.1/payload.svg", false, 50_000_000, 3),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      return true;
    },
  );

  const disguised = duplicateEntitySvg(AVIF_DISGUISE, 5, ENTITY_VALUE);
  const control = Buffer.from(
    `${AVIF_DISGUISE}<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>`,
  );

  assert.equal(
    await detectContentType(
      disguised,
      nextConfig.experimental.imgOptSkipMetadata,
      nextConfig.experimental.imgOptConcurrency,
    ),
    "image/avif",
  );

  const optimized = await imageOptimizer(
    { buffer: disguised, contentType: "application/octet-stream", cacheControl: null, etag: "payload" },
    { href: params.href ?? ATTACKER_URL, quality: 75, width: 64, mimeType: "image/webp" },
    nextConfig,
    { isDev: false, silent: true },
  );
  const controlResult = await imageOptimizer(
    { buffer: control, contentType: "application/octet-stream", cacheControl: null, etag: "control" },
    { href: params.href ?? ATTACKER_URL, quality: 75, width: 64, mimeType: "image/webp" },
    nextConfig,
    { isDev: false, silent: true },
  );

  assert.equal(isRaster(controlResult.buffer), true, "benign disguised image must reach sharp");
  assert.equal(controlResult.error, undefined);
  assert.equal(
    optimized.buffer.equals(disguised),
    false,
    "optimizer echoed the attacker bytes after the vulnerable decode failed",
  );
  assert.equal(optimized.error, undefined);
  assert.equal(isRaster(optimized.buffer), true);

  if (nextConfig.experimental.imgOptSkipMetadata) return;

  // Same entities, no AVIF disguise. detectContentType then calls sharp().metadata()
  // before the SVG rejection. A vulnerable librsvg throws and the error is swallowed,
  // so the type comes back null. The fixed library reports image/svg+xml.
  const bare = duplicateEntitySvg("", 5, ENTITY_VALUE);
  assert.equal(
    await detectContentType(bare, false, nextConfig.experimental.imgOptConcurrency),
    "image/svg+xml",
  );
});
