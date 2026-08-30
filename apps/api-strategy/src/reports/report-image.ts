import { inflateSync } from "node:zlib";
import { decode as decodeJpeg } from "jpeg-js";
import type { ClientLogoAsset } from "./report.types.js";

export interface RasterSize {
  width: number;
  height: number;
}

const MAX_LOGO_SIDE = 4_096;
const MAX_LOGO_PIXELS = 1_000_000;
const MAX_LOGO_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_JPEG_MEMORY_MB = 64;
const MAX_JPEG_SEGMENTS = 512;
const MAX_PNG_CHUNKS = 2_048;
const PNG_RENDER_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "bKGD",
  "pHYs",
]);

export function readRasterSize(asset: ClientLogoAsset): RasterSize | null {
  return asset.contentType === "image/png"
    ? readPngSize(asset.bytes)
    : readJpegSize(asset.bytes);
}

/** Remove non-rendering metadata before bytes enter an OOXML package. */
export function sanitizeRasterAsset(
  asset: ClientLogoAsset,
): ClientLogoAsset | null {
  if (asset.contentType === "image/png") {
    const dimensions = readPngSize(asset.bytes);
    if (!dimensions) return null;
    const bytes = stripPngMetadata(asset.bytes);
    return bytes ? { ...asset, bytes, dimensions } : null;
  }

  // Strip once, then validate/decode the exact bytes that will enter OOXML.
  // This avoids retaining a second large edit list for adversarial JPEGs.
  const bytes = stripJpegMetadata(asset.bytes);
  if (!bytes) return null;
  const dimensions = readSanitizedJpegSize(bytes);
  return dimensions ? { ...asset, bytes, dimensions } : null;
}

export function containSize(
  source: RasterSize,
  maxWidth: number,
  maxHeight: number,
): RasterSize {
  const scale = Math.min(maxWidth / source.width, maxHeight / source.height, 1);
  return {
    width: Math.max(1, source.width * scale),
    height: Math.max(1, source.height * scale),
  };
}

export function containBox(
  source: RasterSize,
  box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(box.w / source.width, box.h / source.height);
  const w = source.width * scale;
  const h = source.height * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

function readPngSize(bytes: Buffer): RasterSize | null {
  if (
    bytes.length < 45 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  ) {
    return null;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawHeader = false;
  let sawPalette = false;
  let paletteEntries = 0;
  let sawTransparency = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;
  const safeAncillaryChunks = new Set<string>();
  const imageData: Buffer[] = [];
  let chunkCount = 0;

  while (offset + 12 <= bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS) return null;
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (dataEnd < dataStart || next > bytes.length) return null;
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2]!.toUpperCase()) {
      return null;
    }
    if (pngCrc32(bytes, offset + 4, dataEnd) !== bytes.readUInt32BE(dataEnd)) {
      return null;
    }
    if (!sawHeader && type !== "IHDR") return null;
    if (sawImageData && type !== "IDAT" && type !== "IEND") {
      imageDataEnded = true;
    }

    if (type === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) return null;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      if (
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        bytes[dataStart + 12] !== 0
      ) {
        return null;
      }
      sawHeader = true;
    } else if (type === "PLTE") {
      if (
        sawPalette ||
        sawImageData ||
        colorType === 0 ||
        colorType === 4 ||
        length < 3 ||
        length > 768 ||
        length % 3 !== 0
      ) {
        return null;
      }
      paletteEntries = length / 3;
      if (colorType === 3 && paletteEntries > 2 ** bitDepth) return null;
      sawPalette = true;
    } else if (type === "IDAT") {
      if (
        !sawHeader ||
        sawEnd ||
        imageDataEnded ||
        (colorType === 3 && !sawPalette)
      ) {
        return null;
      }
      sawImageData = true;
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "tRNS") {
      if (
        sawTransparency ||
        sawImageData ||
        (colorType === 0 && length !== 2) ||
        (colorType === 2 && length !== 6) ||
        (colorType === 3 && (!sawPalette || length > paletteEntries)) ||
        colorType === 4 ||
        colorType === 6
      ) {
        return null;
      }
      sawTransparency = true;
    } else if (
      ["cHRM", "gAMA", "sBIT", "sRGB", "bKGD", "pHYs"].includes(type)
    ) {
      if (
        safeAncillaryChunks.has(type) ||
        sawImageData ||
        !validSafePngAncillary(
          type,
          bytes,
          dataStart,
          length,
          colorType,
          sawPalette,
          paletteEntries,
        )
      ) {
        return null;
      }
      safeAncillaryChunks.add(type);
    } else if (type === "IEND") {
      if (!sawHeader || length !== 0 || next !== bytes.length) return null;
      sawEnd = true;
      offset = next;
      break;
    } else if (type.charCodeAt(0) >= 97 && type.charCodeAt(0) <= 122) {
      // Ancillary metadata is CRC-checked here, then removed by
      // sanitizeRasterAsset before the original bytes can enter OOXML.
    } else if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90) {
      // Unknown critical chunks require decoding behavior we do not implement.
      return null;
    }
    offset = next;
  }

  if (
    !sawHeader ||
    !sawEnd ||
    imageData.length === 0 ||
    (colorType === 3 && !sawPalette) ||
    !validSize(width, height)
  ) {
    return null;
  }
  const channels = pngChannels(colorType, bitDepth);
  if (!channels) return null;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expectedBytes = (rowBytes + 1) * height;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > MAX_LOGO_DECODED_BYTES
  ) {
    return null;
  }

  try {
    const decoded = inflateSync(Buffer.concat(imageData), {
      maxOutputLength: expectedBytes,
    });
    if (decoded.length !== expectedBytes) return null;
    for (let row = 0; row < height; row += 1) {
      if (decoded[row * (rowBytes + 1)]! > 4) return null;
    }
    if (
      colorType === 3 &&
      !validIndexedPngPixels(
        decoded,
        width,
        height,
        rowBytes,
        bitDepth,
        paletteEntries,
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { width, height };
}

function pngCrc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function stripPngMetadata(bytes: Buffer): Buffer | null {
  const parts: Buffer[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let chunkCount = 0;
  while (offset + 12 <= bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS) return null;
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > bytes.length) return null;
    if (PNG_RENDER_CHUNKS.has(type)) parts.push(bytes.subarray(offset, next));
    offset = next;
    if (type === "IEND")
      return offset === bytes.length ? Buffer.concat(parts) : null;
  }
  return null;
}

function validSafePngAncillary(
  type: string,
  bytes: Buffer,
  dataStart: number,
  length: number,
  colorType: number,
  sawPalette: boolean,
  paletteEntries: number,
): boolean {
  if (["cHRM", "gAMA", "sBIT", "sRGB"].includes(type) && sawPalette)
    return false;
  if (type === "cHRM") return length === 32;
  if (type === "gAMA") return length === 4;
  if (type === "sBIT") {
    const expected = (
      { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 } as Record<number, number>
    )[colorType];
    return length === expected;
  }
  if (type === "sRGB") return length === 1 && bytes[dataStart]! <= 3;
  if (type === "bKGD") {
    const expected = (
      { 0: 2, 2: 6, 3: 1, 4: 2, 6: 6 } as Record<number, number>
    )[colorType];
    return (
      length === expected &&
      (colorType !== 3 || (sawPalette && bytes[dataStart]! < paletteEntries))
    );
  }
  return type === "pHYs" && length === 9 && bytes[dataStart + 8]! <= 1;
}

function validIndexedPngPixels(
  decoded: Buffer,
  width: number,
  height: number,
  rowBytes: number,
  bitDepth: number,
  paletteEntries: number,
): boolean {
  const unfiltered = Buffer.allocUnsafe(rowBytes * height);
  const bytesPerPixel = 1;
  for (let row = 0; row < height; row += 1) {
    const filter = decoded[row * (rowBytes + 1)]!;
    const sourceOffset = row * (rowBytes + 1) + 1;
    const targetOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const left =
        column >= bytesPerPixel
          ? unfiltered[targetOffset + column - bytesPerPixel]!
          : 0;
      const above = row > 0 ? unfiltered[targetOffset - rowBytes + column]! : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? unfiltered[targetOffset - rowBytes + column - bytesPerPixel]!
          : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paethPredictor(left, above, upperLeft);
      unfiltered[targetOffset + column] =
        (decoded[sourceOffset + column]! + predictor) & 0xff;
    }
  }

  const mask = (1 << bitDepth) - 1;
  for (let row = 0; row < height; row += 1) {
    for (let pixel = 0; pixel < width; pixel += 1) {
      const bitOffset = pixel * bitDepth;
      const packed = unfiltered[row * rowBytes + Math.floor(bitOffset / 8)]!;
      const shift = 8 - bitDepth - (bitOffset % 8);
      if (((packed >> shift) & mask) >= paletteEntries) return false;
    }
  }
  return true;
}

function paethPredictor(
  left: number,
  above: number,
  upperLeft: number,
): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance)
    return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function readJpegSize(bytes: Buffer): RasterSize | null {
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

function readSanitizedJpegSize(bytes: Buffer): RasterSize | null {
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

function stripJpegMetadata(bytes: Buffer): Buffer | null {
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

function validSize(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_LOGO_SIDE &&
    height <= MAX_LOGO_SIDE &&
    width * height <= MAX_LOGO_PIXELS
  );
}

function pngChannels(colorType: number, bitDepth: number): number | null {
  const allowedDepths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (!allowedDepths[colorType]?.includes(bitDepth)) return null;
  return (
    ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType] ??
    null
  );
}
