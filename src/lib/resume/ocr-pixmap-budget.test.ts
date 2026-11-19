import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import test from "node:test";
import { downloadResumeFile } from "./download.ts";
import { extractTextFromResume } from "./extract-text.ts";

/**
 * Spec for the scanned-résumé raster cap.
 *
 * `renderPdfPagesToPng` draws the first three pages at RENDER_SCALE (3) with
 * MuPDF's default page box. That box is the crop box, or the media box when
 * the crop box is absent, then scaled by UserUnit (MuPDF 1.27.1
 * `pdf_page_obj_transform_box`). A letter page at that scale is
 * 1836×2376 = 4,362,336 pixels and must still be drawn at full scale.
 * Anything above MAX_OCR_PIXELS must be skipped or downscaled before
 * `Page.toPixmap` allocates. These tests fail while the cap is missing.
 */
const MAX_OCR_PIXELS = 8_000_000;
const LETTER_RASTER = { width: 612 * 3, height: 792 * 3 };

type PageSpec = {
  media: [number, number, number, number];
  crop?: [number, number, number, number];
  userUnit?: number;
  text?: string;
};

type Raster = { width: number; height: number; pixels: number };

const rasters: Raster[] = [];

type PixmapCtor = {
  prototype: {
    toPixmap: (matrix: unknown, colorspace: unknown, alpha?: boolean) => {
      getWidth: () => number;
      getHeight: () => number;
    };
  };
};

function installPixmapProbe(namespace: { PDFPage?: PixmapCtor; Page?: PixmapCtor }): void {
  const ctors = [namespace.PDFPage, namespace.Page];
  const seen = new Set<object>();
  for (const ctor of ctors) {
    if (!ctor || seen.has(ctor)) continue;
    seen.add(ctor);
    const original = ctor.prototype.toPixmap;
    ctor.prototype.toPixmap = function patchedToPixmap(this: unknown, ...args: unknown[]) {
      const pixmap = original.apply(this, args as never);
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      rasters.push({ width, height, pixels: width * height });
      return pixmap;
    };
  }
}

test.before(async () => {
  // Same dynamic import the OCR helper uses, so the probe wraps the instance
  // that `page.toPixmap` actually runs.
  const namespace = (await import("mupdf")) as { PDFPage?: PixmapCtor; Page?: PixmapCtor };
  installPixmapProbe(namespace);
});

function buildPdf(pages: PageSpec[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add("PLACEHOLDER");
  const kids: number[] = [];

  for (const page of pages) {
    const stream = page.text ? `BT\n/F1 12 Tf\n72 72 Td\n(${page.text}) Tj\nET\n` : "";
    const contentId = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
    const resources = page.text
      ? "/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>"
      : "/Resources << >>";
    const attrs = [
      "/Type /Page",
      `/Parent ${pagesId} 0 R`,
      `/MediaBox [${page.media.join(" ")}]`,
      resources,
      `/Contents ${contentId} 0 R`,
    ];
    if (page.crop) attrs.push(`/CropBox [${page.crop.join(" ")}]`);
    if (page.userUnit != null) attrs.push(`/UserUnit ${page.userUnit}`);
    kids.push(add(`<< ${attrs.join(" ")} >>`));
  }

  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let body = "%PDF-1.6\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function servePdf(pdf: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": String(pdf.length),
    });
    res.end(pdf);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/candidate-resume.pdf`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function assertWithinBudget(label: string, seen: Raster[]): void {
  for (const raster of seen) {
    assert.ok(
      raster.pixels <= MAX_OCR_PIXELS,
      `${label} rasterized ${raster.width}x${raster.height} (${raster.pixels} pixels), above the ${MAX_OCR_PIXELS} pixel budget`,
    );
  }
}

test("scanned resume bytes from the download path are rasterized inside a fixed pixel budget", async () => {
  // Page 0 is an ordinary letter scan: it must stay at full render scale.
  // Page 1 is a letter media box with UserUnit 1.5, so the raw box looks safe
  // while the pixmap MuPDF allocates is 2754×3564.
  // Page 2 is a 1000pt square media box with no crop box (crop defaults to media).
  const pdf = buildPdf([
    { media: [0, 0, 612, 792] },
    { media: [0, 0, 612, 792], userUnit: 1.5 },
    { media: [0, 0, 1000, 1000] },
  ]);
  assert.ok(pdf.length < 5_000, "the attack file itself stays small");

  const server = await servePdf(pdf);
  const before = rasters.length;
  try {
    const downloaded = await downloadResumeFile(server.url);
    assert.equal(downloaded.mime, "application/pdf");
    assert.equal(downloaded.extension, "pdf");
    assert.ok(downloaded.buffer.equals(pdf));

    const text = await extractTextFromResume(downloaded.buffer, downloaded.mime, downloaded.extension);
    assert.equal(typeof text, "string");
  } finally {
    await server.close();
  }

  const seen = rasters.slice(before);
  assert.ok(seen.length >= 1, "expected the letter page to be rasterized");
  assert.deepEqual(
    { width: seen[0]?.width, height: seen[0]?.height },
    LETTER_RASTER,
    "a letter-size scan under the budget must still be rasterized at scale 3",
  );
  assertWithinBudget("scanned resume", seen);
  assert.ok(seen.length <= 3, `rasterized ${seen.length} pages; the three-page OCR limit must hold`);
});

test("a smaller crop box is what gets rasterized, not a larger media box", async () => {
  const pdf = buildPdf([
    {
      media: [0, 0, 4000, 4000],
      crop: [0, 0, 612, 792],
    },
  ]);
  const before = rasters.length;
  const text = await extractTextFromResume(pdf, "application/pdf", "pdf");
  assert.equal(typeof text, "string");
  const seen = rasters.slice(before);
  assert.ok(seen.length <= 1);
  if (seen[0]) {
    assert.deepEqual(
      { width: seen[0].width, height: seen[0].height },
      LETTER_RASTER,
      "toPixmap must follow the crop box MuPDF intersects with the media box",
    );
  }
  assertWithinBudget("cropped page", seen);
});

test("a résumé with a real text layer is not rasterized", async () => {
  const pdf = buildPdf([
    {
      media: [0, 0, 4000, 4000],
      text: "Clinical operations lead with a decade of monitoring experience across phase two and three studies.",
    },
  ]);
  const before = rasters.length;
  const text = await extractTextFromResume(pdf, "application/pdf", "pdf");
  assert.ok(text.length >= 60, `expected a parsed text layer, got ${JSON.stringify(text)}`);
  assert.equal(rasters.length, before, "text résumés must not enter the OCR raster path");
});

test("ocr does not rasterize a fourth page even when that page is enormous", async () => {
  const pdf = buildPdf([
    { media: [0, 0, 612, 792] },
    { media: [0, 0, 612, 792] },
    { media: [0, 0, 612, 792] },
    { media: [0, 0, 8000, 8000] },
  ]);
  const before = rasters.length;
  await extractTextFromResume(pdf, "application/pdf", "pdf");
  const seen = rasters.slice(before);
  assert.equal(seen.length, 3);
  assertWithinBudget("first three pages", seen);
  for (const raster of seen) {
    assert.deepEqual({ width: raster.width, height: raster.height }, LETTER_RASTER);
  }
});
