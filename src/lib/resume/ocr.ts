import "server-only";

/**
 * OCR fallback for scanned / image-only PDFs whose text layer is empty or near-
 * empty (so pdf-parse extracts only a few stray characters). Pipeline is fully
 * WASM and canvas-free so it runs in the Vercel Node serverless runtime:
 *   mupdf (WASM) rasterizes each page to a PNG  →  tesseract.js (WASM) OCRs it.
 *
 * Deliberately avoids `@napi-rs/canvas` / native pdfjs rendering — the project
 * already polyfills DOMMatrix specifically to keep the canvas binary out of the
 * bundle (see ./pdf-polyfills). mupdf renders to a pixmap with no DOM/canvas.
 *
 * Tightly bounded so the cron/ingest time + memory budget is never blown:
 *  - only the first MAX_OCR_PAGES pages are rasterized + recognized,
 *  - a wall-clock budget stops the loop early,
 *  - every failure mode fails OPEN (returns ""), so a candidate that can't be
 *    OCR'd simply stays "Review blocked" rather than crashing the ingest.
 */

const MAX_OCR_PAGES = 3;
const OCR_BUDGET_MS = 110_000;
// 72 dpi × 3 ≈ 216 dpi — enough resolution for Tesseract without ballooning the
// pixmap (and OCR time) on a multi-page scan.
const RENDER_SCALE = 3;

/**
 * Render up to the first few pages of a PDF and OCR them. Returns the combined
 * recognized text (may be empty on any failure). Never throws.
 */
export async function ocrPdfText(buffer: Buffer): Promise<string> {
  const start = Date.now();

  const pngPages = await renderPdfPagesToPng(buffer);
  if (!pngPages.length) return "";

  try {
    const { createWorker } = await import("tesseract.js");
    // Cache the downloaded core + traineddata under /tmp (the only writable path
    // on Vercel) so repeated invocations in a warm function reuse them.
    const worker = await createWorker("eng", 1, { cachePath: "/tmp/tesseract" });
    const parts: string[] = [];
    try {
      for (const png of pngPages) {
        if (Date.now() - start > OCR_BUDGET_MS) break;
        const { data } = await worker.recognize(Buffer.from(png));
        const text = (data.text ?? "").trim();
        if (text) parts.push(text);
      }
    } finally {
      await worker.terminate();
    }
    return parts.join("\n\n").trim();
  } catch (error) {
    console.warn("resume.ocr.tesseract_failed", error instanceof Error ? error.message : error);
    return "";
  }
}

async function renderPdfPagesToPng(buffer: Buffer): Promise<Uint8Array[]> {
  let mupdf: typeof import("mupdf");
  try {
    mupdf = await import("mupdf");
  } catch (error) {
    console.warn("resume.ocr.mupdf_import_failed", error instanceof Error ? error.message : error);
    return [];
  }

  const pages: Uint8Array[] = [];
  try {
    const doc = mupdf.Document.openDocument(new Uint8Array(buffer), "application/pdf");
    const count = Math.min(doc.countPages(), MAX_OCR_PAGES);
    const matrix = mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE);
    for (let i = 0; i < count; i += 1) {
      const page = doc.loadPage(i);
      const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
      pages.push(pixmap.asPNG());
      pixmap.destroy();
      page.destroy();
    }
    doc.destroy();
  } catch (error) {
    console.warn("resume.ocr.render_failed", error instanceof Error ? error.message : error);
    return pages;
  }
  return pages;
}
