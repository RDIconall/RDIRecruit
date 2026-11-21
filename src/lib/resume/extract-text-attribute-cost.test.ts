import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { crc32 } from "node:zlib";
import { downloadResumeFile } from "./download.ts";
import { extractTextFromResume } from "./extract-text.ts";

/**
 * Spec for the résumé DOCX parse cost.
 *
 * A candidate file is fetched by downloadResumeFile and parsed by
 * extractTextFromResume → mammoth → @xmldom/xmldom DOMParser.parseFromString.
 * These tests fail while that parse inserts each distinct attribute with a
 * linear scan (quadratic overall) and pass once the same document is built in
 * linear time. The fixtures stay under the 5MB extractRubricFromFile cap;
 * résumé download itself has no size cap. extractRubricFromFile is not called
 * here: the live app does not import it. application/msword and ".doc" share
 * the mammoth branch in extract-text.ts with this docx case and are not timed
 * separately. ingestResumeForCandidate only adds the Supabase write around
 * download + extract.
 */

const WORD_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SMALL_ATTRIBUTES = 8_000;
const LARGE_ATTRIBUTES = 32_000;
/** 4× attributes. Linear stays near 4×; quadratic is an order of magnitude more. */
const MAX_TIME_RATIO = 6;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml(attributeCount: number): string {
  const attributes = new Array<string>(attributeCount);
  for (let i = 0; i < attributeCount; i++) attributes[i] = `a${i}="1"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${attributes.join(" ")}>
  <w:body><w:p><w:r><w:t>MARKER</w:t></w:r></w:p></w:body>
</w:document>`;
}

function zipStore(files: ReadonlyArray<{ name: string; text: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.text);
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
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

function resumeDocx(attributeCount: number): Buffer {
  return zipStore([
    { name: "[Content_Types].xml", text: CONTENT_TYPES },
    { name: "_rels/.rels", text: PACKAGE_RELS },
    { name: "word/document.xml", text: documentXml(attributeCount) },
  ]);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function withServedDocx<T>(
  body: Buffer,
  read: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": WORD_MIME });
    res.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await read(`http://127.0.0.1:${port}/candidate-resume.docx`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function downloadedExtractMs(body: Buffer): Promise<number> {
  return withServedDocx(body, async (url) => {
    const file = await downloadResumeFile(url);
    assert.equal(file.extension, "docx");
    assert.equal(file.mime, WORD_MIME);
    assert.equal(file.buffer.length, body.length);
    assert.ok(file.buffer.equals(body));

    const started = performance.now();
    const text = await extractTextFromResume(file.buffer, file.mime, file.extension);
    const elapsed = performance.now() - started;
    assert.match(text, /MARKER/);
    return elapsed;
  });
}

test("a downloaded résumé docx with many distinct attributes parses in linear time", async () => {
  const warmup = resumeDocx(400);
  const small = resumeDocx(SMALL_ATTRIBUTES);
  const large = resumeDocx(LARGE_ATTRIBUTES);
  assert.ok(large.length < 5_000_000);

  await downloadedExtractMs(warmup);
  const smallMs = median([
    await downloadedExtractMs(small),
    await downloadedExtractMs(small),
    await downloadedExtractMs(small),
  ]);
  const largeMs = await downloadedExtractMs(large);
  const ratio = largeMs / smallMs;

  assert.ok(
    ratio < MAX_TIME_RATIO,
    `extract time grew ${ratio.toFixed(2)}× when distinct attributes grew 4× (${smallMs.toFixed(0)}ms → ${largeMs.toFixed(0)}ms). Linear parsing stays under ${MAX_TIME_RATIO}×.`,
  );
});
