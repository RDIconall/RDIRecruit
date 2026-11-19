import zlib from "node:zlib";
import { ResumeByteLimitError } from "./byte-limit";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 4096;

type Entry = { method: number; data: Buffer };

/**
 * Minimal read-only view of a .docx package for mammoth's `file` input. Parts
 * are inflated on demand with a hard output ceiling shared across the whole
 * package, so a small archive cannot expand past `budget` bytes in memory.
 * mammoth never sees the original archive, so its own unzip path never runs.
 */
export function openBoundedDocx(buffer: Buffer, budget: number) {
  const entries = readCentralDirectory(buffer);
  let remaining = budget;

  function inflate(name: string): Buffer {
    const entry = entries.get(name);
    if (!entry) throw new Error(`Word document part missing: ${name}`);
    let out: Buffer;
    if (entry.method === 0) {
      out = entry.data;
    } else {
      try {
        out = zlib.inflateRawSync(entry.data, { maxOutputLength: remaining + 1 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw new ResumeByteLimitError(`Word document expands past ${budget} bytes`);
        }
        throw new Error("Word document part is corrupt");
      }
    }
    if (out.length > remaining) {
      throw new ResumeByteLimitError(`Word document expands past ${budget} bytes`);
    }
    remaining -= out.length;
    return out;
  }

  return {
    exists(name: string) {
      return entries.has(name);
    },
    async read(name: string, encoding?: string) {
      const bytes = inflate(name);
      if (encoding === "base64") return bytes.toString("base64");
      if (encoding) return new TextDecoder(encoding).decode(bytes);
      return new Uint8Array(bytes);
    },
    write() {
      throw new Error("Word document is read-only");
    },
    async toArrayBuffer() {
      throw new Error("Word document is read-only");
    },
  };
}

function readCentralDirectory(buffer: Buffer): Map<string, Entry> {
  const invalid = () => new Error("Unsupported Word document: not a valid .docx package");
  const minEocd = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minEocd; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid();

  const count = buffer.readUInt16LE(eocd + 10);
  const dirSize = buffer.readUInt32LE(eocd + 12);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff || dirSize === 0xffffffff) throw invalid();
  if (count > MAX_ENTRIES) throw new ResumeByteLimitError(`Word document has more than ${MAX_ENTRIES} parts`);
  if (dirOffset + dirSize > buffer.length) throw invalid();

  const entries = new Map<string, Entry>();
  let pos = dirOffset;
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw invalid();
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString("utf8", pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error("Unsupported Word document: encrypted package");
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw invalid();
    if (method !== 0 && method !== 8) throw invalid();
    if (name.endsWith("/")) continue;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw invalid();
    const dataStart =
      localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > buffer.length) throw invalid();
    entries.set(name, { method, data: buffer.subarray(dataStart, dataStart + compressedSize) });
  }
  return entries;
}
