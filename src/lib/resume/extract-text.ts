import mammoth from "mammoth";
import { ensurePdfPolyfills } from "./pdf-polyfills";
import { MIN_RESUME_TEXT } from "./constants";

export async function extractTextFromResume(
  buffer: Buffer,
  mime: string,
  extension: string,
): Promise<string> {
  const ext = extension.toLowerCase();

  if (mime.includes("pdf") || ext === "pdf") {
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
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
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
        const ocr = normalizeText(await ocrPdfText(buffer));
        if (ocr.length > text.length) text = ocr;
      } catch (error) {
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
    const result = await mammoth.extractRawText({ buffer });
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
