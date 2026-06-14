import { createHash } from "crypto";
import { getWorkableToken, hasWorkable } from "../env";

export function hashResumeSource(url: string, updatedAt?: string): string {
  return createHash("sha256").update(`${url}|${updatedAt ?? ""}`).digest("hex").slice(0, 32);
}

export async function downloadResumeFile(resumeUrl: string): Promise<{
  buffer: Buffer;
  mime: string;
  extension: string;
}> {
  const headers: Record<string, string> = {};
  if (hasWorkable() && resumeUrl.includes("workable.com")) {
    headers.Authorization = `Bearer ${getWorkableToken()}`;
  }

  const response = await fetch(resumeUrl, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Resume download failed (${response.status})`);
  }

  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());

  let extension = "bin";
  if (mime.includes("pdf")) extension = "pdf";
  else if (mime.includes("wordprocessingml") || resumeUrl.toLowerCase().includes(".docx")) extension = "docx";
  else if (mime.includes("msword") || resumeUrl.toLowerCase().includes(".doc")) extension = "doc";
  else if (resumeUrl.toLowerCase().includes(".pdf")) extension = "pdf";

  return { buffer, mime, extension };
}
