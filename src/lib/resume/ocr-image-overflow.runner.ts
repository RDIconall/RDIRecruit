/**
 * Drives the scanned-resume OCR path with a PDF whose text layer is below
 * MIN_RESUME_TEXT and whose image dictionary trips the 32-bit stride overflow
 * in MuPDF 1.27.0's fz_unpack_stream (fixed in 1.28.0).
 *
 * Exits 0 only when extractTextFromResume accepts the file and the same MuPDF
 * module can still rasterize a page afterwards. MuPDF 1.27.0 traps while
 * painting the image ("memory access out of bounds") and leaves the module
 * unusable, so this process exits 1 until that release is no longer what
 * `mupdf` resolves to.
 *
 * Run under the react-server export condition so `server-only` resolves to its
 * empty module, the way the Next.js server runtime loads this code:
 *   node --conditions=react-server --import tsx src/lib/resume/ocr-image-overflow.runner.ts
 */
import { ensurePdfPolyfills } from "./pdf-polyfills.ts";
import { MIN_RESUME_TEXT } from "./constants.ts";
import { extractTextFromResume } from "./extract-text.ts";

// Width where `(w * 16 * 1 + 7) >> 3` overflows signed 32-bit int in
// fz_unpack_stream while the "image is too large" checks in pdf_load_image_imp
// still pass on wasm32 (size_t is 32-bit). Height stays 1 so the draw device
// does not subsample the image away before unpacking it.
const IMAGE_WIDTH = 178956971;
const IMAGE_HEIGHT = 1;
const RENDER_SCALE = 3;

function pdfDocument(objects: Buffer[]): Buffer {
  let out = Buffer.from("%PDF-1.4\n");
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), objects[i]!, Buffer.from("\nendobj\n")]);
  }
  const xref = out.length;
  let body = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(body)]);
}

/** Image-only résumé: a few bytes of sample data and no real text layer. */
function craftedResumePdf(): Buffer {
  const samples = Buffer.alloc(8192, 0x41);
  const content = Buffer.from("q\n20 0 0 20 10 10 cm\n/Im0 Do\nQ\n");
  const image = Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${IMAGE_WIDTH} /Height ${IMAGE_HEIGHT} /ColorSpace /DeviceGray /BitsPerComponent 16 /Length ${samples.length} >>\nstream\n`,
    ),
    samples,
    Buffer.from("\nendstream"),
  ]);
  const contents = Buffer.concat([
    Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("endstream"),
  ]);
  return pdfDocument([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    ),
    image,
    contents,
  ]);
}

function benignPagePdf(): Buffer {
  const content = Buffer.from("BT ET\n");
  return pdfDocument([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>"),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("endstream"),
    ]),
  ]);
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function textLayerLength(buffer: Buffer): Promise<number> {
  type PdfParseModule = {
    PDFParse: new (opts: { data: Uint8Array }) => {
      getText(): Promise<{ text?: string }>;
      destroy(): Promise<void>;
    };
  };
  ensurePdfPolyfills();
  const { PDFParse } = (await import("pdf-parse")) as unknown as PdfParseModule;
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return normalizeText(result.text ?? "").length;
  } finally {
    await parser.destroy();
  }
}

async function rasterize(mupdf: typeof import("mupdf"), buffer: Buffer): Promise<number> {
  const doc = mupdf.Document.openDocument(new Uint8Array(buffer), "application/pdf");
  try {
    const page = doc.loadPage(0);
    try {
      const pixmap = page.toPixmap(mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE), mupdf.ColorSpace.DeviceRGB, false);
      try {
        return pixmap.getWidth();
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

async function main(): Promise<void> {
  const crafted = craftedResumePdf();
  const textLength = await textLayerLength(crafted);
  if (textLength >= MIN_RESUME_TEXT) {
    throw new Error(`fixture text layer is ${textLength} chars; OCR gate is ${MIN_RESUME_TEXT}`);
  }

  // Same bytes extractTextFromResume feeds to ocrPdfText when the text layer is short.
  // ingestResumeForCandidate and extractRubricFromFile both enter through this function.
  const extracted = await extractTextFromResume(crafted, "application/pdf", "pdf");
  if (typeof extracted !== "string") {
    throw new Error("extractTextFromResume did not return a string");
  }

  const mupdf = await import("mupdf");
  const benignWidth = await rasterize(mupdf, benignPagePdf());
  if (benignWidth !== 72 * RENDER_SCALE) {
    throw new Error(`benign page rasterized to width ${benignWidth}`);
  }
  const craftedWidth = await rasterize(mupdf, crafted);
  if (craftedWidth !== 72 * RENDER_SCALE) {
    throw new Error(`crafted résumé rasterized to width ${craftedWidth}`);
  }
  console.log("ocr-image-overflow: rasterized without a MuPDF trap");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exit(1);
  },
);
