import { createHash } from "crypto";
import { getWorkableToken, hasWorkable } from "../env";
import { RESUME_BYTE_LIMIT, ResumeByteLimitError } from "./byte-limit";

const DOWNLOAD_TIMEOUT_MS = 60_000;

export function hashResumeSource(url: string, updatedAt?: string): string {
  return createHash("sha256").update(`${url}|${updatedAt ?? ""}`).digest("hex").slice(0, 32);
}

function isWorkableHost(resumeUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(resumeUrl);
    return protocol === "https:" && (hostname === "workable.com" || hostname.endsWith(".workable.com"));
  } catch {
    return false;
  }
}

async function readBodyWithinLimit(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ResumeByteLimitError(`download exceeded ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function downloadResumeFile(resumeUrl: string): Promise<{
  buffer: Buffer;
  mime: string;
  extension: string;
}> {
  const headers: Record<string, string> = {};
  if (hasWorkable() && isWorkableHost(resumeUrl)) {
    headers.Authorization = `Bearer ${getWorkableToken()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Resume download timed out")), DOWNLOAD_TIMEOUT_MS);
  let buffer: Buffer;
  let mime: string;
  try {
    const response = await fetch(resumeUrl, { headers, redirect: "follow", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Resume download failed (${response.status})`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > RESUME_BYTE_LIMIT) {
      throw new ResumeByteLimitError(`Content-Length ${declaredLength} is over ${RESUME_BYTE_LIMIT} bytes`);
    }

    mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
    buffer = await readBodyWithinLimit(response, RESUME_BYTE_LIMIT);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let extension = "bin";
  if (mime.includes("pdf")) extension = "pdf";
  else if (mime.includes("wordprocessingml") || resumeUrl.toLowerCase().includes(".docx")) extension = "docx";
  else if (mime.includes("msword") || resumeUrl.toLowerCase().includes(".doc")) extension = "doc";
  else if (resumeUrl.toLowerCase().includes(".pdf")) extension = "pdf";

  return { buffer, mime, extension };
}
