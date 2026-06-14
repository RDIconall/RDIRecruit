import mammoth from "mammoth";

export async function extractTextFromResume(
  buffer: Buffer,
  mime: string,
  extension: string,
): Promise<string> {
  const ext = extension.toLowerCase();

  if (mime.includes("pdf") || ext === "pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    return normalizeText(result.text ?? "");
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
