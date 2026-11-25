import { inflateRawSync } from "node:zlib";

/**
 * Word documents are ZIP archives whose parts mammoth inflates and parses into a
 * DOM with no size limit of its own. A sub-megabyte upload can deflate to
 * gigabytes, and even a few megabytes of dense markup costs over a gigabyte of
 * DOM (≈1.4 KB per element, ≈150 B per attribute). Both budgets are cumulative
 * across every part mammoth reads from one document.
 */
export const MAX_DOCX_INFLATED_BYTES = 20 * 1024 * 1024;
export const MAX_DOCX_MARKUP_TOKENS = 250_000;
const MAX_DOCX_ENTRIES = 5_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const EOCD_SEARCH_WINDOW = EOCD_MIN_SIZE + 0xffff;
const LT = 0x3c;
const EQ = 0x3d;

export class DocxLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxLimitError";
  }
}

interface ZipEntry {
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** The subset of mammoth's zip-file interface `extractRawText` uses. */
export interface BoundedDocxFile {
  exists(name: string): boolean;
  read(name: string, encoding?: string): Promise<Uint8Array | string>;
  write(name: string, contents: unknown): void;
  toArrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Index the archive's central directory and return a reader that inflates each
 * part on demand against the shared byte and markup budgets. Entry sizes are
 * never taken from the archive's headers, which are attacker-controlled; the
 * inflater itself stops at the remaining budget.
 */
export function openBoundedDocx(buffer: Buffer): BoundedDocxFile {
  const entries = readCentralDirectory(buffer);
  let inflatedBytes = 0;
  let markupTokens = 0;

  function inflateEntry(name: string): Buffer {
    const entry = entries.get(name);
    if (!entry) throw new Error(`Word document is missing ${name}`);
    const data = entryData(buffer, entry);
    const remaining = MAX_DOCX_INFLATED_BYTES - inflatedBytes;

    let out: Buffer;
    if (entry.method === 0) {
      if (data.length > remaining) throw tooLarge();
      out = Buffer.from(data);
    } else {
      try {
        out = inflateRawSync(data, { maxOutputLength: Math.max(1, remaining), chunkSize: 64 * 1024 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
        throw new Error("Word document is corrupt");
      }
      if (out.length > remaining) throw tooLarge();
    }
    inflatedBytes += out.length;

    for (let i = 0; i < out.length; i += 1) {
      const byte = out[i];
      if (byte === LT || byte === EQ) markupTokens += 1;
    }
    if (markupTokens > MAX_DOCX_MARKUP_TOKENS) {
      throw new DocxLimitError("Word document has too much markup to read safely");
    }
    return out;
  }

  return {
    exists: (name) => entries.has(name),
    read: async (name, encoding) => {
      const bytes = inflateEntry(name);
      if (!encoding) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
      if (encoding === "base64") return bytes.toString("base64");
      return new TextDecoder(encoding).decode(bytes);
    },
    write: () => {
      throw new Error("Word document is read-only");
    },
    toArrayBuffer: async () => {
      throw new Error("Word document is read-only");
    },
  };
}

function tooLarge(): DocxLimitError {
  return new DocxLimitError(
    `Word document expands past the ${MAX_DOCX_INFLATED_BYTES / (1024 * 1024)} MB limit`,
  );
}

function notADocx(): Error {
  return new Error("File is not a readable Word (.docx) document");
}

function readCentralDirectory(buffer: Buffer): Map<string, ZipEntry> {
  if (buffer.length < EOCD_MIN_SIZE) throw notADocx();

  let eocd = -1;
  const stop = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= stop; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notADocx();

  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0) throw notADocx();
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw notADocx();
  if (count > MAX_DOCX_ENTRIES) throw new DocxLimitError("Word document has too many parts");
  if (centralOffset + centralSize > eocd) throw notADocx();

  const entries = new Map<string, ZipEntry>();
  let pos = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > eocd || buffer.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw notADocx();
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localHeaderOffset = buffer.readUInt32LE(pos + 42);
    const nameEnd = pos + 46 + nameLength;
    if (nameEnd > eocd) throw notADocx();
    const name = buffer.toString("utf8", pos + 46, nameEnd);
    pos = nameEnd + extraLength + commentLength;

    if (flags & 0x1) throw new Error("Word document is encrypted");
    if (method !== 0 && method !== 8) throw notADocx();
    if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) throw notADocx();
    if (entries.has(name)) throw notADocx();
    entries.set(name, { method, compressedSize, localHeaderOffset });
  }
  return entries;
}

function entryData(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) throw notADocx();
  const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw notADocx();
  return buffer.subarray(start, end);
}
