import mammoth from "mammoth";
import { ensurePdfPolyfills } from "./pdf-polyfills";
import { MIN_RESUME_TEXT } from "./constants";
import { RESUME_BYTE_LIMIT, ResumeByteLimitError } from "./byte-limit";
import { openBoundedDocx } from "./docx-package";
import { sanitizePdfForParsing } from "./pdf-budget";

export async function extractTextFromResume(
  buffer: Buffer,
  mime: string,
  extension: string,
): Promise<string> {
  if (buffer.length > RESUME_BYTE_LIMIT) {
    throw new ResumeByteLimitError(`file is ${buffer.length} bytes, over ${RESUME_BYTE_LIMIT}`);
  }
  const ext = extension.toLowerCase();

  if (mime.includes("pdf") || ext === "pdf") {
    // Measure and rewrite the PDF before either parser sees it; pdf-parse and
    // mupdf only ever receive the bounded rewrite (see ./pdf-budget).
    const { textPdf, renderPdf, maxImageBytes } = await sanitizePdfForParsing(buffer);

    // pdf-parse v2 removed the v1 default-export function in favour of a
    // PDFParse class. The constructor accepts binary data (we pass a Uint8Array)
    // and getText() returns the concatenated document text. A minimal local type
    // keeps this resilient to the package's re-export typing chain.
    type PdfParseModule = {
      PDFParse: new (opts: { data: Uint8Array }) => {
        getText(): Promise<{ text?: string }>;
        destroy(): Promise<void>;
      };
    };
    // pdfjs (loaded by pdf-parse) references a global DOMMatrix at module load
    // and only self-polyfills it from the optional @napi-rs/canvas package,
    // which isn't bundled on Vercel. Install our own before importing so the
    // module can evaluate in any Node runtime.
    ensurePdfPolyfills();
    const { PDFParse } = (await import("pdf-parse")) as unknown as PdfParseModule;
    const parser = new PDFParse({ data: new Uint8Array(textPdf) });
    let text: string;
    try {
      const result = await parser.getText();
      text = normalizeText(result.text ?? "");
    } finally {
      await parser.destroy();
    }

    // Scanned / image-only PDFs carry no text layer, so pdf-parse returns only a
    // few stray characters. Below the "real résumé" threshold, fall back to OCR
    // (rasterize pages → recognize). Gated on the short-text condition so the
    // heavy WASM path only runs for the rare image PDF, never the common case.
    if (text.length < MIN_RESUME_TEXT) {
      try {
        const { ocrPdfText } = await import("./ocr");
        const ocr = normalizeText(await ocrPdfText(renderPdf, maxImageBytes));
        if (ocr.length > text.length) text = ocr;
      } catch (error) {
        if (error instanceof ResumeByteLimitError) throw error;
        // OCR is best-effort: keep the (short) extracted text on any failure.
        console.warn("resume.extract.ocr_fallback_failed", error instanceof Error ? error.message : error);
      }
    }
    return text;
  }

  if (
    mime.includes("wordprocessingml") ||
    mime.includes("msword") ||
    ext === "docx" ||
    ext === "doc"
  ) {
    // mammoth accepts a pre-opened package as `file`; the bounded package keeps
    // every part it reads inside the same byte budget as the download.
    const file = openBoundedDocx(buffer, RESUME_BYTE_LIMIT);
    const result = await mammoth.extractRawText({ file } as unknown as Parameters<typeof mammoth.extractRawText>[0]);
    return normalizeText(result.value ?? "");
  }

  return normalizeText(buffer.toString("utf8"));
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    // Postgres text/jsonb columns reject NUL (\u0000); some PDFs also emit stray
    // C0 control chars. If left in, the résumé `applications` UPDATE fails and the
    // row never persists. Strip them (keep tab + newline).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
