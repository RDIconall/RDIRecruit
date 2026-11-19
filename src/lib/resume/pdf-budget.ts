import zlib from "node:zlib";
import type { PDFDocument, PDFObject } from "mupdf";
import { IMAGE_BYTE_LIMIT, RESUME_BYTE_LIMIT, ResumeByteLimitError } from "./byte-limit";

/**
 * Pre-parse budget for applicant PDFs.
 *
 * pdfjs (via pdf-parse) and mupdf decode every Flate / LZW / RunLength / ASCII
 * stream fully in memory, and pdfjs turns each shown character into a glyph
 * object, so a few KB of compressed content can cost hundreds of MB. Neither
 * library exposes a decode ceiling, so the file is measured here first:
 *
 *  1. A raw scan bounds the structural streams (xref and object streams) that
 *     mupdf itself decodes while opening the file.
 *  2. mupdf rewrites the file as a plain, decrypted PDF. Every non-image stream
 *     of that rewrite is decoded with bounded decoders against one budget.
 *  3. Image streams, and anything else using an image codec, are emptied in the
 *     copy handed to pdfjs: text extraction never needs them, and a content
 *     stream mislabelled as an image can then not be decoded at all.
 *
 * pdfjs parses exactly the bytes measured in step 2, and the OCR renderer
 * opens the same rewrite with images intact.
 */

const DECODE_FLOOR_BYTES = 256 * 1024;
const MAX_EXPANSION_RATIO = 50;
const MAX_PDF_OBJECTS = 100_000;
const MAX_STREAM_KEYWORDS = 100_000;
const MAX_FILTERS = 16;
const DICT_WINDOW = 16 * 1024;
const MAX_DICT_CANDIDATES = 64;
const SCAN_WORK_LIMIT = 50_000_000;
const REWRITE_BYTE_LIMIT = 2 * RESUME_BYTE_LIMIT;

const IMAGE_CODECS = new Set(["DCTDecode", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode"]);
const FILTER_ALIASES: Record<string, string> = {
  Fl: "FlateDecode",
  LZW: "LZWDecode",
  RL: "RunLengthDecode",
  AHx: "ASCIIHexDecode",
  A85: "ASCII85Decode",
  DCT: "DCTDecode",
  CCF: "CCITTFaxDecode",
};

type FilterSpec = { name: string; earlyChange: number };

export type SanitizedPdf = {
  /** Rewrite with image streams emptied, for text extraction. */
  textPdf: Buffer;
  /** Rewrite with images intact, for OCR rendering. */
  renderPdf: Buffer;
  /** Largest decoded image (bytes) the renderer may have to materialise. */
  maxImageBytes: number;
};

export function pdfDecodeBudget(fileBytes: number): number {
  return Math.min(RESUME_BYTE_LIMIT, Math.max(DECODE_FLOOR_BYTES, fileBytes * MAX_EXPANSION_RATIO));
}

export async function sanitizePdfForParsing(buffer: Buffer): Promise<SanitizedPdf> {
  if (buffer.length > RESUME_BYTE_LIMIT) {
    throw new ResumeByteLimitError(`PDF is ${buffer.length} bytes`);
  }
  await assertStructuralStreamsWithinBudget(buffer);

  const mupdf = await import("mupdf");
  const original = openPdf(mupdf, buffer);
  let renderPdf: Buffer;
  try {
    if (original.countObjects() > MAX_PDF_OBJECTS) {
      throw new ResumeByteLimitError(`PDF declares more than ${MAX_PDF_OBJECTS} objects`);
    }
    renderPdf = saveWithinLimit(original, "decrypt");
  } finally {
    original.destroy();
  }

  await assertStructuralStreamsWithinBudget(renderPdf);
  const doc = openPdf(mupdf, renderPdf);
  try {
    const budget = pdfDecodeBudget(buffer.length);
    const count = doc.countObjects();
    if (count > MAX_PDF_OBJECTS) {
      throw new ResumeByteLimitError(`PDF declares more than ${MAX_PDF_OBJECTS} objects`);
    }

    let decoded = 0;
    let maxImageBytes = 0;
    const emptied = new Set<number>();
    const contentRefs = new Set<number>();
    const inlineImages = new Map<number, number>();

    for (let num = 1; num < count; num += 1) {
      const obj = doc.newIndirect(num);
      let raw: Buffer;
      try {
        collectContentRefs(obj, contentRefs);
        if (!obj.isStream()) continue;
        raw = Buffer.from(obj.readRawStream().asUint8Array());
      } catch {
        // Anything mupdf cannot read is not measured, so it must not reach pdfjs.
        emptied.add(num);
        continue;
      }

      const filters = filterSpecs(obj);
      const subtype = nameOf(obj.get("Subtype"));
      if (isImageStream(obj)) {
        if (hasKey(obj, "PatternType")) throw new Error("Unsupported PDF: image stream used as a pattern");
        maxImageBytes = Math.max(maxImageBytes, declaredImageBytes(obj, filters, raw));
        emptied.add(num);
        continue;
      }
      if (filters.some((f) => IMAGE_CODECS.has(f.name))) {
        if (subtype === "Form" || hasKey(obj, "PatternType")) {
          throw new Error("Unsupported PDF: content stream uses an image codec");
        }
        emptied.add(num);
        continue;
      }
      const data = await decodeFilters(raw, filters, budget - decoded, budget);
      decoded += data.length;
      if (subtype === "Form" || hasKey(obj, "PatternType")) contentRefs.add(num);
      inlineImages.set(num, inlineImageBytes(data));
    }

    for (const ref of contentRefs) {
      if (emptied.has(ref)) throw new Error("Unsupported PDF: page content is not a content stream");
      maxImageBytes = Math.max(maxImageBytes, inlineImages.get(ref) ?? 0);
    }

    for (const num of emptied) doc.newIndirect(num).writeStream(new Uint8Array(0));
    const textPdf = saveWithinLimit(doc, "");
    return { textPdf, renderPdf, maxImageBytes };
  } finally {
    doc.destroy();
  }
}

type MupdfModule = typeof import("mupdf");

function openPdf(mupdf: MupdfModule, buffer: Buffer): PDFDocument {
  let doc: PDFDocument | null = null;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(buffer), "application/pdf").asPDF();
  } catch {
    throw new Error("Unreadable PDF");
  }
  if (!doc) throw new Error("Unreadable PDF");
  if (doc.needsPassword()) {
    doc.destroy();
    throw new Error("PDF is password protected");
  }
  return doc;
}

function saveWithinLimit(doc: PDFDocument, options: string): Buffer {
  const out = doc.saveToBuffer(options);
  try {
    const bytes = out.asUint8Array();
    if (bytes.length > REWRITE_BYTE_LIMIT) {
      throw new ResumeByteLimitError(`PDF objects expand past ${REWRITE_BYTE_LIMIT} bytes`);
    }
    return Buffer.from(bytes);
  } finally {
    out.destroy();
  }
}

/** mupdf returns a shared Null object for missing keys, and resolving it throws. */
function resolveSafe(obj: PDFObject): PDFObject {
  return obj.isNull() ? obj : obj.resolve();
}

function nameOf(obj: PDFObject): string | null {
  const resolved = resolveSafe(obj);
  return resolved.isName() ? resolved.asName() : null;
}

function numberOf(obj: PDFObject): number | null {
  const resolved = resolveSafe(obj);
  return resolved.isNumber() ? resolved.asNumber() : null;
}

function hasKey(obj: PDFObject, key: string): boolean {
  return !obj.get(key).isNull();
}

function isImageStream(obj: PDFObject): boolean {
  const subtype = nameOf(obj.get("Subtype"));
  if (subtype === "Image") return true;
  return subtype === null && hasKey(obj, "Width") && hasKey(obj, "Height") && !hasKey(obj, "BBox");
}

function collectContentRefs(obj: PDFObject, refs: Set<number>) {
  const resolved = resolveSafe(obj);
  if (!resolved.isDictionary()) return;
  const addRef = (value: PDFObject) => {
    if (!value.isNull() && value.isIndirect()) refs.add(value.asIndirect());
  };
  if (nameOf(resolved.get("Type")) === "Page") {
    const contents = resolved.get("Contents");
    addRef(contents);
    const list = resolveSafe(contents);
    if (list.isArray()) list.forEach((item) => addRef(item));
  }
  const charProcs = resolveSafe(resolved.get("CharProcs"));
  if (charProcs.isDictionary()) charProcs.forEach((item) => addRef(item));
}

function filterSpecs(obj: PDFObject): FilterSpec[] {
  const filter = resolveSafe(obj.get("Filter"));
  const parms = resolveSafe(obj.get("DecodeParms"));
  const names: PDFObject[] = [];
  if (filter.isArray()) filter.forEach((item) => names.push(item));
  else if (!filter.isNull()) names.push(filter);
  if (names.length > MAX_FILTERS) throw new Error("Unsupported PDF: too many stream filters");
  return names.map((item, index) => {
    const raw = nameOf(item) ?? "";
    const parm = parms.isArray() ? resolveSafe(parms.get(index)) : parms;
    const early = parm.isDictionary() ? numberOf(parm.get("EarlyChange")) : null;
    return { name: FILTER_ALIASES[raw] ?? raw, earlyChange: early === 0 ? 0 : 1 };
  });
}

function colorComponents(obj: PDFObject): number {
  if (resolveSafe(obj.get("ImageMask")).isBoolean() && resolveSafe(obj.get("ImageMask")).asBoolean()) return 1;
  const cs = resolveSafe(obj.get("ColorSpace"));
  const name = cs.isName() ? cs.asName() : cs.isArray() ? nameOf(cs.get(0)) : null;
  switch (name) {
    case "DeviceGray":
    case "G":
    case "CalGray":
    case "Separation":
      return 1;
    case "DeviceRGB":
    case "RGB":
    case "CalRGB":
    case "Lab":
      return 3;
    default:
      return 4;
  }
}

function declaredImageBytes(obj: PDFObject, filters: FilterSpec[], raw: Buffer): number {
  const width = numberOf(obj.get("Width"));
  const height = numberOf(obj.get("Height"));
  if (width === null || height === null || width <= 0 || height <= 0) return Infinity;
  let bytes = width * height * colorComponents(obj);
  if (filters.some((f) => f.name === "JPXDecode")) bytes = Math.max(bytes, jpxDecodedBytes(raw));
  if (filters.some((f) => f.name === "JBIG2Decode")) bytes = Math.max(bytes, jbig2PageBytes(raw, height));
  return bytes;
}

/** Decoded size from the JPEG 2000 SIZ marker; the decoder sizes its buffers from it, not the dict. */
function jpxDecodedBytes(raw: Buffer): number {
  for (let i = 0; i + 40 < raw.length; i += 1) {
    if (raw[i] === 0xff && raw[i + 1] === 0x4f && raw[i + 2] === 0xff && raw[i + 3] === 0x51) {
      const p = i + 4;
      const width = raw.readUInt32BE(p + 4) - raw.readUInt32BE(p + 12);
      const height = raw.readUInt32BE(p + 8) - raw.readUInt32BE(p + 16);
      const components = raw.readUInt16BE(p + 36);
      return Math.max(0, width) * Math.max(0, height) * Math.max(1, components);
    }
  }
  return Infinity;
}

/** Page bitmap size from the first JBIG2 page-information segment (1 byte per pixel once expanded). */
function jbig2PageBytes(raw: Buffer, dictHeight: number): number {
  let pos = 0;
  while (pos + 11 <= raw.length) {
    const segment = raw.readUInt32BE(pos);
    const flags = raw[pos + 4];
    const type = flags & 0x3f;
    pos += 5;
    let referred = raw[pos] >> 5;
    if (referred === 7) {
      if (pos + 4 > raw.length) break;
      referred = raw.readUInt32BE(pos) & 0x1fffffff;
      pos += 4 + Math.ceil((referred + 1) / 8);
    } else {
      pos += 1;
    }
    pos += referred * (segment <= 256 ? 1 : segment <= 65536 ? 2 : 4);
    pos += flags & 0x40 ? 4 : 1;
    if (pos + 4 > raw.length) break;
    const length = raw.readUInt32BE(pos);
    pos += 4;
    if (type === 48) {
      if (pos + 8 > raw.length) break;
      const width = raw.readUInt32BE(pos);
      const rawHeight = raw.readUInt32BE(pos + 4);
      const height = rawHeight === 0xffffffff ? dictHeight : rawHeight;
      return width * height;
    }
    if (length === 0xffffffff) break;
    pos += length;
  }
  return Infinity;
}

/** Largest inline image (BI … ID) declared in a decoded content stream. */
function inlineImageBytes(data: Buffer): number {
  const text = data.toString("latin1");
  const pattern = /(?:^|[\s\]>)}])BI\s([\s\S]{0,4096}?)\sID[\s]/g;
  let max = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const header = match[1];
    const width = Number(/\/(?:W|Width)\s*(\d+)/.exec(header)?.[1] ?? 0);
    const height = Number(/\/(?:H|Height)\s*(\d+)/.exec(header)?.[1] ?? 0);
    max = Math.max(max, width * height * 4);
    if (max > IMAGE_BYTE_LIMIT) break;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Bounded stream decoders
// ---------------------------------------------------------------------------

class BoundedOutput {
  private buf: Buffer;
  length = 0;

  constructor(
    private readonly cap: number,
    private readonly budget: number,
  ) {
    this.buf = Buffer.allocUnsafe(Math.min(Math.max(cap, 0), 64 * 1024) || 1);
  }

  private ensure(extra: number) {
    const needed = this.length + extra;
    if (needed > this.cap) throw new ResumeByteLimitError(`PDF streams decode past ${this.budget} bytes`);
    if (needed <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.min(this.cap, Math.max(needed, this.buf.length * 2)));
    this.buf.copy(next, 0, 0, this.length);
    this.buf = next;
  }

  push(byte: number) {
    this.ensure(1);
    this.buf[this.length++] = byte;
  }

  fill(byte: number, count: number) {
    this.ensure(count);
    this.buf.fill(byte, this.length, this.length + count);
    this.length += count;
  }

  copyFrom(source: Buffer, start: number, end: number) {
    this.ensure(end - start);
    source.copy(this.buf, this.length, start, end);
    this.length += end - start;
  }

  result(): Buffer {
    return this.buf.subarray(0, this.length);
  }
}

/**
 * Decode `data` through `filters`, refusing once any stage would produce more
 * than `cap` bytes. Image codecs end the chain; unknown filters pass data
 * through unchanged, as pdfjs and mupdf do.
 */
export async function decodeFilters(
  data: Buffer,
  filters: FilterSpec[],
  cap: number,
  budget: number,
): Promise<Buffer> {
  let current = data;
  for (const filter of filters) {
    switch (filter.name) {
      case "FlateDecode":
        current = await inflateBounded(current, cap, budget);
        break;
      case "LZWDecode":
        current = lzwDecode(current, filter.earlyChange, new BoundedOutput(cap, budget));
        break;
      case "RunLengthDecode":
        current = runLengthDecode(current, new BoundedOutput(cap, budget));
        break;
      case "ASCIIHexDecode":
        current = asciiHexDecode(current, new BoundedOutput(cap, budget));
        break;
      case "ASCII85Decode":
        current = ascii85Decode(current, new BoundedOutput(cap, budget));
        break;
      default:
        if (IMAGE_CODECS.has(filter.name)) return current;
        break;
    }
  }
  if (current.length > cap) throw new ResumeByteLimitError(`PDF streams decode past ${budget} bytes`);
  return current;
}

function inflateBounded(input: Buffer, cap: number, budget: number): Promise<Buffer> {
  return inflateWith(input, cap, budget, false).then((out) =>
    out.length > 0 ? out : inflateWith(input, cap, budget, true),
  );
}

function inflateWith(input: Buffer, cap: number, budget: number, raw: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const options = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
    const inflater = raw ? zlib.createInflateRaw(options) : zlib.createInflate(options);
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    };
    inflater.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > cap) {
        settled = true;
        inflater.destroy();
        reject(new ResumeByteLimitError(`PDF streams decode past ${budget} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    // Corrupt or truncated data: keep what decoded so far, like pdfjs/mupdf.
    inflater.on("error", finish);
    inflater.on("end", finish);
    inflater.end(input);
  });
}

function lzwDecode(input: Buffer, earlyChange: number, out: BoundedOutput): Buffer {
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const lengths = new Uint16Array(4096);
  for (let i = 0; i < 256; i += 1) {
    prefix[i] = -1;
    suffix[i] = i;
    lengths[i] = 1;
  }
  const scratch = Buffer.allocUnsafe(4096);
  let nextCode = 258;
  let codeLength = 9;
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;
  let pos = 0;

  const emit = (code: number): number => {
    const length = lengths[code];
    let cursor = code;
    for (let i = length - 1; i >= 0; i -= 1) {
      scratch[i] = suffix[cursor];
      cursor = prefix[cursor];
    }
    out.copyFrom(scratch, 0, length);
    return scratch[0];
  };

  for (;;) {
    while (bitCount < codeLength && pos < input.length) {
      bitBuffer = ((bitBuffer << 8) | input[pos++]) >>> 0;
      bitCount += 8;
    }
    if (bitCount < codeLength) break;
    const code = (bitBuffer >>> (bitCount - codeLength)) & ((1 << codeLength) - 1);
    bitCount -= codeLength;
    bitBuffer &= (1 << bitCount) - 1;

    if (code === 256) {
      nextCode = 258;
      codeLength = 9;
      previous = -1;
      continue;
    }
    if (code === 257) break;
    if (previous === -1) {
      if (code > 255) break;
      out.push(code);
      previous = code;
      continue;
    }
    let first: number;
    if (code < nextCode) {
      first = emit(code);
    } else if (code === nextCode) {
      first = emit(previous);
      out.push(first);
    } else {
      break;
    }
    if (nextCode < 4096) {
      prefix[nextCode] = previous;
      suffix[nextCode] = first;
      lengths[nextCode] = lengths[previous] + 1;
      nextCode += 1;
    }
    const threshold = nextCode + earlyChange;
    codeLength = threshold >= 2048 ? 12 : threshold >= 1024 ? 11 : threshold >= 512 ? 10 : 9;
    previous = code;
  }
  return out.result();
}

function runLengthDecode(input: Buffer, out: BoundedOutput): Buffer {
  let pos = 0;
  while (pos < input.length) {
    const length = input[pos++];
    if (length === 128) break;
    if (length < 128) {
      const end = Math.min(input.length, pos + length + 1);
      out.copyFrom(input, pos, end);
      pos = end;
    } else {
      if (pos >= input.length) break;
      out.fill(input[pos++], 257 - length);
    }
  }
  return out.result();
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function asciiHexDecode(input: Buffer, out: BoundedOutput): Buffer {
  let high = -1;
  for (let pos = 0; pos < input.length; pos += 1) {
    const c = input[pos];
    if (c === 0x3e) break;
    const value = hexValue(c);
    if (value < 0) continue;
    if (high < 0) {
      high = value;
    } else {
      out.push((high << 4) | value);
      high = -1;
    }
  }
  if (high >= 0) out.push(high << 4);
  return out.result();
}

function ascii85Decode(input: Buffer, out: BoundedOutput): Buffer {
  const group: number[] = [];
  const flush = (count: number) => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) value = value * 85 + (i < count ? group[i] : 84);
    for (let i = 0; i < count - 1; i += 1) out.push((value >>> (24 - 8 * i)) & 0xff);
  };
  for (let pos = 0; pos < input.length; pos += 1) {
    const c = input[pos];
    if (c === 0x7e) break;
    if (c === 0x7a && group.length === 0) {
      out.fill(0, 4);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) {
      flush(5);
      group.length = 0;
    }
  }
  if (group.length > 1) flush(group.length);
  return out.result();
}

// ---------------------------------------------------------------------------
// Raw scan: bound what mupdf decodes while opening the file
// ---------------------------------------------------------------------------

type RawValue =
  | { kind: "name"; value: string }
  | { kind: "number"; value: number }
  | { kind: "ref" }
  | { kind: "array"; items: RawValue[] }
  | { kind: "dict"; entries: Map<string, RawValue> }
  | { kind: "other" };

const STRUCTURAL_KEYS = ["N", "First", "W"];

/**
 * mupdf decodes xref streams and object streams on open, before any object can
 * be inspected. Every `stream` keyword in the raw file is located, the
 * dictionary in front of it read, and any stream mupdf could treat as an xref
 * or object stream (or whose dictionary cannot be read) is decoded with the
 * bounded decoders from its first byte to the end of the file.
 */
export async function assertStructuralStreamsWithinBudget(buffer: Buffer): Promise<void> {
  const text = buffer.toString("latin1");
  const work = { left: SCAN_WORK_LIMIT };
  let decoded = 0;
  let keywords = 0;

  for (let at = text.indexOf("stream"); at >= 0; at = text.indexOf("stream", at + 6)) {
    const close = dictionaryCloseBefore(text, at);
    if (close < 0) continue;
    keywords += 1;
    if (keywords > MAX_STREAM_KEYWORDS) {
      throw new ResumeByteLimitError(`PDF has more than ${MAX_STREAM_KEYWORDS} streams`);
    }

    let dataStart = at + 6;
    if (text[dataStart] === "\r") dataStart += 1;
    if (text[dataStart] === "\n") dataStart += 1;

    const dicts = dictionariesEndingAt(text, close, work);
    const structural =
      dicts.length === 0 || dicts.some((d) => STRUCTURAL_KEYS.some((key) => d.has(key)));
    if (!structural) continue;

    const chains = dicts.length ? dicts.map(rawFilterChain) : [[{ name: "FlateDecode", earlyChange: 1 }]];
    const data = buffer.subarray(dataStart);
    let largest = 0;
    for (const chain of chains) {
      const out = await decodeFilters(data, chain, RESUME_BYTE_LIMIT - decoded, RESUME_BYTE_LIMIT);
      largest = Math.max(largest, out.length);
    }
    decoded += largest;
  }
}

function isPdfWhitespace(c: string | undefined): boolean {
  return c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
}

function isPdfDelimiter(c: string | undefined): boolean {
  return c !== undefined && "()<>[]{}/%".includes(c);
}

/** Index just past the `>>` that precedes this `stream` keyword, or -1. */
function dictionaryCloseBefore(text: string, at: number): number {
  if (!isPdfWhitespace(text[at - 1]) && text[at - 1] !== ">") return -1;
  let pos = at - 1;
  for (let lines = 0; lines < 16; lines += 1) {
    while (pos >= 0 && isPdfWhitespace(text[pos])) pos -= 1;
    if (pos >= 1 && text[pos] === ">" && text[pos - 1] === ">") return pos + 1;
    const lineStart = Math.max(text.lastIndexOf("\n", pos), text.lastIndexOf("\r", pos)) + 1;
    const comment = text.indexOf("%", lineStart);
    if (comment < 0 || comment > pos) return -1;
    pos = comment - 1;
  }
  return -1;
}

/**
 * Every dictionary that parses cleanly and ends exactly at `close`. More than
 * one can match when comments or strings contain `<<`; all are returned so the
 * caller can take the most conservative reading.
 */
function dictionariesEndingAt(
  text: string,
  close: number,
  work: { left: number },
): Map<string, RawValue>[] {
  const found: Map<string, RawValue>[] = [];
  const floor = Math.max(0, close - DICT_WINDOW);
  let candidate = close - 2;
  for (let tries = 0; tries < MAX_DICT_CANDIDATES; tries += 1) {
    candidate = text.lastIndexOf("<<", candidate - 1);
    if (candidate < floor) break;
    const parser = new RawParser(text, candidate, close, work);
    const dict = parser.parseDictionaryExact();
    if (dict) found.push(dict);
  }
  return found;
}

function rawFilterChain(dict: Map<string, RawValue>): FilterSpec[] {
  const filter = dict.get("Filter") ?? dict.get("F");
  if (!filter) return [];
  const items = filter.kind === "array" ? filter.items : [filter];
  if (items.length > MAX_FILTERS || items.some((item) => item.kind !== "name")) {
    throw new Error("Unsupported PDF: indirect or invalid stream filter");
  }
  const parms = dict.get("DecodeParms") ?? dict.get("DP");
  return items.map((item, index) => {
    const name = (item as { value: string }).value;
    const parm = parms?.kind === "array" ? parms.items[index] : parms;
    const early = parm?.kind === "dict" ? parm.entries.get("EarlyChange") : undefined;
    return {
      name: FILTER_ALIASES[name] ?? name,
      earlyChange: early?.kind === "number" && early.value === 0 ? 0 : 1,
    };
  });
}

class RawParser {
  private pos: number;

  constructor(
    private readonly text: string,
    start: number,
    private readonly end: number,
    private readonly work: { left: number },
  ) {
    this.pos = start;
  }

  parseDictionaryExact(): Map<string, RawValue> | null {
    try {
      const value = this.parseValue(0);
      if (value.kind !== "dict" || this.pos !== this.end) return null;
      return value.entries;
    } catch (error) {
      if (error instanceof ResumeByteLimitError) throw error;
      return null;
    }
  }

  private tick() {
    this.work.left -= 1;
    if (this.work.left < 0) throw new ResumeByteLimitError("PDF structure is too complex to scan");
    if (this.pos > this.end) throw new Error("past end");
  }

  private skipWhitespace() {
    for (;;) {
      this.tick();
      const c = this.text[this.pos];
      if (isPdfWhitespace(c)) {
        this.pos += 1;
      } else if (c === "%") {
        while (this.pos < this.end && this.text[this.pos] !== "\n" && this.text[this.pos] !== "\r") {
          this.tick();
          this.pos += 1;
        }
      } else {
        return;
      }
    }
  }

  private parseValue(depth: number): RawValue {
    if (depth > 32) throw new Error("too deep");
    this.skipWhitespace();
    const c = this.text[this.pos];
    if (c === "<" && this.text[this.pos + 1] === "<") return this.parseDictionary(depth);
    if (c === "<") return this.parseHexString();
    if (c === "(") return this.parseLiteralString();
    if (c === "[") return this.parseArray(depth);
    if (c === "/") return { kind: "name", value: this.parseName() };
    if (c !== undefined && /[0-9+\-.]/.test(c)) return { kind: "number", value: this.parseNumber() };
    const word = this.parseRegular();
    if (word === "true" || word === "false" || word === "null") return { kind: "other" };
    throw new Error(`unexpected token ${word}`);
  }

  private parseDictionary(depth: number): RawValue {
    this.pos += 2;
    const entries = new Map<string, RawValue>();
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] === ">" && this.text[this.pos + 1] === ">") {
        this.pos += 2;
        return { kind: "dict", entries };
      }
      if (this.text[this.pos] !== "/") throw new Error("expected key");
      const key = this.parseName();
      entries.set(key, this.parseMaybeRef(depth + 1));
    }
  }

  private parseArray(depth: number): RawValue {
    this.pos += 1;
    const items: RawValue[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] === "]") {
        this.pos += 1;
        return { kind: "array", items };
      }
      items.push(this.parseMaybeRef(depth + 1));
    }
  }

  private parseMaybeRef(depth: number): RawValue {
    const value = this.parseValue(depth);
    if (value.kind !== "number" || !Number.isInteger(value.value)) return value;
    const saved = this.pos;
    this.skipWhitespace();
    if (/[0-9]/.test(this.text[this.pos] ?? "")) {
      const generation = this.parseNumber();
      this.skipWhitespace();
      if (Number.isInteger(generation) && this.text[this.pos] === "R") {
        const after = this.text[this.pos + 1];
        if (isPdfWhitespace(after) || isPdfDelimiter(after)) {
          this.pos += 1;
          return { kind: "ref" };
        }
      }
    }
    this.pos = saved;
    return value;
  }

  private parseName(): string {
    this.pos += 1;
    let name = "";
    for (;;) {
      this.tick();
      const c = this.text[this.pos];
      if (c === undefined || isPdfWhitespace(c) || isPdfDelimiter(c)) return name;
      if (c === "#" && /^[0-9a-fA-F]{2}$/.test(this.text.slice(this.pos + 1, this.pos + 3))) {
        name += String.fromCharCode(parseInt(this.text.slice(this.pos + 1, this.pos + 3), 16));
        this.pos += 3;
      } else {
        name += c;
        this.pos += 1;
      }
    }
  }

  private parseNumber(): number {
    const start = this.pos;
    while (/[0-9+\-.]/.test(this.text[this.pos] ?? "")) {
      this.tick();
      this.pos += 1;
    }
    const value = Number(this.text.slice(start, this.pos));
    if (!Number.isFinite(value)) throw new Error("bad number");
    return value;
  }

  private parseRegular(): string {
    const start = this.pos;
    while (this.pos < this.end) {
      const c = this.text[this.pos];
      if (isPdfWhitespace(c) || isPdfDelimiter(c)) break;
      this.tick();
      this.pos += 1;
    }
    return this.text.slice(start, this.pos);
  }

  private parseHexString(): RawValue {
    this.pos += 1;
    for (;;) {
      this.tick();
      const c = this.text[this.pos];
      if (c === ">") {
        this.pos += 1;
        return { kind: "other" };
      }
      if (c === undefined || (!isPdfWhitespace(c) && hexValue(c.charCodeAt(0)) < 0)) {
        throw new Error("bad hex string");
      }
      this.pos += 1;
    }
  }

  private parseLiteralString(): RawValue {
    this.pos += 1;
    let nesting = 1;
    for (;;) {
      this.tick();
      const c = this.text[this.pos];
      if (c === undefined) throw new Error("unterminated string");
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (c === "(") nesting += 1;
      if (c === ")") nesting -= 1;
      this.pos += 1;
      if (nesting === 0) return { kind: "other" };
    }
  }
}
