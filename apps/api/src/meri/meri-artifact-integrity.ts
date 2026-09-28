import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import type { DocFormat } from './meri-docgen.helpers.js';

export const MAX_DOCUMENT_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_PNG_BASE64_CHARS = 3 * 1024 * 1024;
const MAX_PNG_PIXELS = 16_777_216;
const MAX_PNG_INFLATED_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA256_RE = /^[0-9a-f]{64}$/;

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function declaredZipSize(entry: unknown): number | null {
  const size = (entry as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

const OOXML_MAIN_PART: Record<Exclude<DocFormat, 'pdf'>, { path: string; contentType: string }> = {
  docx: {
    path: 'word/document.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  },
  xlsx: {
    path: 'xl/workbook.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  },
  pptx: {
    path: 'ppt/presentation.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  },
};

/** Parse the generated binary at the API owner before it can be persisted or served. */
export async function validateDocumentArtifactBytes(format: DocFormat, bytes: Buffer): Promise<void> {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_ARTIFACT_BYTES) {
    throw new Error('document_size_invalid');
  }
  if (format === 'pdf') {
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('pdf_signature_invalid');
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    if (document.getPageCount() < 1) throw new Error('pdf_has_no_pages');
    return;
  }

  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const names = Object.keys(zip.files);
  if (names.length === 0 || names.length > 5_000) throw new Error('ooxml_entry_count_invalid');
  let declaredTotal = 0;
  for (const name of names) {
    const entry = zip.files[name]!;
    if (entry.dir) continue;
    const declared = declaredZipSize(entry);
    if (declared === null || declared > MAX_DOCUMENT_ARTIFACT_BYTES) {
      throw new Error('ooxml_entry_size_invalid');
    }
    declaredTotal += declared;
    if (declaredTotal > MAX_DOCUMENT_ARTIFACT_BYTES * 4) {
      throw new Error('ooxml_inflated_size_invalid');
    }
  }

  // Reading every entry is what makes JSZip verify each compressed stream and CRC.
  let actualTotal = 0;
  for (const name of names) {
    const entry = zip.files[name]!;
    if (entry.dir) continue;
    const content = await entry.async('uint8array');
    actualTotal += content.byteLength;
    if (actualTotal > MAX_DOCUMENT_ARTIFACT_BYTES * 4) {
      throw new Error('ooxml_inflated_size_invalid');
    }
  }

  const typeEntry = zip.file('[Content_Types].xml');
  const rootRelationships = zip.file('_rels/.rels');
  const expected = OOXML_MAIN_PART[format];
  const mainPart = zip.file(expected.path);
  if (!typeEntry || !rootRelationships || !mainPart) throw new Error('ooxml_required_part_missing');
  const contentTypes = await typeEntry.async('string');
  if (/<!DOCTYPE|<!ENTITY/i.test(contentTypes)) throw new Error('ooxml_content_types_unsafe');
  const normalizedPart = `/${expected.path}`;
  if (!contentTypes.includes(`PartName="${normalizedPart}"`) ||
      !contentTypes.includes(`ContentType="${expected.contentType}"`)) {
    throw new Error('ooxml_type_mismatch');
  }
  const relationships = await rootRelationships.async('string');
  if (/<!DOCTYPE|<!ENTITY/i.test(relationships) ||
      !relationships.includes('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"') ||
      !relationships.includes(`Target="${expected.path}"`)) {
    throw new Error('ooxml_relationship_mismatch');
  }
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChannels(colorType: number): number | null {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 3) return 1;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return null;
}

function validPngBitDepth(colorType: number, bitDepth: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  return [2, 4, 6].includes(colorType) && [8, 16].includes(bitDepth);
}

export interface ValidatedPng {
  buffer: Buffer;
  base64: string;
  sha256: string;
  width: number;
  height: number;
}

/** Strict base64 + PNG parser: chunk bounds/order/CRC, bounded dimensions and
 * successful non-interlaced raster inflation are all required. */
export function validatePngBase64(value: unknown): ValidatedPng | null {
  if (typeof value !== 'string') return null;
  const base64 = value.trim();
  if (!base64 || base64.length > MAX_PNG_BASE64_CHARS || base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.toString('base64') !== base64 || buffer.length < 45 ||
      !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let offset = 8;
  let chunkIndex = 0;
  let sawIhdr = false;
  let sawPlte = false;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const compressed: Buffer[] = [];
  let compressedBytes = 0;

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) return null;
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) return null;
    const typeBytes = buffer.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, data])) !== expectedCrc) return null;
    if (chunkIndex === 0 && type !== 'IHDR') return null;

    if (type === 'IHDR') {
      if (sawIhdr || length !== 13) return null;
      sawIhdr = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PNG_PIXELS ||
          !validPngBitDepth(colorType, bitDepth) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return null;
    } else if (type === 'PLTE') {
      if (!sawIhdr || sawPlte || sawIdat || length === 0 || length > 768 || length % 3 !== 0 ||
          colorType === 0 || colorType === 4 || (colorType === 3 && length / 3 > 2 ** bitDepth)) return null;
      sawPlte = true;
    } else if (type === 'IDAT') {
      if (!sawIhdr || endedIdat || sawIend || (colorType === 3 && !sawPlte)) return null;
      sawIdat = true;
      compressedBytes += data.length;
      if (compressedBytes > MAX_PNG_BASE64_CHARS) return null;
      compressed.push(data);
    } else if (type === 'IEND') {
      if (!sawIhdr || !sawIdat || sawIend || length !== 0) return null;
      sawIend = true;
      offset = end;
      if (offset !== buffer.length) return null;
      break;
    } else if (typeBytes[0]! >= 0x41 && typeBytes[0]! <= 0x5a) {
      // Unknown critical chunks cannot be decoded safely.
      return null;
    } else if (sawIdat) {
      endedIdat = true;
    }
    offset = end;
    chunkIndex += 1;
  }
  if (!sawIhdr || !sawIdat || !sawIend) return null;

  const channels = pngChannels(colorType);
  if (!channels) return null;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expectedInflated = height * (rowBytes + 1);
  if (expectedInflated <= 0 || expectedInflated > MAX_PNG_INFLATED_BYTES) return null;
  let raster: Buffer;
  try {
    raster = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedInflated + 1 });
  } catch {
    return null;
  }
  if (raster.length !== expectedInflated) return null;
  for (let row = 0; row < height; row += 1) {
    if (raster[row * (rowBytes + 1)]! > 4) return null;
  }
  return { buffer, base64, sha256: sha256Bytes(buffer), width, height };
}

export function readPersistedPng(
  metadata: unknown,
): (ValidatedPng & { integrityPolicy: 'persisted_hash_match' | 'validated_legacy_no_persisted_hash' }) | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const png = validatePngBase64(record.imageBase64);
  if (!png) return null;
  if (record.imageSha256 === undefined) {
    return { ...png, integrityPolicy: 'validated_legacy_no_persisted_hash' };
  }
  if (typeof record.imageSha256 !== 'string' || !SHA256_RE.test(record.imageSha256) ||
      record.imageSha256 !== png.sha256) return null;
  return { ...png, integrityPolicy: 'persisted_hash_match' };
}
