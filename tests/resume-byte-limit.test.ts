/**
 * Spec for the résumé ingest byte budget.
 *
 * These tests fail while downloadResumeFile and extractTextFromResume buffer
 * and parse applicant files with no ceiling. They pass once a download is
 * refused at RESUME_BYTE_LIMIT (Content-Length and a streaming cap, including
 * after a redirect) and the PDF / Word parsers stay inside the same budget
 * without expanding a small compressed file first. Rejection must surface as
 * an Error whose message matches /resume byte limit/i.
 *
 * Raster budget is separate: OCR renders at scale 3 in DeviceRGB, and a
 * US Letter page is about 13MB at that scale, so the cap sits above a normal
 * scan. A 1600pt page is 69_120_000 bytes and must be refused before the
 * pixmap is allocated.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import Module from "node:module";
import test, { describe } from "node:test";
import zlib from "node:zlib";
import { downloadResumeFile } from "../src/lib/resume/download.ts";
import { extractTextFromResume } from "../src/lib/resume/extract-text.ts";

const require = createRequire(__filename);

const RESUME_BYTE_LIMIT = 5_000_000;
const RASTER_BYTE_LIMIT = 32 * 1024 * 1024;
const RASTER_SCALE = 3;
const LIMIT_PATTERN = /resume byte limit/i;

const emptyServerOnly = require.resolve("next/dist/compiled/server-only/empty.js");
const moduleWithResolve = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const originalResolve = moduleWithResolve._resolveFilename;
moduleWithResolve._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "server-only") return emptyServerOnly;
  return originalResolve.call(this, request, ...rest);
};

type InflateWorker = {
  _pako: { onData: (data: Uint8Array) => void };
  _createPako: () => void;
};

const flate = require("jszip/lib/flate.js") as {
  uncompressWorker: () => InflateWorker;
};
let inflatedBytes = 0;
const originalUncompress = flate.uncompressWorker;
flate.uncompressWorker = function () {
  const worker = originalUncompress();
  const originalCreate = worker._createPako;
  worker._createPako = function () {
    originalCreate.call(worker);
    const inflate = worker._pako;
    const originalOnData = inflate.onData;
    inflate.onData = (data: Uint8Array) => {
      inflatedBytes += data.byteLength;
      originalOnData(data);
    };
  };
  return worker;
};

function assertLimit(error: unknown): void {
  assert.ok(error instanceof Error, `expected a limit error, got ${String(error)}`);
  assert.match(error.message, LIMIT_PATTERN);
}

function buildPdf(content: string, mediaBox = "0 0 612 792"): Buffer {
  const stream = zlib.deflateSync(Buffer.from(content));
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    parts.push(buf);
    len += buf.length;
  };
  push("%PDF-1.4\n");
  const addObj = (header: string) => {
    offsets.push(len);
    push(header);
  };
  addObj(`1 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`);
  push(stream);
  push("\nendstream\nendobj\n");
  addObj(
    `2 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [${mediaBox}] /Contents 1 0 R /Resources << /Font << /F1 4 0 R >> >> >>\nendobj\n`,
  );
  addObj(`3 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1 >>\nendobj\n`);
  addObj(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  addObj(`5 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n`);
  const xref = len;
  let xrefBody = "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets) xrefBody += `${String(offset).padStart(10, "0")} 00000 n \n`;
  push(xrefBody);
  push(`trailer\n<< /Size 6 /Root 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

async function buildDocx(text: string): Promise<Buffer> {
  const JSZip = require("jszip") as typeof import("jszip");
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  zip.file("word/document.xml", xml);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server) {
  server.closeAllConnections();
  server.close();
}

describe("resume ingest byte budget", { concurrency: 1 }, () => {
  test("rejects a Content-Length above the budget before reading the body", async () => {
    let bytes = 0;
    let stopped = false;
    const server = http.createServer((_req, res) => {
      const total = RESUME_BYTE_LIMIT + 5_000_000;
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": String(total),
      });
      res.on("error", () => {
        stopped = true;
      });
      res.on("close", () => {
        stopped = true;
      });
      const chunk = Buffer.alloc(64 * 1024, 0x25);
      const write = () => {
        if (stopped || bytes >= total) {
          if (!stopped) res.end();
          return;
        }
        bytes += chunk.length;
        if (!res.write(chunk)) res.once("drain", write);
        else setImmediate(write);
      };
      // Hold the body so a Content-Length refusal can abort with nothing written.
      setTimeout(() => {
        if (!stopped) write();
      }, 300);
    });
    const port = await listen(server);
    const pending = downloadResumeFile(`http://127.0.0.1:${port}/resume.pdf`).then(
      (file) => ({ kind: "ok" as const, size: file.buffer.length }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const outcome = await Promise.race([
      pending,
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 1000)),
    ]);
    closeServer(server);
    await pending.catch(() => {});
    assert.equal(outcome.kind, "error", `download settled as ${outcome.kind} after writing ${bytes} bytes`);
    if (outcome.kind === "error") assertLimit(outcome.error);
    assert.equal(bytes, 0, `body bytes written before refusal: ${bytes}`);
  });

  test("stops reading a chunked body once the streaming budget is crossed", async () => {
    const total = RESUME_BYTE_LIMIT + 3_000_000;
    let bytes = 0;
    let stopped = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      const chunk = Buffer.alloc(64 * 1024, 0x25);
      const write = () => {
        if (stopped || bytes >= total) {
          if (!stopped) res.end();
          return;
        }
        bytes += chunk.length;
        if (!res.write(chunk)) res.once("drain", write);
        else setImmediate(write);
      };
      res.on("close", () => {
        stopped = true;
      });
      res.on("error", () => {
        stopped = true;
      });
      write();
    });
    const port = await listen(server);
    let error: unknown;
    try {
      const file = await downloadResumeFile(`http://127.0.0.1:${port}/resume.pdf`);
      assert.fail(`downloaded ${file.buffer.length} bytes with no limit`);
    } catch (caught) {
      error = caught;
    } finally {
      closeServer(server);
    }
    assertLimit(error);
    assert.ok(
      bytes < RESUME_BYTE_LIMIT + 1_000_000,
      `streamed ${bytes} bytes; the cap must abort the socket near ${RESUME_BYTE_LIMIT}`,
    );
    assert.ok(bytes < total - 1_000_000, `the full ${total} byte body was written`);
  });

  test("applies the streaming budget to the response after a redirect", async () => {
    const total = RESUME_BYTE_LIMIT + 3_000_000;
    let bytes = 0;
    let stopped = false;
    const target = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      const chunk = Buffer.alloc(64 * 1024, 0x25);
      const write = () => {
        if (stopped || bytes >= total) {
          if (!stopped) res.end();
          return;
        }
        bytes += chunk.length;
        if (!res.write(chunk)) res.once("drain", write);
        else setImmediate(write);
      };
      res.on("close", () => {
        stopped = true;
      });
      res.on("error", () => {
        stopped = true;
      });
      write();
    });
    const targetPort = await listen(target);
    const front = http.createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/resume.pdf` });
      res.end();
    });
    const frontPort = await listen(front);
    let error: unknown;
    try {
      const file = await downloadResumeFile(`http://127.0.0.1:${frontPort}/start`);
      assert.fail(`followed the redirect and buffered ${file.buffer.length} bytes`);
    } catch (caught) {
      error = caught;
    } finally {
      closeServer(front);
      closeServer(target);
    }
    assertLimit(error);
    assert.ok(bytes > 0, "redirect target was never contacted");
    assert.ok(
      bytes < RESUME_BYTE_LIMIT + 1_000_000,
      `redirect target streamed ${bytes} bytes`,
    );
  });

  test("accepts a body at the budget and a small PDF under it", async () => {
    const pdf = buildPdf("BT /F1 12 Tf 72 720 Td (HelloResume) Tj ET");
    assert.ok(pdf.length < RESUME_BYTE_LIMIT);
    const exact = Buffer.alloc(RESUME_BYTE_LIMIT, 0x61);
    const server = http.createServer((req, res) => {
      const body = req.url === "/exact.bin" ? exact : pdf;
      res.writeHead(200, {
        "Content-Type": req.url === "/exact.bin" ? "application/octet-stream" : "application/pdf",
        "Content-Length": String(body.length),
      });
      res.end(body);
    });
    const port = await listen(server);
    try {
      const atLimit = await downloadResumeFile(`http://127.0.0.1:${port}/exact.bin`);
      assert.equal(atLimit.buffer.length, RESUME_BYTE_LIMIT);
      const file = await downloadResumeFile(`http://127.0.0.1:${port}/resume.pdf`);
      assert.ok(file.buffer.length < RESUME_BYTE_LIMIT);
      const text = await extractTextFromResume(file.buffer, file.mime, file.extension);
      assert.match(text, /HelloResume/);
    } finally {
      closeServer(server);
    }
  });

  test("rejects a Word document whose compressed package expands past the budget, before inflation", async () => {
    const text = "A".repeat(RESUME_BYTE_LIMIT + 1_000_000);
    const docx = await buildDocx(text);
    assert.ok(docx.length < RESUME_BYTE_LIMIT, `fixture was not compressed (${docx.length})`);
    inflatedBytes = 0;
    let error: unknown;
    let extracted = "";
    try {
      extracted = await extractTextFromResume(
        docx,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
      );
    } catch (caught) {
      error = caught;
    }
    assert.ok(
      inflatedBytes <= RESUME_BYTE_LIMIT + 64 * 1024,
      `Word parser inflated ${inflatedBytes} bytes before refusing`,
    );
    assert.equal(extracted.length, 0);
    assertLimit(error);
  });

  test("reads a small Word document under the budget", async () => {
    const docx = await buildDocx("Known candidate history");
    inflatedBytes = 0;
    const text = await extractTextFromResume(
      docx,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
    );
    assert.match(text, /Known candidate history/);
    assert.ok(inflatedBytes <= RESUME_BYTE_LIMIT);
  });

  test("rejects a small flate PDF whose decoded text stream exceeds the budget, before that allocation", async () => {
    const warm = buildPdf(
      `BT /F1 12 Tf 72 720 Td (${"C".repeat(80)} HelloResume) Tj ET`,
    );
    await extractTextFromResume(warm, "application/pdf", "pdf");
    if (global.gc) global.gc();

    const bomb = buildPdf(`BT /F1 12 Tf 72 720 Td (${"B".repeat(1_500_000)}) Tj ET`);
    assert.ok(bomb.length < 64 * 1024, `PDF fixture is not small (${bomb.length})`);
    const before = process.memoryUsage().heapUsed;
    let error: unknown;
    let extracted = "";
    try {
      extracted = await extractTextFromResume(bomb, "application/pdf", "pdf");
    } catch (caught) {
      error = caught;
    }
    const heapDelta = process.memoryUsage().heapUsed - before;
    assert.ok(
      heapDelta < 20_000_000,
      `PDF parser grew the heap by ${heapDelta} bytes while decoding a ${bomb.length} byte file`,
    );
    assert.equal(extracted.length, 0);
    assertLimit(error);
  });

  test("rejects a short-text PDF whose OCR pixmap exceeds the raster budget before allocating it", async () => {
    const letter = buildPdf("BT /F1 24 Tf 72 72 Td (Hi) Tj ET", "0 0 612 792");
    const wide = buildPdf("BT /F1 24 Tf 72 72 Td (Hi) Tj ET", "0 0 1600 1600");
    const wideBytes = 1600 * RASTER_SCALE * 1600 * RASTER_SCALE * 3;
    assert.ok(wideBytes > RASTER_BYTE_LIMIT);

    const letterText = await extractTextFromResume(letter, "application/pdf", "pdf");
    assert.match(letterText, /Hi/);
    if (global.gc) global.gc();

    const before = process.memoryUsage().external;
    let error: unknown;
    try {
      await extractTextFromResume(wide, "application/pdf", "pdf");
    } catch (caught) {
      error = caught;
    }
    const externalDelta = process.memoryUsage().external - before;
    assert.ok(
      externalDelta < 40_000_000,
      `OCR raster grew external memory by ${externalDelta} bytes`,
    );
    assertLimit(error);
  });

  test("rejects a non-PDF buffer larger than the budget", async () => {
    const buffer = Buffer.alloc(RESUME_BYTE_LIMIT + 1, 0x61);
    let error: unknown;
    try {
      await extractTextFromResume(buffer, "text/plain", "txt");
    } catch (caught) {
      error = caught;
    }
    assertLimit(error);
  });
});
