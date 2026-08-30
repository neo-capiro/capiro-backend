import { describe, expect, it } from "@jest/globals";
import {
  containBox,
  containSize,
  readRasterSize,
  sanitizeRasterAsset,
} from "./report-image.js";

describe("report image sizing", () => {
  it("reads PNG intrinsic dimensions and contains without upscaling", () => {
    const png = removePngChunk(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURRI0Vv///1EAcnUAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggeERon835/3gAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=",
        "base64",
      ),
      "tIME",
    );
    expect(readRasterSize({ bytes: png, contentType: "image/png" })).toEqual({
      width: 1,
      height: 1,
    });
    expect(containSize({ width: 800, height: 200 }, 240, 90)).toEqual({
      width: 240,
      height: 60,
    });
  });

  it("rejects truncated and excessive-pixel PNGs before embedding", () => {
    const valid = removePngChunk(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURRI0Vv///1EAcnUAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggeERon835/3gAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=",
        "base64",
      ),
      "tIME",
    );
    expect(
      readRasterSize({
        bytes: valid.subarray(0, 24),
        contentType: "image/png",
      }),
    ).toBeNull();

    const excessive = Buffer.from(valid);
    excessive.writeUInt32BE(5_000, 16);
    excessive.writeUInt32BE(4_000, 20);
    expect(
      readRasterSize({ bytes: excessive, contentType: "image/png" }),
    ).toBeNull();

    const excessiveDecodedBytes = Buffer.from(valid);
    excessiveDecodedBytes.writeUInt32BE(4_000, 16);
    excessiveDecodedBytes.writeUInt32BE(4_000, 20);
    excessiveDecodedBytes[24] = 8;
    excessiveDecodedBytes[25] = 6;
    expect(
      readRasterSize({
        bytes: excessiveDecodedBytes,
        contentType: "image/png",
      }),
    ).toBeNull();

    expect(
      readRasterSize({
        bytes: removePngChunk(valid, "PLTE"),
        contentType: "image/png",
      }),
    ).toBeNull();

    const profiled = insertPngChunk(
      valid,
      "iCCP",
      Buffer.from("profile\0\0compressed-payload"),
    );
    const sanitized = sanitizeRasterAsset({
      bytes: profiled,
      contentType: "image/png",
    });
    expect(sanitized?.dimensions).toEqual({ width: 1, height: 1 });
    expect(sanitized?.bytes.includes(Buffer.from("iCCP"))).toBe(false);
    expect(sanitized?.bytes.length).toBeLessThan(profiled.length);
  });

  it("fully decodes JPEGs and rejects header-only impostors", () => {
    const jpeg = Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAAEAAQMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APiSvvT4o//Z",
      "base64",
    );
    expect(readRasterSize({ bytes: jpeg, contentType: "image/jpeg" })).toEqual({
      width: 1,
      height: 1,
    });

    const headerOnly = Buffer.from(
      "ffd8ffc0000b080001000101011100ffda0008010100003f00ffd9",
      "hex",
    );
    expect(
      readRasterSize({ bytes: headerOnly, contentType: "image/jpeg" }),
    ).toBeNull();

    const commented = insertJpegSegment(
      jpeg,
      0xfe,
      Buffer.from("internal note"),
    );
    const sanitized = sanitizeRasterAsset({
      bytes: commented,
      contentType: "image/jpeg",
    });
    expect(sanitized?.dimensions).toEqual({ width: 1, height: 1 });
    expect(sanitized?.bytes.includes(Buffer.from("internal note"))).toBe(false);
    expect(sanitized?.bytes.length).toBeLessThan(commented.length);
  });

  it("keeps one canonical Adobe transform marker for CMYK JPEGs", () => {
    const cmykJpeg = Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAAAAAAD/7gAOQWRvYmUAZAAAAAAC/9sAQwADAgICAgIDAgICAwMDAwQGBAQEBAQIBgYFBgkICgoJCAkJCgwPDAoLDgsJCQ0RDQ4PEBAREAoMEhMSEBMPEBAQ/9sAQwEDAwMEAwQIBAQIEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/8AAFAgACgAKBAERAAIRAQMRAQQRAP/EABYAAQEBAAAAAAAAAAAAAAAAAAAFB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAACP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAOBAEAAhEDEQQAAD8AlJKU6w8AAAB//9k=",
      "base64",
    );
    const duplicateWithFlags = insertJpegSegment(
      cmykJpeg,
      0xee,
      Buffer.from([
        0x41, 0x64, 0x6f, 0x62, 0x65, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0x02,
      ]),
    );

    const sanitized = sanitizeRasterAsset({
      bytes: duplicateWithFlags,
      contentType: "image/jpeg",
    });
    const canonicalMarker = Buffer.from([
      0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00,
      0x00, 0x00, 0x00, 0x02,
    ]);

    expect(sanitized?.dimensions).toEqual({ width: 10, height: 10 });
    expect(countOccurrences(sanitized!.bytes, Buffer.from("Adobe"))).toBe(1);
    expect(sanitized?.bytes.includes(canonicalMarker)).toBe(true);
    expect(
      sanitized?.bytes.includes(Buffer.from([0x12, 0x34, 0x56, 0x78])),
    ).toBe(false);
  });

  it("rejects a sub-2 MB JPEG metadata-segment flood", () => {
    const jpeg = Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAAEAAQMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APiSvvT4o//Z",
      "base64",
    );
    const flooded = prependEmptyJpegSegments(jpeg, 500_000);

    expect(flooded.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(
      sanitizeRasterAsset({ bytes: flooded, contentType: "image/jpeg" }),
    ).toBeNull();
  });

  it("centers an undistorted logo in a slide box", () => {
    expect(
      containBox({ width: 400, height: 100 }, { x: 2, y: 1, w: 4, h: 2 }),
    ).toEqual({
      x: 2,
      y: 1.5,
      w: 4,
      h: 1,
    });
  });
});

function removePngChunk(png: Buffer, target: string): Buffer {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (type === target) {
      return Buffer.concat([png.subarray(0, offset), png.subarray(next)]);
    }
    offset = next;
  }
  throw new Error(`PNG fixture does not contain ${target}`);
}

function insertPngChunk(png: Buffer, type: string, data: Buffer): Buffer {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") break;
    offset += 12 + length;
  }
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk, 4, 8 + data.length), 8 + data.length);
  return Buffer.concat([png.subarray(0, offset), chunk, png.subarray(offset)]);
}

function insertJpegSegment(jpeg: Buffer, marker: number, data: Buffer): Buffer {
  const segment = Buffer.alloc(4 + data.length);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(data.length + 2, 2);
  data.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function prependEmptyJpegSegments(jpeg: Buffer, count: number): Buffer {
  const segments = Buffer.allocUnsafe(count * 4);
  for (let offset = 0; offset < segments.length; offset += 4) {
    segments[offset] = 0xff;
    segments[offset + 1] = 0xe1;
    segments[offset + 2] = 0x00;
    segments[offset + 3] = 0x02;
  }
  return Buffer.concat([jpeg.subarray(0, 2), segments, jpeg.subarray(2)]);
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
