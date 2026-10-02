/**
 * Pure, dependency-free helpers for Meri document generation.
 *
 * These functions validate + normalize the model-supplied "document spec" into a
 * strict internal shape. They contain NO docx/exceljs/pptxgenjs imports and no
 * I/O, so they unit-test under the repo's `src/**.spec.ts` matcher. The
 * generation service (`meri-docgen.service.ts`) consumes these normalized specs
 * and produces the actual binary buffers.
 */

export type DocFormat = 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'txt';

export interface TextSpec {
  title: string;
  text: string;
}

export interface DocTable {
  /** Column header labels. */
  headers: string[];
  /** Body rows; each row is coerced to the header length. */
  rows: string[][];
}

export interface DocImage {
  /** PNG bytes, base64. Embedded at generation time (F4 analysis charts). */
  dataBase64: string;
}

export interface DocSection {
  heading: string;
  /** Paragraph blocks of prose. */
  paragraphs: string[];
  /** Bulleted list items. */
  bullets: string[];
  /** Optional tables in this section. */
  tables: DocTable[];
  /** Chart-artifact ids to embed (resolved to `images` by the tool layer). */
  imageArtifactIds: string[];
  /** Embedded images (resolved; also present in stored specs on re-render). */
  images: DocImage[];
}

export interface WordSpec {
  title: string;
  subtitle: string | null;
  sections: DocSection[];
}

export interface SheetSpec {
  name: string;
  headers: string[];
  rows: string[][];
}

export interface ExcelSpec {
  title: string;
  sheets: SheetSpec[];
}

export interface SlideSpec {
  title: string;
  bullets: string[];
  table: DocTable | null;
  /** Chart-artifact ids to embed (resolved to `images` by the tool layer). */
  imageArtifactIds: string[];
  /** Embedded images (resolved; also present in stored specs on re-render). */
  images: DocImage[];
}

export interface PptxSpec {
  title: string;
  subtitle: string | null;
  slides: SlideSpec[];
}

/** Caps so a misbehaving model can't blow up generation. */
export const MAX_DOC_TITLE = 200;
export const MAX_SECTIONS = 40;
export const MAX_PARAGRAPHS = 60;
export const MAX_BULLETS = 60;
export const MAX_TABLES = 20;
export const MAX_TABLE_ROWS = 500;
export const MAX_TABLE_COLS = 24;
export const MAX_SHEETS = 20;
export const MAX_SLIDES = 60;
export const MAX_CELL_CHARS = 8000;
export const MAX_IMAGES_PER_BLOCK = 4;
/** ~3MB of base64 ≈ 2.2MB PNG — matches the sandbox per-image cap. */
export const MAX_IMAGE_BASE64_CHARS = 3 * 1024 * 1024;
/** ~1MiB for plain text artifact payload. */
export const MAX_TEXT_BYTES = 1024 * 1024;

const UUID_ISH = /^[0-9a-fA-F-]{8,64}$/;

function imageIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && UUID_ISH.test(v.trim()))
    .map((v) => v.trim())
    .slice(0, MAX_IMAGES_PER_BLOCK);
}

function imageList(value: unknown): DocImage[] {
  if (!Array.isArray(value)) return [];
  const out: DocImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const data = (item as Record<string, unknown>).dataBase64;
    if (typeof data !== 'string' || !data || data.length > MAX_IMAGE_BASE64_CHARS) continue;
    out.push({ dataBase64: data });
    if (out.length >= MAX_IMAGES_PER_BLOCK) break;
  }
  return out;
}

function str(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const s = value.replace(/\u0000/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function strList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const s = str(item, maxChars);
    if (!s) continue;
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeTable(value: unknown): DocTable | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const headers = strList(v.headers, MAX_TABLE_COLS, MAX_CELL_CHARS);
  if (headers.length === 0) return null;
  const rawRows = Array.isArray(v.rows) ? v.rows : [];
  const rows: string[][] = [];
  for (const r of rawRows) {
    if (!Array.isArray(r)) continue;
    const cells: string[] = [];
    for (let c = 0; c < headers.length; c++) {
      cells.push(str(r[c], MAX_CELL_CHARS));
    }
    rows.push(cells);
    if (rows.length >= MAX_TABLE_ROWS) break;
  }
  return { headers, rows };
}

function normalizeTables(value: unknown): DocTable[] {
  if (!Array.isArray(value)) return [];
  const out: DocTable[] = [];
  for (const t of value) {
    const table = normalizeTable(t);
    if (table) out.push(table);
    if (out.length >= MAX_TABLES) break;
  }
  return out;
}

function normalizeSection(value: unknown): DocSection | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const heading = str(v.heading, MAX_DOC_TITLE);
  const paragraphs = strList(v.paragraphs, MAX_PARAGRAPHS, MAX_CELL_CHARS);
  const bullets = strList(v.bullets, MAX_BULLETS, MAX_CELL_CHARS);
  const tables = normalizeTables(v.tables);
  const imageArtifactIds = imageIdList(v.imageArtifactIds);
  const images = imageList(v.images);
  if (
    !heading &&
    paragraphs.length === 0 &&
    bullets.length === 0 &&
    tables.length === 0 &&
    imageArtifactIds.length === 0 &&
    images.length === 0
  ) {
    return null;
  }
  return { heading: heading || 'Section', paragraphs, bullets, tables, imageArtifactIds, images };
}

/** Validate + normalize a Word document spec. Throws if there's no usable content. */
export function normalizeWordSpec(input: unknown): WordSpec {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const title = str(v.title, MAX_DOC_TITLE, 'Document');
  const subtitle = str(v.subtitle, MAX_DOC_TITLE) || null;
  const rawSections = Array.isArray(v.sections) ? v.sections : [];
  const sections: DocSection[] = [];
  for (const s of rawSections) {
    const section = normalizeSection(s);
    if (section) sections.push(section);
    if (sections.length >= MAX_SECTIONS) break;
  }
  if (sections.length === 0) {
    throw new Error('Word spec has no usable sections');
  }
  return { title, subtitle, sections };
}

/** Validate + normalize an Excel workbook spec. Throws if there's no usable sheet. */
export function normalizeExcelSpec(input: unknown): ExcelSpec {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const title = str(v.title, MAX_DOC_TITLE, 'Workbook');
  const rawSheets = Array.isArray(v.sheets) ? v.sheets : [];
  const sheets: SheetSpec[] = [];
  const usedNames = new Set<string>();
  for (const s of rawSheets) {
    if (!s || typeof s !== 'object') continue;
    const sv = s as Record<string, unknown>;
    const headers = strList(sv.headers, MAX_TABLE_COLS, MAX_CELL_CHARS);
    const rawRows = Array.isArray(sv.rows) ? sv.rows : [];
    if (headers.length === 0 && rawRows.length === 0) continue;
    const rows: string[][] = [];
    const width = Math.max(headers.length, 1);
    for (const r of rawRows) {
      if (!Array.isArray(r)) continue;
      const cells: string[] = [];
      for (let c = 0; c < width; c++) cells.push(str(r[c], MAX_CELL_CHARS));
      rows.push(cells);
      if (rows.length >= MAX_TABLE_ROWS) break;
    }
    // Excel sheet names: <=31 chars, no []:*?/\ and must be unique.
    let name = str(sv.name, 31, `Sheet${sheets.length + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim();
    if (!name) name = `Sheet${sheets.length + 1}`;
    let unique = name;
    let n = 2;
    while (usedNames.has(unique.toLowerCase())) {
      unique = `${name.slice(0, 28)} ${n++}`;
    }
    usedNames.add(unique.toLowerCase());
    sheets.push({ name: unique, headers, rows });
    if (sheets.length >= MAX_SHEETS) break;
  }
  if (sheets.length === 0) {
    throw new Error('Excel spec has no usable sheets');
  }
  return { title, sheets };
}

/** Validate + normalize a PowerPoint deck spec. Throws if there's no usable slide. */
export function normalizePptxSpec(input: unknown): PptxSpec {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const title = str(v.title, MAX_DOC_TITLE, 'Presentation');
  const subtitle = str(v.subtitle, MAX_DOC_TITLE) || null;
  const rawSlides = Array.isArray(v.slides) ? v.slides : [];
  const slides: SlideSpec[] = [];
  for (const s of rawSlides) {
    if (!s || typeof s !== 'object') continue;
    const sv = s as Record<string, unknown>;
    const slideTitle = str(sv.title, MAX_DOC_TITLE);
    const bullets = strList(sv.bullets, MAX_BULLETS, MAX_CELL_CHARS);
    const table = normalizeTable(sv.table);
    const imageArtifactIds = imageIdList(sv.imageArtifactIds);
    const images = imageList(sv.images);
    if (!slideTitle && bullets.length === 0 && !table && !imageArtifactIds.length && !images.length)
      continue;
    slides.push({ title: slideTitle || 'Slide', bullets, table, imageArtifactIds, images });
    if (slides.length >= MAX_SLIDES) break;
  }
  if (slides.length === 0) {
    throw new Error('PowerPoint spec has no usable slides');
  }
  return { title, subtitle, slides };
}

/** Produce a filesystem-safe filename stem from a document title. */
export function slugifyDocName(title: string): string {
  const clean = (title || 'document')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return clean || 'document';
}

/** Validate text bytes for plain text artifacts.
 * - UTF8 fatal decode
 * - Reject binary NUL (U+0000) except allowed tab/CR/LF
 * - Reject control characters except normal tab (U+0009), CR (U+000D), LF (U+000A)
 * - Reject unpaired surrogates and invalid codepoints
 * - Allow exact bytes, no trimming/reformatting/newline insertion */
export function validateTextBytes(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > MAX_TEXT_BYTES) {
    throw new Error('text_size_invalid');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('text_encoding_invalid');
  }
  // Check for NUL bytes and invalid control characters
  // allowed: tab (0x09), LF (0x0A), CR (0x0D)
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i)!;
    const isControl = cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
    if (isControl) {
      if (cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) {
        throw new Error('text_invalid_control');
      }
    }
    // Advance for surrogate pairs
    if (cp > 0xffff) i += 1;
  }
  return text;
}

/** Validate + normalize a TextSpec. Throws if text is missing or invalid. */
export function normalizeTextSpec(input: unknown): TextSpec {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const title = str(v.title, MAX_DOC_TITLE, 'Text Document');
  const textRaw = v.text;
  if (typeof textRaw !== 'string' || !textRaw) {
    throw new Error('Text spec has no usable text');
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(textRaw);
  if (bytes.length > MAX_TEXT_BYTES) {
    throw new Error('text_size_exceeds_limit');
  }
  let text: string;
  try {
    text = validateTextBytes(bytes);
    if (text !== textRaw) throw new Error('text_unicode_invalid');
  } catch {
    throw new Error('text_content_invalid');
  }
  // Exact byte preservation: no trimming, no reformatting, no newline insertion
  return { title, text };
}

/** MIME type for a generated document format. */
export function mimeForFormat(format: DocFormat): string {
  switch (format) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'txt':
      return 'text/plain; charset=utf-8';
  }
}
