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
// Hard ceiling on the WHOLE OCR pass. Must stay comfortably under the route's
// maxDuration (300s) so a slow or crashed Tesseract worker can never hang the
// function to its timeout — when this elapses we abandon OCR and fail open.
const OCR_BUDGET_MS = 110_000;
// Per-step ceiling for worker init / a single page recognize. A worker thread
// that dies (e.g. a missing transitive dep) leaves its promise unsettled, so we
// must race every await against a timeout rather than trusting it to reject.
const OCR_STEP_MS = 45_000;
// 72 dpi × 3 ≈ 216 dpi — enough resolution for Tesseract without ballooning the
// pixmap (and OCR time) on a multi-page scan.
const RENDER_SCALE = 3;

/** Reject if `promise` doesn't settle within `ms`; used so a hung/crashed
 * Tesseract worker thread can never block the serverless function. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Render up to the first few pages of a PDF and OCR them. Returns the combined
 * recognized text (may be empty on any failure). Never throws and always
 * returns within ~OCR_BUDGET_MS.
 */
export async function ocrPdfText(buffer: Buffer): Promise<string> {
  const start = Date.now();

  const pngPages = await renderPdfPagesToPng(buffer);
  if (!pngPages.length) return "";

  let worker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>> | null = null;
  try {
    const { createWorker } = await import("tesseract.js");
    // Cache the downloaded core + traineddata under /tmp (the only writable path
    // on Vercel) so repeated invocations in a warm function reuse them.
    worker = await withTimeout(
      createWorker("eng", 1, { cachePath: "/tmp/tesseract" }),
      OCR_STEP_MS,
      "tesseract worker init",
    );

    const parts: string[] = [];
    for (const png of pngPages) {
      if (Date.now() - start > OCR_BUDGET_MS) break;
      const { data } = await withTimeout(
        worker.recognize(Buffer.from(png)),
        OCR_STEP_MS,
        "tesseract recognize",
      );
      const text = (data.text ?? "").trim();
      if (text) parts.push(text);
    }
    return parts.join("\n\n").trim();
  } catch (error) {
    console.warn("resume.ocr.tesseract_failed", error instanceof Error ? error.message : error);
    return "";
  } finally {
    // Fire-and-forget: a crashed worker's terminate() can itself hang, so don't
    // await it (it would re-introduce the timeout we're guarding against).
    if (worker) void Promise.resolve(worker.terminate()).catch(() => {});
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
