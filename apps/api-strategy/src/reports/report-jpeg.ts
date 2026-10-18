import { decode as decodeJpeg } from "jpeg-js";
import { validSize, type RasterSize } from "./report-raster-bounds.js";

const MAX_JPEG_MEMORY_MB = 64;
const MAX_JPEG_SEGMENTS = 512;

export function readJpegSize(bytes: Buffer): RasterSize | null {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return null;
  }
  const sanitized = stripJpegMetadata(bytes);
  if (!sanitized) return null;
  return readSanitizedJpegSize(sanitized);
}

export function readSanitizedJpegSize(bytes: Buffer): RasterSize | null {
  let offset = 2;
  let size: RasterSize | null = null;
  let sawScan = false;
  while (offset + 4 < bytes.length - 2) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length)
      return null;
    if (isStartOfFrame(marker) && segmentLength >= 7) {
      if (size) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      size = validSize(width, height) ? { width, height } : null;
      if (!size) return null;
    }
    if (marker === 0xda) {
      sawScan = true;
      break;
    }
    offset += 2 + segmentLength;
  }
  if (!sawScan || !size) return null;
  try {
    const decoded = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: 1,
      maxMemoryUsageInMB: MAX_JPEG_MEMORY_MB,
    });
    return decoded.width === size.width &&
      decoded.height === size.height &&
      decoded.data.length > 0
      ? size
      : null;
  } catch {
    return null;
  }
}

export function stripJpegMetadata(bytes: Buffer): Buffer | null {
  let offset = 2;
  let inScan = false;
  let retainedAdobeMarker = false;
  let segmentCount = 0;
  const edits: Array<readonly [number, number, Buffer]> = [];
  while (offset < bytes.length) {
    if (inScan) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset + 1 < bytes.length && bytes[offset + 1] === 0xff)
        offset += 1;
      if (offset + 1 >= bytes.length) return null;
      const marker = bytes[offset + 1]!;
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      inScan = false;
    }

    if (bytes[offset] !== 0xff) return null;
    while (offset + 1 < bytes.length && bytes[offset + 1] === 0xff) offset += 1;
    if (offset + 1 >= bytes.length) return null;
    const marker = bytes[offset + 1]!;
    segmentCount += 1;
    if (segmentCount > MAX_JPEG_SEGMENTS) return null;
    if (marker === 0xd9) {
      if (offset + 2 !== bytes.length) return null;
      const parts: Buffer[] = [];
      let retainedFrom = 0;
      for (const [start, end, replacement] of edits) {
        parts.push(bytes.subarray(retainedFrom, start));
        parts.push(replacement);
        retainedFrom = end;
      }
      parts.push(bytes.subarray(retainedFrom));
      return Buffer.concat(parts);
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset + 2);
    const next = offset + 2 + segmentLength;
    if (segmentLength < 2 || next > bytes.length) return null;
    if (marker === 0xfe) {
      edits.push([offset, next, Buffer.alloc(0)]);
    } else if (marker >= 0xe0 && marker <= 0xef) {
      const adobeTransform =
        marker === 0xee
          ? readAdobeJpegTransform(bytes, offset, segmentLength)
          : null;
      if (adobeTransform !== null && !retainedAdobeMarker) {
        edits.push([offset, next, canonicalAdobeJpegSegment(adobeTransform)]);
        retainedAdobeMarker = true;
      } else {
        edits.push([offset, next, Buffer.alloc(0)]);
      }
    }
    if (marker === 0xda) inScan = true;
    offset = next;
  }
  return null;
}

function readAdobeJpegTransform(
  bytes: Buffer,
  offset: number,
  segmentLength: number,
): number | null {
  if (
    segmentLength === 14 &&
    bytes.toString("ascii", offset + 4, offset + 9) === "Adobe" &&
    bytes[offset + 15]! <= 2
  ) {
    return bytes[offset + 15]!;
  }
  return null;
}

function canonicalAdobeJpegSegment(transform: number): Buffer {
  return Buffer.from([
    0xff,
    0xee,
    0x00,
    0x0e,
    0x41,
    0x64,
    0x6f,
    0x62,
    0x65,
    0x00,
    0x64,
    0x00,
    0x00,
    0x00,
    0x00,
    transform,
  ]);
}

function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
  );
}
