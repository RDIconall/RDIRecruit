import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";

import { extractTextFromResume } from "../src/lib/resume/extract-text.ts";

/**
 * Spec for GHSA-93r5-fhx6-vmg9 (@xmldom/xmldom before 0.8.15), reached when a
 * candidate résumé DOCX is read by extractTextFromResume → mammoth.extractRawText
 * → DOMParser.parseFromString.
 *
 * A run of `<` inside word/document.xml makes parseElementStartPart scan to the
 * next `>` and then recover one character at a time, and endDocument then calls
 * normalize() on the one-character text nodes that recovery appends. Both are
 * quadratic on 0.8.13. Mammoth's error handler only rejects after parseFromString
 * returns, so the CPU cost is already paid. These tests fail until that cost
 * scales near-linearly (the 0.8.15 behavior).
 *
 * The `.doc` / `application/msword` arm of extractTextFromResume calls the same
 * mammoth.extractRawText, so it is covered by the wordprocessingml case.
 */

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml(bodyInner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Jane Candidate</w:t></w:r></w:p>${bodyInner}</w:body></w:document>`;
}

/** Stored-method ZIP. JSZip (via mammoth) reads it the same way as a compressed DOCX. */
function zipStored(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, file.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function resumeDocx(bodyInner: string): Buffer {
  return zipStored([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(PACKAGE_RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml(bodyInner), "utf8") },
  ]);
}

/** Time the real extractor. Rejection after a finished parse still counts. */
async function millisToExtract(buffer: Buffer): Promise<number> {
  const start = process.hrtime.bigint();
  try {
    await extractTextFromResume(buffer, DOCX_MIME, "docx");
  } catch {
    // Expected for the malformed fixture: mammoth throws only after parsing.
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

test("a well-formed docx résumé still yields its text", async () => {
  const text = await extractTextFromResume(resumeDocx(""), DOCX_MIME, "docx");
  assert.match(text, /Jane Candidate/);
});

test(
  "malformed résumé XML does not scale quadratically through extractTextFromResume",
  { timeout: 60_000 },
  async () => {
    // Warm the parser so the ratio measures the algorithm, not first-call startup.
    await millisToExtract(resumeDocx("<".repeat(2_000) + ">"));

    const smaller = 8_000;
    const larger = 32_000;
    const smallMs = await millisToExtract(resumeDocx("<".repeat(smaller) + ">"));
    const largeMs = await millisToExtract(resumeDocx("<".repeat(larger) + ">"));
    const ratio = largeMs / smallMs;
    // 4× input. Linear work stays near 4× (fixed 0.8.15 measured ~2× with overhead).
    // Both the tag re-scan and normalize() are quadratic on 0.8.13, so this is ~16×.
    // Leaving either one in place still lands well above 6×.
    assert.ok(
      ratio < 6,
      `extracting a résumé with ${larger} malformed '<' characters took ${largeMs.toFixed(0)}ms vs ${smallMs.toFixed(0)}ms for ${smaller} (${ratio.toFixed(2)}×). Expected < 6× after the xmldom recovery and normalize fixes.`,
    );
  },
);
