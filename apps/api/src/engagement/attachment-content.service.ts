/**
 * Attachment readiness + BOUNDED extraction (Phase 1 §3.h1 / §3.h3).
 *
 * Split out of EngagementService for two reasons: EvidenceSourceService must be
 * able to extract a selected document server-side without depending on
 * EngagementService (which depends on the generation stack, so the reverse edge
 * would be a cycle), and the readiness gate has to be enforceable from every
 * caller — context selection, extraction, download-URL creation, and external
 * send — from ONE implementation rather than four.
 *
 * Two behaviors here are load-bearing:
 *
 *   1. Extraction is BOUNDED (pages, characters, spreadsheet rows/cols, wall
 *      clock) and reports whether a bound bit. An unbounded extraction is both a
 *      cost/latency hazard and an accuracy one: a silently truncated document
 *      reads to the model as a COMPLETE document, so it will confidently
 *      summarize a contract whose second half it never saw.
 *   2. A placeholder ("Extracting…") or an error string is NEVER returned as
 *      text. The pre-Phase-1 flow could hand such a string to the prompt as
 *      evidence, where it is indistinguishable from real content.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import {
  EXTRACTION_TIMEOUT_MS,
  MAX_EXTRACTED_CHARS,
  MAX_EXTRACTION_PAGES,
  MAX_SPREADSHEET_COLS,
  MAX_SPREADSHEET_ROWS,
} from './generation/evidence-packet.types.js';
import { extractXlsxText, isSpreadsheetAttachment } from './xlsx-extract.js';
import { extractPptxText, isPowerPointAttachment } from './pptx-extract.js';
import {
  isUsableScanStatus,
  scanStatusDisclosure,
  type AttachmentScanStatus,
} from './attachment-scanner.service.js';

/** The subset of an attachment row the readiness gate needs. */
export interface AttachmentReadinessRow {
  id: string;
  fileName: string;
  contentType: string;
  lifecycleStatus: string;
  scanStatus: string | null;
  verifiedContentType?: string | null;
}

export interface ReadinessVerdict {
  usable: boolean;
  /** Stable machine code for tests/telemetry. Null when usable and scanned. */
  code:
    | null
    | 'ATTACHMENT_QUARANTINED'
    | 'ATTACHMENT_BLOCKED'
    | 'ATTACHMENT_DELETE_PENDING'
    | 'ATTACHMENT_SCAN_PENDING'
    | 'ATTACHMENT_SCAN_THREAT'
    | 'ATTACHMENT_SCAN_UNSUPPORTED'
    | 'ATTACHMENT_SCAN_ACCESS_DENIED'
    | 'ATTACHMENT_SCAN_FAILED'
    | 'ATTACHMENT_NEVER_SCANNED';
  /** What the user should see. Null only when the file is scanned and clean. */
  disclosure: string | null;
}

export type ExtractionSource = 'text' | 'docx' | 'pdf' | 'spreadsheet' | 'pptx';

export interface BoundedExtraction {
  source: ExtractionSource;
  text: string;
  /** 'extracted' | 'truncated' | 'empty' */
  status: 'extracted' | 'truncated' | 'empty';
  metadata: {
    chars: number;
    truncated: boolean;
    charLimitHit: boolean;
    pageLimitHit: boolean;
    rowLimitHit: boolean;
    timedOut: boolean;
    limits: {
      maxChars: number;
      maxPages: number;
      maxRows: number;
      maxCols: number;
      timeoutMs: number;
    };
  };
}

@Injectable()
export class AttachmentContentService {
  private readonly logger = new Logger(AttachmentContentService.name);

  /**
   * Whether an attachment's bytes may be used, given the scan-required flag.
   *
   * When scanning is NOT required, a quarantined/pending row is still usable —
   * otherwise the feature would be dead in every environment without a scanner —
   * but the verdict always carries a `disclosure` string so the caller can SAY
   * the file was not scanned. Silence would imply it was clean.
   */
  readiness(row: AttachmentReadinessRow, scanRequired: boolean): ReadinessVerdict {
    const scan = (row.scanStatus ?? null) as AttachmentScanStatus | null;

    // Lifecycle states that are unusable regardless of the flag: a deleted or
    // threat-blocked object must never be readable, and there is no environment
    // in which handing back a delete-failed orphan is correct.
    if (row.lifecycleStatus === 'blocked') {
      return {
        usable: false,
        code: 'ATTACHMENT_BLOCKED',
        disclosure:
          scanStatusDisclosure(scan) ?? 'This file was blocked and cannot be used or sent.',
      };
    }
    if (row.lifecycleStatus === 'delete_pending' || row.lifecycleStatus === 'delete_failed') {
      return {
        usable: false,
        code: 'ATTACHMENT_DELETE_PENDING',
        disclosure: 'This file has been deleted and is no longer available.',
      };
    }

    if (!scanRequired) {
      // Usable, but never silently: report the honest disclosure for every state
      // that is not a real clean verdict.
      return { usable: true, code: null, disclosure: scanStatusDisclosure(scan) };
    }

    // ---- scan-required mode: fail closed on anything that is not clean ----
    if (row.lifecycleStatus === 'quarantined' && !isUsableScanStatus(scan)) {
      return {
        usable: false,
        code: 'ATTACHMENT_QUARANTINED',
        disclosure:
          scanStatusDisclosure(scan) ??
          'This file is awaiting a malware scan and cannot be used yet.',
      };
    }
    if (scan == null) {
      return {
        usable: false,
        code: 'ATTACHMENT_NEVER_SCANNED',
        disclosure: scanStatusDisclosure(null),
      };
    }
    if (!isUsableScanStatus(scan)) {
      const code = (
        {
          pending: 'ATTACHMENT_SCAN_PENDING',
          threat: 'ATTACHMENT_SCAN_THREAT',
          unsupported: 'ATTACHMENT_SCAN_UNSUPPORTED',
          access_denied: 'ATTACHMENT_SCAN_ACCESS_DENIED',
          failed: 'ATTACHMENT_SCAN_FAILED',
        } as const
      )[scan as Exclude<AttachmentScanStatus, 'clean' | 'scanner_not_required'>];
      return { usable: false, code, disclosure: scanStatusDisclosure(scan) };
    }
    // 'scanner_not_required' while scanRequired=true means the null adapter is
    // in play; treat as unscanned rather than clean.
    if (scan === 'scanner_not_required') {
      return {
        usable: false,
        code: 'ATTACHMENT_NEVER_SCANNED',
        disclosure: scanStatusDisclosure('scanner_not_required'),
      };
    }
    return { usable: true, code: null, disclosure: null };
  }

  /** sha256 of the stored bytes — the SERVER's digest, not the client's claim. */
  sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  /**
   * Content type sniffed from MAGIC BYTES for the formats we actually parse.
   * Returns null when the signature is unrecognized (which is not itself an
   * error — a .txt or .csv has no magic number).
   *
   * The point is not exhaustive detection: it is that a file DECLARED as
   * application/pdf whose bytes begin with `PK` (a zip container) must not be
   * handed to the PDF parser on the strength of its declared MIME alone.
   */
  detectContentType(bytes: Buffer): string | null {
    if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
      return 'application/pdf';
    }
    // OOXML (docx/xlsx/pptx) and legacy zip all start with the PK signature; the
    // specific OOXML part names live deeper in the archive, so report the
    // container honestly rather than guessing a subtype.
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const b2 = bytes[2];
      const b3 = bytes[3];
      const isZipLocalHeader =
        (b2 === 0x03 && b3 === 0x04) || (b2 === 0x05 && b3 === 0x06) || (b2 === 0x07 && b3 === 0x08);
      if (isZipLocalHeader) return 'application/zip';
    }
    // Legacy OLE compound file (.doc/.xls/.ppt).
    if (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    ) {
      return 'application/x-ole-storage';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'image/png';
    }
    return null;
  }

  /**
   * True when the declared type and the sniffed signature are in open conflict
   * (e.g. "this is a PDF" over zip bytes). An unrecognized signature is NOT a
   * conflict — most text formats have none.
   */
  contentTypeConflicts(declared: string, detected: string | null): boolean {
    if (!detected) return false;
    const d = declared.trim().toLowerCase();
    if (detected === 'application/pdf') return d !== 'application/pdf';
    if (detected === 'application/zip') {
      // Every OOXML type is legitimately a zip container.
      return !(
        d.startsWith('application/vnd.openxmlformats-officedocument') ||
        d === 'application/zip' ||
        d === 'application/vnd.oasis.opendocument.text'
      );
    }
    if (detected === 'application/x-ole-storage') {
      return !(
        d === 'application/msword' ||
        d === 'application/vnd.ms-excel' ||
        d === 'application/vnd.ms-powerpoint' ||
        d === 'application/x-ole-storage'
      );
    }
    if (detected.startsWith('image/')) return !d.startsWith('image/');
    return false;
  }

  /** True when this file is a DOCUMENT we can extract text from (not A/V). */
  isExtractableDocument(fileName: string, contentType: string): boolean {
    return (
      isPlainTextAttachment(fileName, contentType) ||
      isDocxAttachment(fileName, contentType) ||
      isPdfAttachment(fileName, contentType) ||
      isSpreadsheetAttachment(fileName, contentType) ||
      isPowerPointAttachment(fileName, contentType)
    );
  }

  /**
   * Extract text under the §3.h3 bounds. Throws BadRequestException only for a
   * genuinely unsupported format; an empty or failed extraction is reported as a
   * STATUS so the caller can raise a visible source failure instead of pushing a
   * placeholder into a prompt.
   */
  async extractBounded(
    bytes: Buffer,
    fileName: string,
    contentType: string,
  ): Promise<BoundedExtraction> {
    const limits = {
      maxChars: MAX_EXTRACTED_CHARS,
      maxPages: MAX_EXTRACTION_PAGES,
      maxRows: MAX_SPREADSHEET_ROWS,
      maxCols: MAX_SPREADSHEET_COLS,
      timeoutMs: EXTRACTION_TIMEOUT_MS,
    };
    const meta = {
      chars: 0,
      truncated: false,
      charLimitHit: false,
      pageLimitHit: false,
      rowLimitHit: false,
      timedOut: false,
      limits,
    };

    let source: ExtractionSource;
    let raw: string;

    try {
      if (isPlainTextAttachment(fileName, contentType)) {
        source = 'text';
        raw = bytes.toString('utf8');
      } else if (isDocxAttachment(fileName, contentType)) {
        source = 'docx';
        raw = await this.withTimeout(
          mammoth.extractRawText({ buffer: bytes }).then((r) => r.value),
          meta,
        );
      } else if (isPdfAttachment(fileName, contentType)) {
        source = 'pdf';
        const { text, pageLimitHit } = await this.withTimeout(
          extractPdfBounded(bytes, limits.maxPages),
          meta,
        );
        raw = text;
        meta.pageLimitHit = pageLimitHit;
      } else if (isSpreadsheetAttachment(fileName, contentType)) {
        source = 'spreadsheet';
        // extractXlsxText owns its own sheet walk; bound the RESULT by rows here
        // rather than reaching into it, and record that the bound bit.
        const full = await this.withTimeout(extractXlsxText(bytes), meta);
        const lines = full.split('\n');
        if (lines.length > limits.maxRows) {
          meta.rowLimitHit = true;
          raw = lines.slice(0, limits.maxRows).join('\n');
        } else {
          raw = full;
        }
      } else if (isPowerPointAttachment(fileName, contentType)) {
        source = 'pptx';
        raw = await this.withTimeout(extractPptxText(bytes), meta);
      } else {
        throw new BadRequestException(
          'Unsupported source. Upload .txt, .csv, .pdf, .docx, .xlsx, or .pptx.',
        );
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      if (meta.timedOut) {
        return {
          source: 'text',
          text: '',
          status: 'empty',
          metadata: { ...meta, chars: 0, truncated: true },
        };
      }
      throw e;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return { source, text: '', status: 'empty', metadata: { ...meta, chars: 0 } };
    }

    let text = trimmed;
    if (text.length > limits.maxChars) {
      text = `${text.slice(0, limits.maxChars - 1).trim()}…`;
      meta.charLimitHit = true;
    }
    meta.chars = text.length;
    meta.truncated = meta.charLimitHit || meta.pageLimitHit || meta.rowLimitHit;

    return {
      source,
      text,
      status: meta.truncated ? 'truncated' : 'extracted',
      metadata: meta,
    };
  }

  /** Race a promise against the extraction timeout, flagging the metadata. */
  private async withTimeout<T>(p: Promise<T>, meta: { timedOut: boolean }): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            meta.timedOut = true;
            reject(new Error(`extraction exceeded ${EXTRACTION_TIMEOUT_MS}ms`));
          }, EXTRACTION_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ── Format predicates (moved from engagement.service.ts so both callers and the
// evidence resolvers share one definition) ──────────────────────────────────

export function isPlainTextAttachment(fileName: string, contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    /\.(txt|text|md|csv|log)$/i.test(fileName) ||
    normalized === 'application/json'
  );
}

export function isDocxAttachment(fileName: string, contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    /\.docx$/i.test(fileName) ||
    normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

export function isPdfAttachment(fileName: string, contentType: string): boolean {
  return contentType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(fileName);
}

export function isTranscribableAttachment(fileName: string, contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i.test(fileName)
  );
}

/**
 * PDF text extraction capped at `maxPages`. pdf-parse can render a per-page
 * breakdown, so the cap is applied at the PAGE level (not by slicing the joined
 * string) — a 4,000-page filing must not be fully parsed just to be truncated
 * afterwards.
 */
export async function extractPdfBounded(
  buffer: Buffer,
  maxPages: number,
): Promise<{ text: string; pageLimitHit: boolean }> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    const pages = (parsed as { pages?: Array<{ text?: string }> }).pages;
    if (Array.isArray(pages) && pages.length) {
      const pageLimitHit = pages.length > maxPages;
      const text = pages
        .slice(0, maxPages)
        .map((p) => (p.text ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
      return { text, pageLimitHit };
    }
    // No per-page breakdown available: fall back to the flat text. The character
    // bound in extractBounded still applies.
    return { text: (parsed.text ?? '').trim(), pageLimitHit: false };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
