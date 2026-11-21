/**
 * Spec for the résumé DOCX parse path.
 *
 * A new applicant's résumé is fetched from the URL Workable returns and handed to
 * mammoth, which parses every OOXML part with @xmldom/xmldom. These tests send a
 * small, deflated DOCX whose document part (or another part mammoth parses) is
 * deeply nested namespace declarations — the shape that makes the 0.8.13 parser
 * retain a full copy of the namespace map per nesting level.
 *
 * They fail while that parser is in use: a few dozen kilobytes of XML grow the
 * heap by far more than the budget below. They pass once parsing that document
 * stays within the budget (the known fix is @xmldom/xmldom >= 0.8.15).
 *
 * Run:
 *   node --import tsx --test src/lib/resume/extract-text.xmldom-memory.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import test from "node:test";
import { downloadResumeFile } from "./download.ts";
import { extractTextFromResume } from "./extract-text.ts";

const DEPTH = 1600;
/** Vulnerable 0.8.13 grows ~99MB here; 0.8.15 grows ~9MB. */
const HEAP_BUDGET_MB = 48;

const MINIMAL_DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body>
</w:document>`;

/** OOXML parts mammoth.extractRawText parses via DOMParser. */
const PARSED_PARTS = [
  "word/document.xml",
  "word/footnotes.xml",
  "word/endnotes.xml",
  "word/comments.xml",
  "word/styles.xml",
  "word/numbering.xml",
  "[Content_Types].xml",
  "_rels/.rels",
  "word/_rels/document.xml.rels",
] as const;

type ProbeReport = {
  part: string;
  namespaces: boolean;
  mime: string;
  url: string;
  extension: string;
  zipBytes: number;
  xmlBytes: number;
  downloadedBytes: number;
  heapTotalDeltaMB: number;
  status: string;
};

if (process.env.RESUME_XMLDOM_PROBE === "1") {
  probe()
    .then((report) => {
      process.stdout.write(`PROBE_RESULT ${JSON.stringify(report)}\n`);
      process.exit(0);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(message + "\n");
      process.exit(1);
    });
} else {
  for (const part of PARSED_PARTS) {
    test(`résumé DOCX ${part} with nested namespace declarations stays within a linear heap budget`, () => {
      const report = runProbe({ part, namespaces: true, kind: "docx" });
      assertBounded(report);
    });
  }

  test("a .doc content type still parses the downloaded bytes through the same DOCX reader", () => {
    const report = runProbe({
      part: "word/document.xml",
      namespaces: true,
      kind: "doc",
    });
    assert.equal(report.extension, "doc");
    assertBounded(report);
  });

  test("an extension-only .docx URL still parses the downloaded bytes through the same reader", () => {
    const report = runProbe({
      part: "word/document.xml",
      namespaces: true,
      kind: "octet-docx",
    });
    assert.equal(report.extension, "docx");
    assertBounded(report);
  });

  test("the same nesting without new namespace prefixes stays within the heap budget", () => {
    const report = runProbe({
      part: "word/document.xml",
      namespaces: false,
      kind: "docx",
    });
    assertBounded(report);
  });
}

function assertBounded(report: ProbeReport) {
  assert.ok(
    report.zipBytes < 20_000,
    `fixture zip is ${report.zipBytes} bytes; the case is a small résumé, not a large upload`,
  );
  assert.ok(report.xmlBytes < 80_000, `fixture XML is ${report.xmlBytes} bytes`);
  assert.equal(
    report.downloadedBytes,
    report.zipBytes,
    "downloadResumeFile did not return the résumé body it was given",
  );
  assert.ok(
    report.heapTotalDeltaMB < HEAP_BUDGET_MB,
    `${report.part} grew the heap by ${report.heapTotalDeltaMB}MB while parsing a ${report.zipBytes}-byte DOCX (${report.xmlBytes} bytes of XML). status=${report.status}`,
  );
}

function runProbe(input: {
  part: (typeof PARSED_PARTS)[number];
  namespaces: boolean;
  kind: "docx" | "doc" | "octet-docx";
}): ProbeReport {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        RESUME_XMLDOM_PROBE: "1",
        PROBE_PART: input.part,
        PROBE_NAMESPACES: input.namespaces ? "1" : "0",
        PROBE_KIND: input.kind,
      },
    },
  );

  const stderr = child.stderr ?? "";
  assert.equal(
    child.status,
    0,
    `probe exited ${child.status} signal=${child.signal}\n${stderr}\n${child.stdout ?? ""}`,
  );
  const line = (child.stdout ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("PROBE_RESULT "));
  assert.ok(line, `probe produced no result\n${child.stdout}\n${stderr}`);
  return JSON.parse(line.slice("PROBE_RESULT ".length)) as ProbeReport;
}

async function probe(): Promise<ProbeReport> {
  const part = process.env.PROBE_PART ?? "word/document.xml";
  const namespaces = process.env.PROBE_NAMESPACES !== "0";
  const kind = process.env.PROBE_KIND ?? "docx";
  const xml = nestedXml(DEPTH, namespaces);
  const files: Record<string, string> = {};
  if (part !== "word/document.xml") files["word/document.xml"] = MINIMAL_DOCUMENT;
  files[part] = xml;
  const zip = zipFiles(files);

  const { mime, url } = requestFor(kind);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array(zip), {
      status: 200,
      headers: { "content-type": mime },
    })) as typeof fetch;

  try {
    const downloaded = await downloadResumeFile(url);
    const heapBefore = process.memoryUsage().heapTotal;
    let status = "ok";
    try {
      await extractTextFromResume(downloaded.buffer, downloaded.mime, downloaded.extension);
    } catch (error) {
      status = error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : String(error);
    }
    const heapAfter = process.memoryUsage().heapTotal;
    return {
      part,
      namespaces,
      mime,
      url,
      extension: downloaded.extension,
      zipBytes: zip.length,
      xmlBytes: Buffer.byteLength(xml),
      downloadedBytes: downloaded.buffer.length,
      heapTotalDeltaMB: Math.round((heapAfter - heapBefore) / 1048576),
      status,
    };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function requestFor(kind: string): { mime: string; url: string } {
  if (kind === "doc") {
    return {
      mime: "application/msword",
      url: "https://applicant.example/resume.doc",
    };
  }
  if (kind === "octet-docx") {
    return {
      mime: "application/octet-stream",
      url: "https://applicant.example/files/resume.docx",
    };
  }
  return {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    url: "https://applicant.example/uploads/resume",
  };
}

function nestedXml(depth: number, namespaces: boolean): string {
  let open = "";
  let close = "";
  for (let i = 0; i < depth; i++) {
    open += namespaces ? `<e xmlns:n${i}="urn:${i}">` : "<e>";
    close = "</e>" + close;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>${open}x${close}`;
}

function zipFiles(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([local, nameBuf, compressed]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}
