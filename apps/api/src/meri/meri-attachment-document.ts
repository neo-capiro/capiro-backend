import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import type { ResolvedAiCredential } from '../ai-credentials/ai-credential-resolver.service.js';
import { AttachmentPdfVisionReader } from '../engagement/attachment-pdf-vision.js';
import { extractPptxDocument } from '../engagement/pptx-extract.js';
import { xlsxCellToText } from '../engagement/xlsx-extract.js';
import { MAX_SPREADSHEET_COLS, MAX_SPREADSHEET_ROWS } from '../engagement/generation/evidence-packet.types.js';
import { extractPdfText } from './meri-attachment-extract.js';
import { sha256Bytes, validateDocumentArtifactBytes } from './meri-artifact-integrity.js';
import {
  DOC_TEXT_MAX_CHARS,
  TRUNCATION_MARKER,
  resolveDocumentStatus,
  type AttachmentKind,
  type DocumentExtractionResult,
} from './meri-attachment.helpers.js';

export const ATTACHMENT_OCR_MAX_PAGES = 8;
export const ATTACHMENT_OCR_TIMEOUT_MS = 45_000;
const visualReader = new AttachmentPdfVisionReader();

export class MeriXlsxValidationError extends Error {
  constructor(readonly code: 'invalid_package' | 'macro_content') {
    super(code);
  }
}

interface MeriXlsxPackageInfo {
  hasExternalLinks: boolean;
  hasVisuals: boolean;
}

/** Validate the real OOXML workbook root/type and reject executable package
 * content before ExcelJS sees it. External links are never followed; their
 * presence is returned so cached remote formula values can be withheld. */
export async function validateMeriXlsxPackage(bytes: Buffer): Promise<MeriXlsxPackageInfo> {
  try {
    await validateDocumentArtifactBytes('xlsx', bytes);
  } catch {
    throw new MeriXlsxValidationError('invalid_package');
  }
  const zip = await JSZip.loadAsync(bytes);
  const paths = Object.keys(zip.files);
  if (paths.some((path) =>
    /(^|\/)(?:vbaProject(?:Signature)?\.bin|macrosheets\/|dialogsheets\/|activeX\/|embeddings\/)/i.test(path))) {
    throw new MeriXlsxValidationError('macro_content');
  }
  return {
    hasExternalLinks: paths.some((path) => /^xl\/externalLinks\//i.test(path)),
    hasVisuals: paths.some((path) => /^xl\/(?:charts|media)\//i.test(path) && !zip.files[path]?.dir),
  };
}

function xlsxCoordinate(sheetName: string, address: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${address}`;
}

function formulaText(value: Record<string, unknown>, packageHasExternalLinks: boolean): {
  text: string;
  cached: boolean;
  unavailable: 'external' | 'missing' | null;
} {
  const formula = typeof value.formula === 'string'
    ? value.formula
    : typeof value.sharedFormula === 'string' ? value.sharedFormula : '';
  const external = /\[[^\]]+\]/.test(formula) ||
    /\b(?:WEBSERVICE|RTD|DDE)\s*\(/i.test(formula) ||
    (packageHasExternalLinks && /external/i.test(formula));
  if (external) {
    return { text: '[external formula result unavailable; external links were not read]', cached: false, unavailable: 'external' };
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'result') || value.result === undefined) {
    return { text: '[formula result unavailable; recalculate and save the workbook]', cached: false, unavailable: 'missing' };
  }
  const result = value.result;
  const text = xlsxCellToText(result);
  if (text) return { text, cached: true, unavailable: null };
  if (result === '' || result === null) {
    return { text: '[cached formula result: empty]', cached: true, unavailable: null };
  }
  if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).error === 'string') {
    return { text: `[cached formula error: ${(result as Record<string, unknown>).error as string}]`, cached: true, unavailable: null };
  }
  return { text: String(result ?? ''), cached: true, unavailable: null };
}

async function extractMeriXlsxDocument(bytes: Buffer, packageInfo: MeriXlsxPackageInfo): Promise<DocumentExtractionResult> {
  const ExcelJS = await import('exceljs');
  const workbook = new (ExcelJS.default ?? ExcelJS).Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const lines: string[] = [];
  const reasons = new Set<string>();
  const contentLimit = DOC_TEXT_MAX_CHARS - TRUNCATION_MARKER.length - 1;
  let chars = 0;
  let inspectedRows = 0;
  let readableCells = 0;
  let partial = false;
  let textLimitReached = false;
  let sawCachedFormula = false;
  let sawMissingFormula = false;
  let sawExternalFormula = false;

  const add = (line: string): boolean => {
    const needed = line.length + (lines.length ? 1 : 0);
    if (chars + needed > contentLimit) {
      partial = true;
      textLimitReached = true;
      return false;
    }
    lines.push(line);
    chars += needed;
    return true;
  };

  add(`Source SHA-256: ${sha256Bytes(bytes)}`);

  for (const [sheetIndex, sheet] of workbook.worksheets.entries()) {
    if (textLimitReached) break;
    const visibility = sheet.state === 'veryHidden' ? 'very hidden' : sheet.state;
    if (!add(`Worksheet ${sheetIndex + 1}: ${JSON.stringify(sheet.name)} (${visibility})`)) break;
    let sheetCells = 0;
    const lastRow = Math.min(sheet.rowCount, MAX_SPREADSHEET_ROWS - inspectedRows);
    for (let rowNumber = 1; rowNumber <= lastRow && !textLimitReached; rowNumber += 1) {
      inspectedRows += 1;
      const row = sheet.getRow(rowNumber);
      const lastColumn = Math.min(row.cellCount, MAX_SPREADSHEET_COLS);
      if (row.cellCount > MAX_SPREADSHEET_COLS) {
        partial = true;
        reasons.add(`Cells after column ${MAX_SPREADSHEET_COLS} were not read.`);
      }
      for (let column = 1; column <= lastColumn; column += 1) {
        const cell = row.getCell(column);
        const master = (cell as unknown as { master?: { address?: string } }).master;
        if (master?.address && master.address !== cell.address) continue;
        const value = cell.value;
        if (value == null) continue;
        let text: string;
        let suffix = '';
        if (typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
          const rendered = formulaText(value as unknown as Record<string, unknown>, packageInfo.hasExternalLinks);
          text = rendered.text;
          if (rendered.cached) {
            sawCachedFormula = true;
            suffix = ' (saved cached formula result; not recalculated)';
          } else if (rendered.unavailable === 'external') {
            sawExternalFormula = true;
            partial = true;
          } else {
            sawMissingFormula = true;
            partial = true;
          }
        } else {
          text = xlsxCellToText(value);
        }
        if (!text) continue;
        if (!add(`${xlsxCoordinate(sheet.name, cell.address)} = ${JSON.stringify(text)}${suffix}`)) break;
        sheetCells += 1;
        readableCells += 1;
      }
    }
    if (!sheetCells && !textLimitReached) add('[no non-empty cells]');
    if (sheet.rowCount > lastRow) {
      partial = true;
      reasons.add(`Only the first ${MAX_SPREADSHEET_ROWS} row positions across the workbook were inspected.`);
    }
    if (inspectedRows >= MAX_SPREADSHEET_ROWS && sheetIndex + 1 < workbook.worksheets.length) {
      partial = true;
      reasons.add('Later worksheets were not read because the workbook reached the row limit.');
      break;
    }
  }

  if (!readableCells) {
    return {
      status: 'unsupported', text: null, truncated: false,
      reason: 'No readable cell values were found in this workbook.',
    };
  }
  if (textLimitReached) reasons.add('Only part of the workbook is included because it reached the text limit.');
  if (sawCachedFormula) reasons.add('Formula cells use saved cached results; formulas were not recalculated.');
  if (sawMissingFormula) reasons.add('Some formulas had no saved result and are marked unavailable.');
  if (sawExternalFormula || packageInfo.hasExternalLinks) {
    reasons.add('External workbook links and their cached values were not read.');
    partial = true;
  }
  if (packageInfo.hasVisuals) {
    reasons.add('Spreadsheet charts and images are not represented by cell extraction.');
    partial = true;
  }
  if (partial) lines.push(TRUNCATION_MARKER);
  const reason = reasons.size ? [...reasons].join(' ').slice(0, 300) : null;
  return {
    status: partial ? 'truncated' : 'parsed',
    text: lines.join('\n').trim(),
    truncated: partial,
    reason,
  };
}

/** Reuse the canonical provider page reader; persist its literal result once so
 * regeneration and follow-ups do not run nondeterministic OCR again. */
export async function extractMeriDocument(input: {
  bytes: Buffer;
  kind: AttachmentKind;
  tenantId: string;
  userId: string;
  resolveCredential: () => Promise<ResolvedAiCredential | null>;
}, reader: Pick<AttachmentPdfVisionReader, 'read'> = visualReader): Promise<DocumentExtractionResult & { pages: number | null }> {
  if (input.kind === 'xlsx') {
    const packageInfo = await validateMeriXlsxPackage(input.bytes);
    return { ...(await extractMeriXlsxDocument(input.bytes, packageInfo)), pages: null };
  }
  if (input.kind === 'pptx') {
    const extracted = await extractPptxDocument(input.bytes);
    const resolved = resolveDocumentStatus('pptx', extracted.text);
    if (!resolved.text) return { ...resolved, pages: null,
      reason: 'No readable slide text was found. Export the presentation to PDF or upload images of the slides.' };
    const partial = resolved.truncated || extracted.truncated || extracted.unreadableSlides.length > 0;
    const reasons = ['PowerPoint slide text only. Images, charts, and speaker notes are not included; upload a PDF or slide images for those details.'];
    if (extracted.unreadableSlides.length)
      reasons.push(`${extracted.unreadableSlides.length} slide(s) had no readable text.`);
    if (resolved.truncated || extracted.truncated)
      reasons.push('Only part of the slide text is included because it exceeds the reading limit.');
    return { ...resolved, pages: null, status: partial ? 'truncated' : 'parsed',
      truncated: partial, reason: reasons.join(' ').slice(0, 300) };
  }
  if (input.kind !== 'pdf') {
    const raw = input.kind === 'docx'
      ? (await mammoth.extractRawText({ buffer: input.bytes })).value
      : new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
    // A binary .txt should not be accepted as readable replacement characters.
    if (raw.includes('\u0000')) throw new Error('Binary text attachment');
    return { ...resolveDocumentStatus(input.kind, raw), pages: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ATTACHMENT_OCR_TIMEOUT_MS);
  const cacheScope = `${input.tenantId}:${input.userId}:${createHash('sha256').update(input.bytes).digest('hex')}`;
  let attempts = 0;
  try {
    const extracted = await extractPdfText(input.bytes, {
      signal: controller.signal,
      readScannedPage: async (section, sectionCount) => {
        if (controller.signal.aborted || attempts >= ATTACHMENT_OCR_MAX_PAGES)
          return { text: '', partial: true };
        attempts += 1;
        let onAbort: () => void = () => {};
        try {
          const deadline = new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('Scanned-page reading timed out'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
          });
          const result = await Promise.race([reader.read({ bytes: input.bytes, cacheScope, section, sectionCount,
            resolveCredential: input.resolveCredential, signal: controller.signal }), deadline]);
          return { text: result.text, partial: result.readability.status !== 'ocr_readable' };
        } catch {
          // Keep earlier readable pages and disclose the gap if the deadline expires.
          return { text: '', partial: true };
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
        }
      },
    });
    const resolved = resolveDocumentStatus('pdf', extracted.text);
    const partial = extracted.truncated || extracted.unreadablePages.length > 0 || resolved.truncated;
    const reasons: string[] = [];
    if (extracted.visuallyReadPages.length)
      reasons.push('Includes text read from scanned pages. Verify important names and figures against the original.');
    if (extracted.unreadablePages.length)
      reasons.push(`${extracted.unreadablePages.length} page(s) could not be read completely. Retry this file or upload those pages separately.`);
    if (extracted.truncated || resolved.truncated)
      reasons.push('Only part of this document is included because it exceeds the reading limit.');
    return { ...resolved, pages: extracted.pages,
      ...(resolved.text ? { status: partial ? 'truncated' as const : 'parsed' as const, truncated: partial } : {}),
      reason: reasons.length ? reasons.join(' ').slice(0, 300) : resolved.reason };
  } finally {
    clearTimeout(timeout);
  }
}
