import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { PDFDocument } from 'pdf-lib';
import type { DocFormat } from './meri-docgen.helpers.js';

export const MAX_DOCUMENT_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_PNG_BASE64_CHARS = 3 * 1024 * 1024;
const MAX_PNG_PIXELS = 16_777_216;
const MAX_PNG_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_OOXML_INFLATED_BYTES = MAX_DOCUMENT_ARTIFACT_BYTES * 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA256_RE = /^[0-9a-f]{64}$/;
export const PERSISTED_PNG_BYTE_AUTHORITY = 'persisted_png_sha256_v1';

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const OOXML_MAIN_PART: Record<Exclude<DocFormat, 'pdf'>, {
  path: string;
  contentType: string;
  rootName: string;
  rootNamespace: string;
}> = {
  docx: {
    path: 'word/document.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    rootName: 'document',
    rootNamespace: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  },
  xlsx: {
    path: 'xl/workbook.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    rootName: 'workbook',
    rootNamespace: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  },
  pptx: {
    path: 'ppt/presentation.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    rootName: 'presentation',
    rootNamespace: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  },
};

const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOCUMENT_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

interface ZipEntry {
  name: string;
  content: Buffer;
}

function findZipEnd(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  throw new Error('ooxml_zip_end_missing');
}

/** Parse central-directory sizes first, then inflate each entry with a hard
 * output ceiling. CRC is checked only after bounded decompression succeeds. */
function readBoundedZipEntries(bytes: Buffer): Map<string, ZipEntry> {
  const endOffset = findZipEnd(bytes);
  if (bytes.readUInt16LE(endOffset + 4) !== 0 || bytes.readUInt16LE(endOffset + 6) !== 0) {
    throw new Error('ooxml_multidisk_unsupported');
  }
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (!entryCount || entryCount !== entriesOnDisk || entryCount > 5_000 ||
      centralOffset + centralSize !== endOffset) throw new Error('ooxml_entry_count_invalid');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const metadata: Array<{
    name: string; flags: number; method: number; crc: number;
    compressedSize: number; uncompressedSize: number; localOffset: number;
  }> = [];
  const names = new Set<string>();
  let declaredTotal = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('ooxml_central_directory_invalid');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || next > endOffset || flags & 1 ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ooxml_entry_header_invalid');
    }
    let name: string;
    try {
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
      if (!(flags & 0x0800) && nameBytes.some((byte) => byte > 0x7f)) {
        throw new Error('non_ascii_legacy_name');
      }
      name = decoder.decode(nameBytes);
    } catch {
      throw new Error('ooxml_entry_name_invalid');
    }
    if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') ||
        name.split('/').some((part) => part === '..') || names.has(name)) {
      throw new Error('ooxml_entry_name_invalid');
    }
    if (name.endsWith('/') && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new Error('ooxml_directory_entry_invalid');
    }
    names.add(name);
    if (!name.endsWith('/')) {
      if (uncompressedSize > MAX_DOCUMENT_ARTIFACT_BYTES) throw new Error('ooxml_entry_size_invalid');
      declaredTotal += uncompressedSize;
      if (declaredTotal > MAX_OOXML_INFLATED_BYTES) throw new Error('ooxml_inflated_size_invalid');
    }
    metadata.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    offset = next;
  }
  if (offset !== endOffset) throw new Error('ooxml_central_directory_invalid');

  const entries = new Map<string, ZipEntry>();
  let actualTotal = 0;
  for (const entry of metadata) {
    if (entry.localOffset + 30 > centralOffset || bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw new Error('ooxml_local_header_invalid');
    }
    const localFlags = bytes.readUInt16LE(entry.localOffset + 6);
    const localMethod = bytes.readUInt16LE(entry.localOffset + 8);
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (localFlags !== entry.flags || localMethod !== entry.method || dataEnd > centralOffset) {
      throw new Error('ooxml_local_header_invalid');
    }
    let localName: string;
    try {
      localName = decoder.decode(bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + localNameLength));
    } catch {
      throw new Error('ooxml_entry_name_invalid');
    }
    if (localName !== entry.name) throw new Error('ooxml_entry_name_invalid');
    if (entry.name.endsWith('/')) continue;
    const compressed = bytes.subarray(dataOffset, dataEnd);
    let content: Buffer;
    try {
      if (entry.method === 0) {
        if (entry.compressedSize !== entry.uncompressedSize) throw new Error('stored_size_mismatch');
        content = Buffer.from(compressed);
      } else if (entry.method === 8) {
        content = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
      } else {
        throw new Error('unsupported_compression');
      }
    } catch {
      throw new Error('ooxml_decompression_bound_exceeded');
    }
    if (content.length !== entry.uncompressedSize) throw new Error('ooxml_entry_size_mismatch');
    actualTotal += content.length;
    if (actualTotal > MAX_OOXML_INFLATED_BYTES) throw new Error('ooxml_inflated_size_invalid');
    if (crc32(content) !== entry.crc) throw new Error('ooxml_crc_invalid');
    entries.set(entry.name, { name: entry.name, content });
  }
  return entries;
}

type XmlNode = Record<string, unknown>;
const ooxmlXmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: false,
  processEntities: false,
});

function localName(name: string): string {
  const separator = name.indexOf(':');
  return separator < 0 ? name : name.slice(separator + 1);
}

function asXmlNode(value: unknown): XmlNode | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as XmlNode
    : null;
}

function parseXmlRoot(content: Buffer): { name: string; node: XmlNode } {
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error('ooxml_xml_encoding_invalid');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('ooxml_xml_invalid');
  }
  let parsed: unknown;
  try {
    parsed = ooxmlXmlParser.parse(xml);
  } catch {
    throw new Error('ooxml_xml_invalid');
  }
  const document = asXmlNode(parsed);
  const elements = document
    ? Object.entries(document).filter(([name]) => !name.startsWith('?') && !name.startsWith('#') && !name.startsWith('!'))
    : [];
  if (elements.length !== 1) throw new Error('ooxml_xml_root_invalid');
  const [name, value] = elements[0]!;
  const node = asXmlNode(value);
  if (!node) throw new Error('ooxml_xml_root_invalid');
  return { name, node };
}

function namespaceBindings(node: XmlNode): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const [name, value] of Object.entries(node)) {
    if (name === '@_xmlns' && typeof value === 'string') bindings.set('', value);
    else if (name.startsWith('@_xmlns:') && typeof value === 'string') bindings.set(name.slice(8), value);
  }
  return bindings;
}

function elementNamespace(name: string, bindings: Map<string, string>): string | null {
  const separator = name.indexOf(':');
  return bindings.get(separator < 0 ? '' : name.slice(0, separator)) ?? null;
}

function childElementNamespace(
  element: { name: string; node: XmlNode },
  inherited: Map<string, string>,
): string | null {
  const bindings = new Map(inherited);
  for (const [prefix, namespace] of namespaceBindings(element.node)) bindings.set(prefix, namespace);
  return elementNamespace(element.name, bindings);
}

function directElements(node: XmlNode, wantedLocalName: string): Array<{ name: string; node: XmlNode }> {
  const out: Array<{ name: string; node: XmlNode }> = [];
  for (const [name, value] of Object.entries(node)) {
    if (name.startsWith('@_') || name.startsWith('?') || name.startsWith('#') || name.startsWith('!') ||
        localName(name) !== wantedLocalName) continue;
    for (const candidate of Array.isArray(value) ? value : [value]) {
      const child = asXmlNode(candidate);
      if (child) out.push({ name, node: child });
    }
  }
  return out;
}

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

  const entries = readBoundedZipEntries(bytes);
  const typeEntry = entries.get('[Content_Types].xml');
  const rootRelationships = entries.get('_rels/.rels');
  const expected = OOXML_MAIN_PART[format];
  const mainPart = entries.get(expected.path);
  if (!typeEntry || !rootRelationships || !mainPart) throw new Error('ooxml_required_part_missing');

  const contentTypes = parseXmlRoot(typeEntry.content);
  const contentTypeBindings = namespaceBindings(contentTypes.node);
  if (localName(contentTypes.name) !== 'Types' ||
      elementNamespace(contentTypes.name, contentTypeBindings) !== CONTENT_TYPES_NAMESPACE ||
      !directElements(contentTypes.node, 'Override').some((element) =>
        childElementNamespace(element, contentTypeBindings) === CONTENT_TYPES_NAMESPACE &&
        element.node['@_PartName'] === `/${expected.path}` &&
        element.node['@_ContentType'] === expected.contentType)) {
    throw new Error('ooxml_type_mismatch');
  }

  const relationships = parseXmlRoot(rootRelationships.content);
  const relationshipBindings = namespaceBindings(relationships.node);
  if (localName(relationships.name) !== 'Relationships' ||
      elementNamespace(relationships.name, relationshipBindings) !== RELATIONSHIPS_NAMESPACE ||
      !directElements(relationships.node, 'Relationship').some((element) =>
        childElementNamespace(element, relationshipBindings) === RELATIONSHIPS_NAMESPACE &&
        element.node['@_Type'] === OFFICE_DOCUMENT_RELATIONSHIP &&
        element.node['@_Target'] === expected.path &&
        element.node['@_TargetMode'] === undefined)) {
    throw new Error('ooxml_relationship_mismatch');
  }

  const main = parseXmlRoot(mainPart.content);
  const mainBindings = namespaceBindings(main.node);
  if (localName(main.name) !== expected.rootName ||
      elementNamespace(main.name, mainBindings) !== expected.rootNamespace) {
    throw new Error('ooxml_main_root_mismatch');
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

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function pngUnfilteredRows(
  raster: Buffer,
  height: number,
  rowBytes: number,
  bytesPerPixel: number,
): Buffer[] | null {
  const rows: Buffer[] = [];
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const rowOffset = rowIndex * (rowBytes + 1);
    const filter = raster[rowOffset]!;
    if (filter > 4) return null;
    const encoded = raster.subarray(rowOffset + 1, rowOffset + 1 + rowBytes);
    const decoded = Buffer.allocUnsafe(rowBytes);
    const previous = rows[rowIndex - 1];
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= bytesPerPixel ? decoded[index - bytesPerPixel]! : 0;
      const above = previous?.[index] ?? 0;
      const upperLeft = index >= bytesPerPixel ? (previous?.[index - bytesPerPixel] ?? 0) : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2)
              : paethPredictor(left, above, upperLeft);
      decoded[index] = (encoded[index]! + predictor) & 0xff;
    }
    rows.push(decoded);
  }
  return rows;
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
  let paletteEntries = 0;
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
      paletteEntries = length / 3;
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
  const bytesPerPixel = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const rows = pngUnfilteredRows(raster, height, rowBytes, bytesPerPixel);
  if (!rows) return null;
  if (colorType === 3) {
    const mask = (1 << bitDepth) - 1;
    for (const row of rows) {
      for (let pixel = 0; pixel < width; pixel += 1) {
        const bitOffset = pixel * bitDepth;
        const shift = 8 - bitDepth - (bitOffset % 8);
        const paletteIndex = (row[Math.floor(bitOffset / 8)]! >> shift) & mask;
        if (paletteIndex >= paletteEntries) return null;
      }
    }
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
  if (record.imageByteAuthority !== undefined &&
      record.imageByteAuthority !== PERSISTED_PNG_BYTE_AUTHORITY) return null;
  if (record.imageSha256 === undefined) {
    if (record.imageByteAuthority === PERSISTED_PNG_BYTE_AUTHORITY) return null;
    return { ...png, integrityPolicy: 'validated_legacy_no_persisted_hash' };
  }
  if (typeof record.imageSha256 !== 'string' || !SHA256_RE.test(record.imageSha256) ||
      record.imageSha256 !== png.sha256) return null;
  return { ...png, integrityPolicy: 'persisted_hash_match' };
}
