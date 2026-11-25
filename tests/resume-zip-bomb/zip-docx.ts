import { crc32, deflateRawSync } from "node:zlib";

export const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

/** Well above the cap, still highly compressible (repeated bytes). */
export const BOMB_ENTRY_BYTES = 96 * 1024 * 1024;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

export function documentXml(text: Buffer | string): Buffer {
  const body = typeof text === "string" ? Buffer.from(text) : text;
  return Buffer.concat([
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body><w:p><w:r><w:t>`,
    ),
    body,
    Buffer.from(`</w:t></w:r></w:p></w:body></w:document>`),
  ]);
}

export interface ZipPart {
  name: string;
  data: Buffer;
  /**
   * When set, both the local and central headers claim this uncompressed
   * size instead of data.length. The deflate stream is still the real part.
   */
  declaredUncompressedSize?: number;
}

/** Minimal docx (ZIP) whose parts mammoth will open. No compression-size cap. */
export function buildDocx(parts: ZipPart[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const checksum = crc32(part.data);
    const compressed = deflateRawSync(part.data, { level: 9 });
    const declared = part.declaredUncompressedSize ?? part.data.length;
    const local = Buffer.concat([
      u32(LOCAL),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(checksum),
      u32(compressed.length),
      u32(declared),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(CENTRAL),
        u16(20),
        u16(20),
        u16(0),
        u16(8),
        u16(0),
        u16(0),
        u32(checksum),
        u32(compressed.length),
        u32(declared),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(EOCD),
    u16(0),
    u16(0),
    u16(parts.length),
    u16(parts.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

export function repeatedBytes(size: number, byte = 0x41): Buffer {
  return Buffer.alloc(size, byte);
}
