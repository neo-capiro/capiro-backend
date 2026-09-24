import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { decode as decodeJpeg } from 'jpeg-js';
import sanitizeHtml from 'sanitize-html';
import type { TenantContext } from '@capiro/shared';
import { CLIENT_SLOT_LIMIT_CODE, effectiveClientSlots } from '@capiro/shared';
import type { Client, Prisma } from '@prisma/client';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EntityResolutionService } from '../intelligence/entity-resolution.service.js';
import { ClientPrepopulationService } from '../intelligence/client-prepopulation.service.js';
import { SamEntityEnrichmentService } from '../intelligence/sam-entity.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { validateClientFundingProfile } from './client-funding-profile.validation.js';

export interface CreateClientInput {
  name: string;
  website?: string;
  description?: string;
  productDescription?: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  intakeData?: Record<string, unknown>;
  profileType?: string;
  sectorTag?: string;
  submissionTracks?: string[];
  issueCodes?: string[];
  profileStatus?: string;
  // Step 2.3 — government identifiers + code arrays for procurement matching.
  // Accepted on BOTH create and update (the Add Client form sends them on create).
  uei?: string;
  cageCode?: string;
  naicsCodes?: string[];
  pscCodes?: string[];
  setAsideCertifications?: string[];
  /** Grants.gov organization labels used by grant eligibility and relevance. */
  applicantTypes?: string[];
  // Pre-confirmed LDA client ids (e.g. Meri's create_client after the user
  // confirmed the registry entity). Seeded directly so LDA-filing reads and
  // duplicate guards work immediately — the async resolve/prepopulate cascade
  // still runs and merges additional ids, but must not be the only carrier of
  // an identity the user explicitly confirmed.
  ldaClientIds?: number[];
  // Business Development Phase 1: confirmed canonical identity stamped at
  // conversion-time client creation (see ClientsService.createInTransaction).
  // Never set by the ordinary Add Client flow.
  canonicalEntityId?: string;
}

export type UpdateClientInput = Partial<CreateClientInput> & {
  status?: string;
};

export interface ListClientsFilter {
  profileStatus?: string;
  sectorTag?: string;
  /**
   * Include soft-archived ("deleted") clients. Defaults to false so archived
   * clients disappear from every operational surface (dashboards, pickers,
   * intelligence). Management views that need to see them pass true.
   */
  includeArchived?: boolean;
}

const ALLOWED_LOGO_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/webp',
]);
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_LOGO_SIDE = 4_096;
const MAX_LOGO_PIXELS = 1_000_000;
const MAX_LOGO_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_JPEG_MEMORY_MB = 64;
const MAX_JPEG_SEGMENTS = 512;
const MAX_PNG_CHUNKS = 2_048;
const MAX_IN_PROCESS_LOGO_VALIDATIONS = 4;
const MAX_LOGO_POINTER_SWAP_ATTEMPTS = 5;
const PNG_RENDER_CHUNKS = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'cHRM',
  'gAMA',
  'sBIT',
  'sRGB',
  'bKGD',
  'pHYs',
]);
const CLIENT_LOGO_UPLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clientLogoExtension(contentType: string): string {
  if (contentType === 'image/svg+xml') return 'svg';
  return contentType.split('/')[1] ?? 'png';
}

function clientLogoUploadKey(
  tenantId: string,
  clientId: string,
  contentType: string,
): string {
  const extension = clientLogoExtension(contentType);
  return `tenants/client-logo-uploads/${tenantId}/${clientId}/${randomUUID()}.${extension}`;
}

function clientLogoUploadId(
  s3Key: string,
  tenantId: string,
  clientId: string,
  contentType: string,
): string | null {
  const extension = clientLogoExtension(contentType);
  const prefix = `tenants/client-logo-uploads/${tenantId}/${clientId}/`;
  if (!s3Key.startsWith(prefix) || !s3Key.endsWith(`.${extension}`))
    return null;
  const uploadId = s3Key.slice(prefix.length, -(extension.length + 1));
  return CLIENT_LOGO_UPLOAD_ID.test(uploadId) ? uploadId : null;
}

function clientLogoKey(
  tenantId: string,
  clientId: string,
  contentType: string,
): string {
  const extension = clientLogoExtension(contentType);
  return `tenants/${tenantId}/clients/${clientId}/logos/${randomUUID()}.${extension}`;
}

/**
 * Exact key shape `clientLogoKey()` above produces: uuid tenant/client path
 * segments, a fresh v4 upload id, and the literal extension
 * `clientLogoExtension()` maps each allowed content type to (note
 * `image/jpeg` maps to `jpeg`, never the three-letter `jpg` — this pattern
 * intentionally does not accept it). Exported so the client-logo garbage
 * collector (scripts/gc-client-logos.ts) can recognize a confirmed logo
 * object without re-deriving this shape and risking drift from this writer.
 */
export const CONFIRMED_CLIENT_LOGO_KEY_PATTERN =
  /^tenants\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/clients\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/logos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpeg|svg|webp)$/i;

function isStoredClientLogoKey(
  s3Key: string,
  tenantId: string,
  clientId: string,
): boolean {
  const prefix = `tenants/${tenantId}/clients/${clientId}/`;
  if (!s3Key.startsWith(prefix)) return false;
  const tail = s3Key.slice(prefix.length);
  return /^(?:logo\.(?:png|jpe?g|svg|webp)|logos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|svg|webp))$/i.test(
    tail,
  );
}

function isInterlacedPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 29 &&
    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes[28] === 1
  );
}

function sanitizeClientLogoBytes(
  bytes: Buffer,
  contentType: string,
): Buffer | null {
  if (contentType === 'image/png') {
    return validPngLogo(bytes) ? stripPngMetadata(bytes) : null;
  }
  if (contentType === 'image/jpeg') return sanitizeJpegLogo(bytes);
  if (contentType === 'image/webp') return sanitizeWebpLogo(bytes);
  if (contentType === 'image/svg+xml') return sanitizeSvgLogo(bytes);
  return null;
}

// SVG logos are untrusted, potentially attacker-authored markup that gets
// served back verbatim via <img src>. sanitize-html is already this
// codebase's trust boundary for untrusted markup (see sanitize-signature.ts,
// outreach-email-renderer.ts); here its real XML parser is used to detect
// (see sanitizeSvgLogo below) anything outside the allowlist, including
// <script> and <foreignObject> (a common SVG-to-HTML/script smuggling
// vector) - the whole file is then rejected rather than silently stripped.
// xmlMode plus disabled case-lowering keep SVG's case-sensitive names
// (viewBox, clipPath, ...) intact.
const SVG_ALLOWED_TAGS = [
  'svg',
  'g',
  'defs',
  'symbol',
  'title',
  'desc',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'clipPath',
  'mask',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
  'use',
];
const SVG_PRESENTATION_ATTRS = [
  'fill',
  'stroke',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'fill-rule',
  'clip-rule',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'transform',
  'clip-path',
  'mask',
];
const SVG_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: SVG_ALLOWED_TAGS,
  allowedAttributes: {
    '*': ['id', 'class', ...SVG_PRESENTATION_ATTRS],
    svg: [
      'xmlns',
      'xmlns:xlink',
      'viewBox',
      'width',
      'height',
      'preserveAspectRatio',
      'version',
    ],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
    circle: ['cx', 'cy', 'r'],
    ellipse: ['cx', 'cy', 'rx', 'ry'],
    line: ['x1', 'y1', 'x2', 'y2'],
    polyline: ['points'],
    polygon: ['points'],
    path: ['d'],
    text: [
      'x',
      'y',
      'dx',
      'dy',
      'font-family',
      'font-size',
      'font-weight',
      'font-style',
      'text-anchor',
    ],
    tspan: ['x', 'y', 'dx', 'dy'],
    clipPath: ['clipPathUnits'],
    mask: ['maskUnits', 'maskContentUnits', 'x', 'y', 'width', 'height'],
    pattern: [
      'patternUnits',
      'patternContentUnits',
      'patternTransform',
      'x',
      'y',
      'width',
      'height',
      'viewBox',
    ],
    linearGradient: [
      'x1',
      'y1',
      'x2',
      'y2',
      'gradientUnits',
      'gradientTransform',
      'spreadMethod',
    ],
    radialGradient: [
      'cx',
      'cy',
      'r',
      'fx',
      'fy',
      'gradientUnits',
      'gradientTransform',
      'spreadMethod',
    ],
    stop: ['offset', 'stop-color', 'stop-opacity'],
    use: ['href', 'xlink:href', 'x', 'y', 'width', 'height'],
    symbol: ['viewBox', 'preserveAspectRatio'],
  },
  // No scheme is allowlisted, so any href/xlink:href carrying an absolute or
  // javascript: URL is dropped; a same-document `#fragment` reference always
  // survives regardless of this list (verified empirically against
  // sanitize-html - it treats scheme-less references as inherently safe).
  allowedSchemes: [],
  allowedSchemesByTag: {},
  parser: {
    lowerCaseTags: false,
    lowerCaseAttributeNames: false,
    xmlMode: true,
    decodeEntities: true,
  },
};
// Presentation attributes (fill/stroke/clip-path/mask) are NOT covered by
// sanitize-html's scheme allowlist, so `fill="url(https://evil/track.svg#g)"`
// survives it unchanged (verified empirically) and would make the SVG fetch
// a remote resource the moment it is rendered. Only a same-document fragment
// reference is allowed; anything else fails the whole file closed.
const SVG_EXTERNAL_URL_REF = /url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/i;
// sanitize-html always strips event-handler attributes (on*) and any
// attribute value it does not allowlist BEFORE transformTags ever runs
// (verified empirically), so a disallowed attribute is invisible to the
// tag-name check below - there is nothing post-parse to reject on. Reject on
// raw presence instead of silently dropping it, matching how a script tag or
// unknown element is rejected rather than quietly stripped.
const SVG_EVENT_HANDLER_ATTR = /\son[a-z]+\s*=/i;

/**
 * A logo SVG is untrusted markup rendered back verbatim via <img src>. Unlike
 * the PNG/JPEG paths (which strip inert-but-unneeded metadata and keep the
 * rest), anything outside the presentational allowlist here is inherently
 * unsafe rather than merely superfluous, so the whole file is rejected the
 * moment a disallowed construct is found - never silently stripped and
 * stored.
 */
function sanitizeSvgLogo(bytes: Buffer): Buffer | null {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (!/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text.trimStart())) {
    return null;
  }
  // A DOCTYPE/ENTITY declaration is never needed by an authored logo and is
  // the classic XXE / entity-expansion vector; reject outright rather than
  // rely on the parser never resolving it.
  if (
    /<!doctype\b/i.test(text) ||
    /<!entity\b/i.test(text) ||
    /<\?xml-stylesheet\b/i.test(text) ||
    SVG_EVENT_HANDLER_ATTR.test(text) ||
    /javascript:/i.test(text)
  ) {
    return null;
  }

  let sawDisallowedTag = false;
  const sanitized = sanitizeHtml(text, {
    ...SVG_SANITIZE_OPTIONS,
    transformTags: {
      // The wildcard transform fires for every tag the parser encounters,
      // including ones outside allowedTags (verified empirically against
      // sanitize-html) - this is what actually enforces "reject `<script>`
      // and `<foreignObject>` instead of silently dropping them".
      '*': (tagName, attribs) => {
        if (!SVG_ALLOWED_TAGS.includes(tagName)) sawDisallowedTag = true;
        return { tagName, attribs };
      },
    },
  }).trim();
  if (sawDisallowedTag) return null;
  if (!/^<svg(?:\s|>)/.test(sanitized) || !sanitized.endsWith('</svg>')) {
    return null;
  }
  if (SVG_EXTERNAL_URL_REF.test(sanitized)) return null;
  return Buffer.from(sanitized, 'utf8');
}

// WEBP dimensions live in the VP8/VP8L/VP8X chunk headers themselves - unlike
// a generic compressed-size lie, a WEBP's decoded pixel count is a direct
// function of these header fields, so bounding them here closes the same
// decompression-bomb class the JPEG path closes via jpeg-js's
// maxResolutionInMP/maxMemoryUsageInMB. (No pure-JS WEBP pixel decoder is a
// dependency of this service, so - unlike JPEG - a corrupt-but-small-declared
// bitstream cannot additionally be caught by a real decode; see PR notes.)
const WEBP_MAX_CHUNKS = 64;

function sanitizeWebpLogo(bytes: Buffer): Buffer | null {
  if (
    bytes.length < 20 ||
    bytes.length > MAX_LOGO_BYTES ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null;

  let offset = 12;
  let chunkCount = 0;
  let width = 0;
  let height = 0;
  let sawVp8x = false;
  let sawImageChunk = false;
  const parts: Buffer[] = [];

  while (offset + 8 <= bytes.length) {
    chunkCount += 1;
    if (chunkCount > WEBP_MAX_CHUNKS) return null;
    const fourCc = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const padded = dataEnd + (size % 2);
    if (dataEnd < dataStart || padded > bytes.length) return null;

    if (fourCc === 'ANIM' || fourCc === 'ANMF') return null;

    if (fourCc === 'VP8X') {
      if (sawVp8x || sawImageChunk || size !== 10) return null;
      const flags = bytes[dataStart]!;
      if (flags & 0x83) return null; // reserved bits must be zero
      if (flags & 0x04) return null; // animation flag set
      width =
        (bytes[dataStart + 4]! |
          (bytes[dataStart + 5]! << 8) |
          (bytes[dataStart + 6]! << 16)) +
        1;
      height =
        (bytes[dataStart + 7]! |
          (bytes[dataStart + 8]! << 8) |
          (bytes[dataStart + 9]! << 16)) +
        1;
      sawVp8x = true;
      const chunk = Buffer.from(bytes.subarray(offset, padded));
      // Clear the ICC/EXIF/XMP presence bits: those chunks are stripped
      // below, and a VP8X announcing metadata it no longer carries can
      // confuse strict consumers.
      chunk[8] = chunk[8]! & ~0x58;
      parts.push(chunk);
    } else if (fourCc === 'VP8 ') {
      if (
        sawImageChunk ||
        size < 10 ||
        (bytes[dataStart]! & 0x1) !== 0 || // must be a keyframe
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        return null;
      }
      const w = (bytes[dataStart + 6]! | (bytes[dataStart + 7]! << 8)) & 0x3fff;
      const h = (bytes[dataStart + 8]! | (bytes[dataStart + 9]! << 8)) & 0x3fff;
      if (sawVp8x) {
        if (w !== width || h !== height) return null;
      } else {
        width = w;
        height = h;
      }
      sawImageChunk = true;
      parts.push(Buffer.from(bytes.subarray(offset, padded)));
    } else if (fourCc === 'VP8L') {
      if (sawImageChunk || size < 5 || bytes[dataStart] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(dataStart + 1);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >> 14) & 0x3fff) + 1;
      const version = (bits >>> 29) & 0x7;
      if (version !== 0) return null;
      if (sawVp8x) {
        if (w !== width || h !== height) return null;
      } else {
        width = w;
        height = h;
      }
      sawImageChunk = true;
      parts.push(Buffer.from(bytes.subarray(offset, padded)));
    } else if (fourCc === 'ALPH') {
      if (!sawVp8x || sawImageChunk) return null;
      parts.push(Buffer.from(bytes.subarray(offset, padded)));
    } else if (fourCc === 'ICCP' || fourCc === 'EXIF' || fourCc === 'XMP ') {
      // Metadata: bounds-checked above, intentionally dropped from output.
    } else {
      return null;
    }
    offset = padded;
  }

  if (!sawImageChunk || offset !== bytes.length) return null;
  if (!validLogoDimensions(width, height)) return null;

  const body = Buffer.concat(parts);
  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0, 4, 'ascii');
  out.writeUInt32LE(4 + body.length, 4);
  out.write('WEBP', 8, 4, 'ascii');
  body.copy(out, 12);
  return out;
}

function validPngLogo(bytes: Buffer): boolean {
  if (
    bytes.length < 45 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  ) {
    return false;
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
    if (chunkCount > MAX_PNG_CHUNKS) return false;
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (dataEnd < dataStart || next > bytes.length) return false;
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2]!.toUpperCase()) {
      return false;
    }
    if (pngCrc32(bytes, offset + 4, dataEnd) !== bytes.readUInt32BE(dataEnd)) {
      return false;
    }
    if (!sawHeader && type !== 'IHDR') return false;
    if (sawImageData && type !== 'IDAT' && type !== 'IEND') {
      imageDataEnded = true;
    }
    if (type === 'IHDR') {
      if (sawHeader || offset !== 8 || length !== 13) return false;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      if (
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        bytes[dataStart + 12] !== 0
      ) {
        return false;
      }
      sawHeader = true;
    } else if (type === 'PLTE') {
      if (
        sawPalette ||
        sawImageData ||
        colorType === 0 ||
        colorType === 4 ||
        length < 3 ||
        length > 768 ||
        length % 3 !== 0
      ) {
        return false;
      }
      paletteEntries = length / 3;
      if (colorType === 3 && paletteEntries > 2 ** bitDepth) return false;
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (
        !sawHeader ||
        sawEnd ||
        imageDataEnded ||
        (colorType === 3 && !sawPalette)
      ) {
        return false;
      }
      sawImageData = true;
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'tRNS') {
      if (
        sawTransparency ||
        sawImageData ||
        (colorType === 0 && length !== 2) ||
        (colorType === 2 && length !== 6) ||
        (colorType === 3 && (!sawPalette || length > paletteEntries)) ||
        colorType === 4 ||
        colorType === 6
      ) {
        return false;
      }
      sawTransparency = true;
    } else if (
      ['cHRM', 'gAMA', 'sBIT', 'sRGB', 'bKGD', 'pHYs'].includes(type)
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
        return false;
      }
      safeAncillaryChunks.add(type);
    } else if (type === 'IEND') {
      if (!sawHeader || length !== 0 || next !== bytes.length) return false;
      sawEnd = true;
      break;
    } else if (type.charCodeAt(0) >= 97 && type.charCodeAt(0) <= 122) {
      // CRC-check ancillary metadata here; it is removed before persistence.
    } else if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90) {
      return false;
    }
    offset = next;
  }

  if (
    !sawHeader ||
    !sawEnd ||
    imageData.length === 0 ||
    (colorType === 3 && !sawPalette) ||
    !validLogoDimensions(width, height)
  ) {
    return false;
  }
  const channels = pngChannels(colorType, bitDepth);
  if (!channels) return false;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expectedBytes = (rowBytes + 1) * height;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > MAX_LOGO_DECODED_BYTES
  ) {
    return false;
  }
  try {
    const decoded = inflateSync(Buffer.concat(imageData), {
      maxOutputLength: expectedBytes,
    });
    if (decoded.length !== expectedBytes) return false;
    for (let row = 0; row < height; row += 1) {
      if (decoded[row * (rowBytes + 1)]! > 4) return false;
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
      return false;
    }
    return true;
  } catch {
    return false;
  }
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
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > bytes.length) return null;
    if (PNG_RENDER_CHUNKS.has(type)) parts.push(bytes.subarray(offset, next));
    offset = next;
    if (type === 'IEND')
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
  if (['cHRM', 'gAMA', 'sBIT', 'sRGB'].includes(type) && sawPalette)
    return false;
  if (type === 'cHRM') return length === 32;
  if (type === 'gAMA') return length === 4;
  if (type === 'sBIT') {
    const expected = (
      { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 } as Record<number, number>
    )[colorType];
    return length === expected;
  }
  if (type === 'sRGB') return length === 1 && bytes[dataStart]! <= 3;
  if (type === 'bKGD') {
    const expected = (
      { 0: 2, 2: 6, 3: 1, 4: 2, 6: 6 } as Record<number, number>
    )[colorType];
    return (
      length === expected &&
      (colorType !== 3 || (sawPalette && bytes[dataStart]! < paletteEntries))
    );
  }
  return type === 'pHYs' && length === 9 && bytes[dataStart + 8]! <= 1;
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
  for (let row = 0; row < height; row += 1) {
    const filter = decoded[row * (rowBytes + 1)]!;
    const sourceOffset = row * (rowBytes + 1) + 1;
    const targetOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const left = column >= 1 ? unfiltered[targetOffset + column - 1]! : 0;
      const above = row > 0 ? unfiltered[targetOffset - rowBytes + column]! : 0;
      const upperLeft =
        row > 0 && column >= 1
          ? unfiltered[targetOffset - rowBytes + column - 1]!
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

function sanitizeJpegLogo(bytes: Buffer): Buffer | null {
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
  bytes = sanitized;
  let offset = 2;
  let declaredWidth = 0;
  let declaredHeight = 0;
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
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (declaredWidth || declaredHeight) return null;
      declaredWidth = bytes.readUInt16BE(offset + 7);
      declaredHeight = bytes.readUInt16BE(offset + 5);
      if (!validLogoDimensions(declaredWidth, declaredHeight)) return null;
    }
    if (marker === 0xda) {
      sawScan = true;
      break;
    }
    offset += 2 + segmentLength;
  }
  if (!declaredWidth || !declaredHeight || !sawScan) return null;
  try {
    const decoded = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: 1,
      maxMemoryUsageInMB: MAX_JPEG_MEMORY_MB,
    });
    return decoded.width === declaredWidth &&
      decoded.height === declaredHeight &&
      decoded.data.length > 0
      ? sanitized
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
    bytes.toString('ascii', offset + 4, offset + 9) === 'Adobe' &&
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

function validLogoDimensions(width: number, height: number): boolean {
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

/**
 * The lobbying firm's book of business. Tenant-scoped via RLS - the database
 * itself enforces isolation, the service just wires `withTenant` so the GUC
 * is set on every query.
 */
@Injectable()
export class ClientsService {
  private readonly s3: S3Client;
  private readonly bucket?: string;
  private readonly logger = new Logger(ClientsService.name);
  private logoValidationTail: Promise<void> = Promise.resolve();
  private pendingLogoValidations = 0;
  // Billing is DORMANT until BILLING_ENFORCED=true (onboarding v1: Stripe
  // itself moved to onboard-api, so the old implicit STRIPE_SECRET_KEY signal
  // no longer exists in this service). While false we never enforce the
  // client-slot cap; flipped at billing activation after comp-existing-tenants.
  private readonly billingEnforced: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
    private readonly entityResolution: EntityResolutionService,
    private readonly prepopulation: ClientPrepopulationService,
    private readonly samEntity: SamEntityEnrichmentService,
    private readonly clientKb: ClientKbService,
  ) {
    this.bucket = config.get('ASSETS_BUCKET', { infer: true });
    this.s3 = new S3Client({
      region: config.get('AWS_REGION_DEFAULT', { infer: true }),
    });
    this.billingEnforced = config.get('BILLING_ENFORCED', { infer: true });
  }

  /** Bound logo downloads and serialize their memory-heavy raster validation. */
  private async acquireLogoValidation(): Promise<() => void> {
    if (this.pendingLogoValidations >= MAX_IN_PROCESS_LOGO_VALIDATIONS) {
      throw new HttpException(
        'Logo validation is busy. Please retry in a moment.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.pendingLogoValidations += 1;
    const previous = this.logoValidationTail;
    let release!: () => void;
    this.logoValidationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingLogoValidations -= 1;
      release();
    };
  }

  /** Resolve an ambiguous conditional PUT without creating a second object. */
  private async logoObjectMatches(
    key: string,
    expected: Buffer,
    contentType: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const object = await this.s3
        .send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
        .catch(() => null);
      if (!object) continue;
      if (
        object.ContentType !== contentType ||
        object.ContentLength !== expected.length ||
        !object.Body
      ) {
        return false;
      }
      try {
        const actual = Buffer.from(await object.Body.transformToByteArray());
        return (
          actual.length === expected.length && timingSafeEqual(actual, expected)
        );
      } catch {
        // Retry a transient read failure; S3 provides strong read-after-write.
      }
    }
    return false;
  }

  async list(ctx: TenantContext, filter: ListClientsFilter = {}) {
    // Tenant isolation is enforced IN-QUERY, not by RLS. The runtime API role
    // (capiro_app) is a member of the table-owner role (capiro_master) and so
    // bypasses row-level security on every table — withTenant sets the GUC but
    // the FORCE RLS policy never runs for this connection. Without this explicit
    // tenantId filter, findMany returns EVERY tenant's clients (confirmed leak).
    const where: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (filter.profileStatus) where.profileStatus = filter.profileStatus;
    if (filter.sectorTag) where.sectorTag = filter.sectorTag;
    // Soft-archived ("deleted") clients are hidden by default everywhere; only
    // explicit management views opt in via includeArchived.
    if (!filter.includeArchived) where.status = { not: 'archived' };

    const clients = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({ where, orderBy: { createdAt: 'desc' } }),
    );
    return this.withLogoUrls(clients);
  }

  async get(ctx: TenantContext, id: string) {
    // findFirst with an explicit tenantId (not findUnique by id alone): the app
    // role bypasses RLS, so a bare id lookup would let any tenant fetch any
    // other tenant's client by guessing/enumerating ids.
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
    if (!client) throw new NotFoundException('Client not found');
    return this.withLogoUrl(client);
  }

  async create(ctx: TenantContext, input: CreateClientInput) {
    const { client, ldaRegistrantId } = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      this.createInTransaction(ctx, tx, input),
    );

    // Resolve-on-create: registrant-anchored entity resolution, fire-and-forget.
    // resolveClient persists client_intel_mapping under its own withTenant(tenantId)
    // scope (the table is RLS-protected), so it runs safely detached and never
    // blocks or fails the create response.
    void this.entityResolution
      .resolveClient(client.id, ctx.tenantId, client.name, {
        ldaRegistrantId,
        clientUei: client.uei,
      })
      // After resolution (which may auto-confirm an LDA id), run the prepopulation
      // cascade to sync lda_client_ids + merge issue codes / signals.
      .then(() => this.prepopulation.prepopulate(ctx.tenantId, client.id))
      .catch((e: unknown) =>
        this.logger.warn(
          `resolve-on-create failed for client ${client.id}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );

    // SAM gov-id enrichment (UEI/CAGE/NAICS) is independent of LDA resolution and
    // network-bound, so it runs as its own detached fire-and-forget. Fill-if-empty,
    // never blocks or fails the create response. Skips silently when SAM has no
    // confident single match or the key is unset.
    void this.samEntity
      .enrichGovIds(ctx.tenantId, client.id)
      .catch((e: unknown) =>
        this.logger.warn(
          `gov-id enrichment failed for client ${client.id}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );

    return this.withLogoUrl(client);
  }

  /**
   * Transaction-aware core of {@link create}. Runs the ENTIRE authoritative
   * client-creation rule set — funding-profile validation, billing slot
   * entitlement check, and the insert — inside a caller-supplied Prisma
   * transactional client, so
   * Business Development prospect conversion can compose client creation
   * into its OWN single transaction (client + prospect link commit or roll
   * back together) without duplicating a weaker insert. A slot is consumed
   * ONLY when this actually creates a client row. The public create()
   * behavior is unchanged: same checks, same errors, same insert.
   */
  async createInTransaction(
    ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
    tx: Prisma.TransactionClient,
    input: CreateClientInput,
  ): Promise<{ client: Client; ldaRegistrantId: number | null }> {
    // Funding-profile validation lives HERE so the transaction core is
    // authoritative for every caller (create, bizdev conversion, any future
    // composer) — a caller can no longer bypass it. create() behavior is
    // unchanged: the same validated fields reach the same insert.
    const validated = { ...input, ...validateClientFundingProfile(input) };

    // Billing slot enforcement: a client may not be created beyond the
    // purchased client_slots. 'comped' tenants (Capiro staff / promo) bypass.
    // Runs inside the transaction so the check + insert are atomic. Throws 402
    // with a structured CLIENT_SLOT_LIMIT code the UI turns into an upgrade CTA.
    const tenant = await tx.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: {
        ldaRegistrantId: true,
        clientSlots: true,
        billingStatus: true,
      },
    });
    if (this.billingEnforced && tenant && tenant.billingStatus !== 'comped') {
      // Trials get at least the 10-profile allowance regardless of the
      // stamped clientSlots (shared with the LDA import + setup dashboard).
      const slotLimit = effectiveClientSlots(tenant.billingStatus, tenant.clientSlots);
      const current = await tx.client.count({
        where: { tenantId: ctx.tenantId, status: { not: 'archived' } },
      });
      if (current >= slotLimit) {
        throw new HttpException(
          {
            code: CLIENT_SLOT_LIMIT_CODE,
            message: `You've used all ${slotLimit} client slots on your plan. Add more slots to create another client.`,
            limit: slotLimit,
            current,
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
    }
    const client = await tx.client.create({
      data: {
        tenantId: ctx.tenantId,
        name: validated.name,
        website: validated.website ?? null,
        description: validated.description ?? null,
        productDescription: validated.productDescription ?? null,
        primaryContactName: validated.primaryContactName ?? null,
        primaryContactEmail: validated.primaryContactEmail ?? null,
        primaryContactPhone: validated.primaryContactPhone ?? null,
        intakeData: (validated.intakeData ?? {}) as object,
        profileType: validated.profileType ?? null,
        sectorTag: validated.sectorTag ?? null,
        submissionTracks: validated.submissionTracks ?? [],
        issueCodes: validated.issueCodes ?? [],
        profileStatus: input.profileStatus ?? 'ACTIVE',
        uei: validated.uei ?? null,
        cageCode: validated.cageCode ?? null,
        naicsCodes: validated.naicsCodes ?? [],
        pscCodes: validated.pscCodes ?? [],
        applicantTypes: validated.applicantTypes ?? [],
        setAsideCertifications: validated.setAsideCertifications ?? [],
        ldaClientIds: validated.ldaClientIds ?? [],
        createdByUserId: ctx.userId,
        // Business Development Phase 1: when conversion creates the client
        // from a CONFIRMED canonical identity, stamp the link so the
        // (tenant, canonical) partial unique holds and future conversions
        // find this client. Null for ordinary creates (additive column).
        canonicalEntityId: input.canonicalEntityId ?? null,
      },
    });
    return { client, ldaRegistrantId: tenant?.ldaRegistrantId ?? null };
  }

  /**
   * Bulk-create clients from a CSV import. Per-row error capture: a single
   * bad row never aborts the whole batch, we collect failures, return the
   * count of successful inserts alongside an `errors` array the UI uses to
   * highlight problem rows in the preview.
   *
   * Duplicate-name guard: if a client with the same (case-insensitive)
   * name already exists in this tenant, the row is rejected. Avoids the
   * "import accidentally created 12 duplicate ACME, Inc. records" problem
   * users hit when they re-upload a sheet that was already partly imported.
   */
  async bulkImport(ctx: TenantContext, rows: CreateClientInput[]) {
    // Single tenant-scoped query that fetches all existing names up front,
    // so we can dedupe in-process without N+1 lookups inside the loop.
    const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({
        where: { tenantId: ctx.tenantId },
        select: { name: true },
      }),
    );

    // Billing slot budget for this import. 'comped' tenants are unbounded; for
    // everyone else, only (client_slots − active clients) more clients may be
    // created. Rows beyond the budget are rejected per-row (the import never
    // partially succeeds past the cap), surfacing a slot-limit message the UI
    // can turn into an upgrade prompt.
    const { tenant, activeCount } = await this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: ctx.tenantId },
          select: { clientSlots: true, billingStatus: true },
        });
        const activeCount = await tx.client.count({
          where: { tenantId: ctx.tenantId, status: { not: 'archived' } },
        });
        return { tenant, activeCount };
      },
    );
    let remainingSlots =
      this.billingEnforced && tenant && tenant.billingStatus !== 'comped'
        ? Math.max(
            0,
            effectiveClientSlots(tenant.billingStatus, tenant.clientSlots) -
              activeCount,
          )
        : Number.POSITIVE_INFINITY;
    const existingNames = new Set(
      existing.map((c) => c.name.trim().toLowerCase()),
    );
    // Also dedupe within the import payload itself: two rows with the same
    // name → only the first survives, the second is reported as a dup.
    const seenInPayload = new Set<string>();

    const errors: Array<{ row: number; field?: string; message: string }> = [];
    let createdCount = 0;
    const created: Array<{ id: string; name: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const input = rows[i]!;
      const trimmedName = input.name?.trim();
      if (!trimmedName) {
        errors.push({ row: i, field: 'name', message: 'Name is required' });
        continue;
      }
      const key = trimmedName.toLowerCase();
      if (existingNames.has(key)) {
        errors.push({
          row: i,
          field: 'name',
          message: `A client named "${trimmedName}" already exists in this tenant`,
        });
        continue;
      }
      if (seenInPayload.has(key)) {
        errors.push({
          row: i,
          field: 'name',
          message: `Duplicate name within this import: "${trimmedName}"`,
        });
        continue;
      }
      if (remainingSlots <= 0) {
        errors.push({
          row: i,
          message: `Client slot limit reached (${tenant?.clientSlots ?? 0} slots). Add more slots to import additional clients.`,
        });
        continue;
      }

      try {
        const fundingProfile = validateClientFundingProfile(input);
        const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.client.create({
            data: {
              tenantId: ctx.tenantId,
              name: trimmedName,
              website: input.website ?? null,
              description: input.description ?? null,
              productDescription: input.productDescription ?? null,
              primaryContactName: input.primaryContactName ?? null,
              primaryContactEmail: input.primaryContactEmail ?? null,
              primaryContactPhone: input.primaryContactPhone ?? null,
              intakeData: (fundingProfile.intakeData ?? {}) as object,
              applicantTypes: fundingProfile.applicantTypes ?? [],
              profileType: input.profileType ?? null,
              sectorTag: input.sectorTag ?? null,
              submissionTracks: input.submissionTracks ?? [],
              issueCodes: input.issueCodes ?? [],
              profileStatus: input.profileStatus ?? 'ACTIVE',
              createdByUserId: ctx.userId,
            },
            select: { id: true, name: true },
          }),
        );
        createdCount++;
        created.push(client);
        seenInPayload.add(key);
        remainingSlots--;
      } catch (err) {
        const message = (err as Error).message ?? 'Unknown error';
        errors.push({ row: i, message });
      }
    }

    // Entity resolution (name-based) + SAM gov-id enrichment for each imported
    // client — both fire-and-forget, matching the single-create path so CSV
    // imports are not the odd one out. Never blocks or fails the import response.
    //
    // SAM enrichment will additionally re-trigger entity resolution once it fills
    // the UEI (see sam-entity.service.ts), so both the name-based and
    // identifier-based mapping paths fire even though the UEI isn't known at
    // import time.
    const tenantForResolve = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { ldaRegistrantId: true },
      }),
    );
    const ldaRegistrantId = tenantForResolve?.ldaRegistrantId ?? null;
    for (const c of created) {
      void this.entityResolution
        .resolveClient(c.id, ctx.tenantId, c.name, { ldaRegistrantId })
        .catch((e: unknown) =>
          this.logger.warn(
            `resolve-on-import failed for client ${c.id}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      void this.samEntity
        .enrichGovIds(ctx.tenantId, c.id)
        .catch((e: unknown) =>
          this.logger.warn(
            `gov-id enrichment after bulk import failed for ${c.id}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    }

    return {
      created: createdCount,
      total: rows.length,
      errors,
      items: created,
    };
  }

  async update(ctx: TenantContext, id: string, input: UpdateClientInput) {
    // Read this tenant's current profile to preserve legacy organization values
    // and detect whether its UEI changed.
    const before = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: { uei: true, name: true, applicantTypes: true, intakeData: true, naicsCodes: true, setAsideCertifications: true },
      }),
    );
    if (!before) throw new NotFoundException('Client not found');
    input = { ...input, ...validateClientFundingProfile(input, before) };

    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.update({
        where: { id, tenantId: ctx.tenantId },
        data: {
          ...('name' in input ? { name: input.name } : {}),
          ...('website' in input ? { website: input.website ?? null } : {}),
          ...('description' in input
            ? { description: input.description ?? null }
            : {}),
          ...('productDescription' in input
            ? { productDescription: input.productDescription ?? null }
            : {}),
          ...('primaryContactName' in input
            ? { primaryContactName: input.primaryContactName ?? null }
            : {}),
          ...('primaryContactEmail' in input
            ? { primaryContactEmail: input.primaryContactEmail ?? null }
            : {}),
          ...('primaryContactPhone' in input
            ? { primaryContactPhone: input.primaryContactPhone ?? null }
            : {}),
          ...('intakeData' in input
            ? { intakeData: (input.intakeData ?? {}) as object }
            : {}),
          ...('status' in input ? { status: input.status! } : {}),
          ...('profileType' in input
            ? { profileType: input.profileType ?? null }
            : {}),
          ...('sectorTag' in input
            ? { sectorTag: input.sectorTag ?? null }
            : {}),
          ...('submissionTracks' in input
            ? { submissionTracks: input.submissionTracks ?? [] }
            : {}),
          ...('issueCodes' in input
            ? { issueCodes: input.issueCodes ?? [] }
            : {}),
          ...('profileStatus' in input
            ? { profileStatus: input.profileStatus! }
            : {}),
          ...('uei' in input ? { uei: input.uei ?? null } : {}),
          ...('cageCode' in input ? { cageCode: input.cageCode ?? null } : {}),
          ...('naicsCodes' in input
            ? { naicsCodes: input.naicsCodes ?? [] }
            : {}),
          ...('pscCodes' in input ? { pscCodes: input.pscCodes ?? [] } : {}),
          ...('applicantTypes' in input
            ? { applicantTypes: input.applicantTypes ?? [] }
            : {}),
          ...('setAsideCertifications' in input
            ? { setAsideCertifications: input.setAsideCertifications ?? [] }
            : {}),
        },
      }),
    );

    // When the UEI was set or changed, re-run entity resolution so
    // contracting (tier-1 UEI auto-confirm) and assistance_recipient (exact-UEI
    // match) mappings get created — they could not fire before the UEI existed.
    const ueiChanged =
      'uei' in input && (before?.uei ?? null) !== (input.uei ?? null);
    if (ueiChanged && input.uei) {
      const tenant = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.tenant.findUnique({
          where: { id: ctx.tenantId },
          select: { ldaRegistrantId: true },
        }),
      );
      void this.entityResolution
        .resolveClient(id, ctx.tenantId, client.name, {
          ldaRegistrantId: tenant?.ldaRegistrantId ?? null,
          clientUei: input.uei,
          clientCageCode: input.cageCode ?? null,
        })
        .catch((e: unknown) =>
          this.logger.warn(
            `re-resolution after UEI update failed for ${id}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    }

    // Client KB (F5): keep the profile (Overview tab) index in sync.
    this.clientKb.indexClientProfileFireAndForget(ctx.tenantId, id);
    return this.withLogoUrl(client);
  }

  archive(ctx: TenantContext, id: string) {
    return this.update(ctx, id, { status: 'archived' });
  }

  /**
   * Quick Log: prepend a timestamped, attributed note to the client's profile
   * notes (intakeData.profileNotes). Read-modify-write within the tenant
   * transaction so it composes with manual edits in the Documents tab.
   */
  async appendClientNote(ctx: TenantContext, id: string, body: string) {
    const trimmed = body.trim();
    if (!trimmed) throw new BadRequestException('Note body is required');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findUnique({ where: { id } });
      if (!client) throw new NotFoundException('Client not found');
      const user = await tx.user.findFirst({
        where: { id: ctx.userId },
        select: { firstName: true, lastName: true, email: true },
      });
      const author =
        [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
        user?.email ||
        'Unknown';
      const stamp = new Date().toISOString().slice(0, 10);
      const intake = (client.intakeData ?? {}) as Record<string, unknown>;
      const existing =
        typeof intake.profileNotes === 'string' ? intake.profileNotes : '';
      const entry = `[${stamp} · ${author}] ${trimmed}`;
      const profileNotes = existing.trim() ? `${entry}\n\n${existing}` : entry;
      await tx.client.update({
        where: { id },
        data: { intakeData: { ...intake, profileNotes } as object },
      });
      return { ok: true, profileNotes };
    });
  }

  /**
   * Targeted save for the profile Notes editor: merges ONLY
   * intakeData.profileNotes via read-modify-write inside the tenant
   * transaction, so a stale full-intakeData PUT from another tab can never
   * clobber sibling keys (ldaSignals, wizard fields) — and vice versa.
   * Empty string is allowed (clears the notes).
   */
  async updateProfileNotes(ctx: TenantContext, id: string, notes: string) {
    const client = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.client.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Client not found');
      const intake = (existing.intakeData ?? {}) as Record<string, unknown>;
      return tx.client.update({
        where: { id },
        data: { intakeData: { ...intake, profileNotes: notes } as object },
      });
    });
    return this.withLogoUrl(client);
  }

  /** Ethical wall state + grant roster for one client (user_admin surface). */
  async getMemoryAccess(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { id: true, name: true, memoryWall: true },
      });
      if (!client) throw new NotFoundException('Client not found');
      const grants = await tx.clientMemoryAccess.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        select: { userId: true, grantedBy: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      return {
        clientId,
        name: client.name,
        memoryWall: client.memoryWall,
        grants,
      };
    });
  }

  /**
   * Atomically set the ethical-wall flag and replace the grant roster
   * (master plan Phase 1). Replace-set semantics: the request's userIds
   * becomes the complete roster — one lever, so a wall can never be erected
   * with a half-written roster. Every userId must be a member of this tenant
   * (a foreign uuid is a bug or an attack — reject the whole request).
   * Audit-logged with the full before/after so self-grants are visible.
   */
  async setMemoryAccess(
    ctx: TenantContext,
    clientId: string,
    input: { memoryWall: boolean; userIds: string[] },
  ) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { id: true, memoryWall: true },
      });
      if (!client) throw new NotFoundException('Client not found');

      const requested = [...new Set(input.userIds)];
      const members = await tx.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId, userId: { in: requested } },
        select: { userId: true },
      });
      const memberSet = new Set(members.map((m) => m.userId));
      const invalid = requested.filter((u) => !memberSet.has(u));
      if (invalid.length) {
        throw new BadRequestException(
          `Cannot grant memory access to non-members of this tenant: ${invalid.join(', ')}`,
        );
      }

      const existing = await tx.clientMemoryAccess.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        select: { userId: true },
      });
      const existingIds = existing.map((g) => g.userId);
      const existingSet = new Set(existingIds);
      const toAdd = requested.filter((u) => !existingSet.has(u));
      const toRemove = existingIds.filter((u) => !requested.includes(u));

      if (toAdd.length) {
        await tx.clientMemoryAccess.createMany({
          data: toAdd.map((userId) => ({
            tenantId: ctx.tenantId,
            clientId,
            userId,
            grantedBy: ctx.userId,
          })),
        });
      }
      if (toRemove.length) {
        await tx.clientMemoryAccess.deleteMany({
          where: { tenantId: ctx.tenantId, clientId, userId: { in: toRemove } },
        });
      }
      if (client.memoryWall !== input.memoryWall) {
        await tx.client.update({
          where: { id: clientId },
          data: { memoryWall: input.memoryWall },
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'client.memory_wall.update',
          entityType: 'client',
          entityId: clientId,
          before: {
            memoryWall: client.memoryWall,
            grantedUserIds: [...existingIds].sort(),
          },
          after: {
            memoryWall: input.memoryWall,
            grantedUserIds: [...requested].sort(),
          },
        },
      });

      return {
        clientId,
        memoryWall: input.memoryWall,
        grantedUserIds: requested,
      };
    });
  }

  async createLogoUploadUrl(
    ctx: TenantContext,
    clientId: string,
    contentType: string,
    contentLength: number,
  ) {
    if (!this.bucket)
      throw new BadRequestException('Asset uploads are not configured');
    if (!ALLOWED_LOGO_MIME.has(contentType)) {
      throw new BadRequestException(
        `Unsupported logo content type: ${contentType}`,
      );
    }
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 1 ||
      contentLength > MAX_LOGO_BYTES
    ) {
      throw new BadRequestException(
        `Logo must be between 1 and ${MAX_LOGO_BYTES} bytes`,
      );
    }

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // The API database role bypasses RLS, so the tenant predicate is part of
      // the authorization boundary rather than merely a query optimization.
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Client not found');
    });

    const s3Key = clientLogoUploadKey(ctx.tenantId, clientId, contentType);
    const presigned = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: s3Key,
      Fields: {
        'Content-Type': contentType,
      },
      Conditions: [
        ['content-length-range', 1, MAX_LOGO_BYTES],
        ['eq', '$Content-Type', contentType],
        ['eq', '$key', s3Key],
      ],
      Expires: 300,
    });
    return { ...presigned, s3Key };
  }

  async confirmLogoUpload(
    ctx: TenantContext,
    clientId: string,
    s3Key: string,
    contentType: string,
  ) {
    if (!this.bucket)
      throw new BadRequestException('Assets bucket not configured');
    if (!ALLOWED_LOGO_MIME.has(contentType)) {
      throw new BadRequestException(
        `Unsupported logo content type: ${contentType}`,
      );
    }
    const uploadId = clientLogoUploadId(
      s3Key,
      ctx.tenantId,
      clientId,
      contentType,
    );
    if (!uploadId)
      throw new BadRequestException(
        'Logo key does not match the upload location',
      );

    // Check ownership before touching S3. This prevents a caller from using a
    // guessed client id as an existence oracle for another tenant's objects.
    const clientExists = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { id: true, logoS3Key: true },
      }),
    );
    if (!clientExists) throw new NotFoundException('Client not found');

    const releaseLogoValidation = await this.acquireLogoValidation();
    const finalKey = clientLogoKey(ctx.tenantId, clientId, contentType);
    try {
      const object = await this.s3
        .send(new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }))
        .catch(() => null);
      if (!object)
        throw new BadRequestException('Uploaded logo not found in S3');
      if (object.ContentType !== contentType) {
        throw new BadRequestException(
          'Uploaded logo content type does not match the requested type',
        );
      }
      if (
        !Number.isSafeInteger(object.ContentLength) ||
        (object.ContentLength ?? 0) < 1 ||
        (object.ContentLength ?? 0) > MAX_LOGO_BYTES
      ) {
        throw new BadRequestException(
          `Uploaded logo must be between 1 and ${MAX_LOGO_BYTES} bytes`,
        );
      }
      if (!object.Body) throw new BadRequestException('Uploaded logo is empty');
      const bytes = Buffer.from(await object.Body.transformToByteArray());
      if (contentType === 'image/png' && isInterlacedPng(bytes)) {
        throw new BadRequestException('Uploaded PNG must be non-interlaced');
      }
      if (bytes.length !== object.ContentLength) {
        throw new BadRequestException(
          'Uploaded file contents are not a valid logo image',
        );
      }
      const candidate = sanitizeClientLogoBytes(bytes, contentType);
      if (!candidate) {
        throw new BadRequestException(
          'Uploaded file contents are not a valid logo image',
        );
      }
      // Keep the bounded lease until S3 has consumed the buffer so stalled
      // uploads cannot accumulate unbounded 2 MiB logo bodies.
      try {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: finalKey,
            Body: candidate,
            ContentType: contentType,
            // A confirmed key is immutable. Even a UUID collision or replay
            // must never change bytes already bound into a report snapshot.
            IfNoneMatch: '*',
          }),
        );
      } catch (putError) {
        // A successful conditional PUT can lose its response (or a retry can
        // receive 412). Continue only when the exact immutable candidate is
        // readable at this fresh key; otherwise preserve the original error.
        if (!(await this.logoObjectMatches(finalKey, candidate, contentType))) {
          throw putError;
        }
      }
    } finally {
      releaseLogoValidation();
    }

    const swapLogoPointer = async () => {
      let expectedPreviousKey = clientExists.logoS3Key ?? null;
      for (
        let attempt = 0;
        attempt < MAX_LOGO_POINTER_SWAP_ATTEMPTS;
        attempt += 1
      ) {
        const outcome = await this.prisma.withTenant(
          ctx.tenantId,
          async (tx) => {
            // Optimistic compare-and-swap makes the pointer transition atomic
            // across API replicas. The value we return is therefore the exact
            // object this promotion superseded, not the stale preflight read.
            const result = await tx.client.updateMany({
              where: {
                id: clientId,
                tenantId: ctx.tenantId,
                logoS3Key: expectedPreviousKey,
              },
              data: {
                logoS3Key: finalKey,
                logoContentType: contentType,
                logoUploadedAt: new Date(),
              },
            });
            if (result.count === 1) {
              const client = await tx.client.findFirst({
                where: { id: clientId, tenantId: ctx.tenantId },
              });
              if (!client) throw new NotFoundException('Client not found');
              return { kind: 'updated' as const, client };
            }

            const current = await tx.client.findFirst({
              where: { id: clientId, tenantId: ctx.tenantId },
              select: { logoS3Key: true },
            });
            return current
              ? {
                  kind: 'retry' as const,
                  currentKey: current.logoS3Key ?? null,
                }
              : { kind: 'missing' as const };
          },
        );

        if (outcome.kind === 'updated') {
          return { updated: outcome.client, previousKey: expectedPreviousKey };
        }
        if (outcome.kind === 'missing') {
          throw new NotFoundException('Client not found');
        }
        expectedPreviousKey = outcome.currentKey;
      }
      throw new HttpException(
        'The client logo changed concurrently. Please retry.',
        HttpStatus.CONFLICT,
      );
    };

    let pointerSwap: Awaited<ReturnType<typeof swapLogoPointer>>;
    try {
      pointerSwap = await swapLogoPointer();
    } catch (error) {
      // A transaction can commit even if its acknowledgement is lost. Never
      // delete the immutable promoted object on a database error: doing so can
      // leave a successfully committed logo pointer dangling. Rare unreachable
      // objects are intentionally retained for a future reachability-based GC.
      this.logger.warn(
        'Retained promoted client logo because the database commit outcome could not be safely reversed.',
      );
      throw error;
    }

    const { updated } = pointerSwap;
    // Delete only the unconfirmed staging object. Confirmed objects are
    // immutable and retained so report snapshots and signed URLs remain valid
    // across later logo changes.
    const cleanup: Array<Promise<unknown>> = [
      this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: s3Key }),
      ),
    ];
    await Promise.all(
      cleanup.map((operation) =>
        operation.catch((error: unknown) =>
          this.logger.warn(
            `Unable to clean up superseded client logo: ${
              error instanceof Error ? error.name : 'unknown error'
            }`,
          ),
        ),
      ),
    );
    return this.withLogoUrl(updated);
  }

  /**
   * Internal bridge (apps/workspace Hill Day): the sponsor mark and the firm
   * mark for co-branding the packet, as short-lived signed GET URLs. Read-only;
   * reached only through InternalServiceGuard.
   */
  async internalBranding(
    tenantId: string,
    clientId: string,
  ): Promise<{
    clientLogoUrl: string | null;
    clientLogoContentType: string | null;
    firmLogoUrl: string | null;
    firmLogoContentType: string | null;
  }> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(tenantId) || !uuid.test(clientId)) {
      throw new NotFoundException('Client not found');
    }
    const rows = await this.prisma.withSystem(async (tx) => {
      const [client, tenant] = await Promise.all([
        tx.client.findFirst({
          where: { id: clientId, tenantId },
          select: { logoS3Key: true, logoContentType: true },
        }),
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { logoS3Key: true, logoContentType: true },
        }),
      ]);
      return { client, tenant };
    });
    if (!rows.client) throw new NotFoundException('Client not found');
    return {
      clientLogoUrl: rows.client.logoS3Key ? await this.signedGetUrl(rows.client.logoS3Key) : null,
      clientLogoContentType: rows.client.logoContentType ?? null,
      firmLogoUrl: rows.tenant?.logoS3Key ? await this.signedGetUrl(rows.tenant.logoS3Key) : null,
      firmLogoContentType: rows.tenant?.logoContentType ?? null,
    };
  }

  private async withLogoUrls<T extends { logoS3Key: string | null }>(
    clients: T[],
  ): Promise<Array<T & { logoUrl: string | null }>> {
    return Promise.all(clients.map((client) => this.withLogoUrl(client)));
  }

  private async withLogoUrl<T extends { logoS3Key: string | null }>(
    client: T,
  ): Promise<T & { logoUrl: string | null }> {
    return {
      ...client,
      logoUrl: client.logoS3Key
        ? await this.signedGetUrl(client.logoS3Key)
        : null,
    };
  }

  private async signedGetUrl(
    s3Key: string,
    ttlSeconds = 300,
  ): Promise<string | null> {
    if (!this.bucket) return null;
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
      {
        expiresIn: ttlSeconds,
      },
    );
  }
}
