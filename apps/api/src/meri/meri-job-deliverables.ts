import JSZip from 'jszip';
import {
  normalizeExcelSpec,
  normalizePptxSpec,
  normalizeWordSpec,
  type DocTable,
  type ExcelSpec,
  type PptxSpec,
  type WordSpec,
} from './meri-docgen.helpers.js';
import type { MeriJobDeliverable, MeriJobKind } from './meri-job.js';

/**
 * Stage 2 deliverables (program plan §5.3). A deliverable job asks for one
 * Office document: Word (Release B), Excel or PowerPoint (Release C). The file
 * is rendered on demand from the job's authorized report, so it is never
 * readable once the report itself would be withheld, and nothing derived from
 * the report is stored.
 */
export const MAX_JOB_DELIVERABLES = 1;
export const RENDERABLE_DELIVERABLE_FORMATS = ['docx', 'xlsx', 'pptx'] as const;
export type RenderableDeliverableFormat = (typeof RENDERABLE_DELIVERABLE_FORMATS)[number];

export const DELIVERABLE_MIME: Record<RenderableDeliverableFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function isRenderableDeliverableFormat(
  value: unknown,
): value is RenderableDeliverableFormat {
  return (RENDERABLE_DELIVERABLE_FORMATS as readonly unknown[]).includes(value);
}

export class MeriJobDeliverableRequestError extends Error {}

/** The deliverables a new job records; empty for every kind but `deliverable`. */
export function requestedJobDeliverables(
  kind: MeriJobKind,
  raw: unknown,
  fallbackTitle: string,
): MeriJobDeliverable[] {
  if (kind !== 'deliverable') {
    if (raw !== undefined && !(Array.isArray(raw) && raw.length === 0))
      throw new MeriJobDeliverableRequestError('Only a deliverable job can request deliverables.');
    return [];
  }
  const requested = raw === undefined ? [{ format: 'docx' }] : raw;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_JOB_DELIVERABLES)
    throw new MeriJobDeliverableRequestError(
      `A deliverable job requests exactly ${MAX_JOB_DELIVERABLES} document.`,
    );
  return requested.map((entry) => {
    const row =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    if (!isRenderableDeliverableFormat(row.format))
      throw new MeriJobDeliverableRequestError(
        'Deliverables are Word (docx), Excel (xlsx) or PowerPoint (pptx) documents.',
      );
    const title =
      typeof row.title === 'string' && row.title.trim() ? row.title.trim() : fallbackTitle;
    return { format: row.format, title: title.slice(0, 200), artifactId: null };
  });
}

/** Markdown emphasis, links and code markers become plain text for Office text runs. */
function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export interface ReportSection {
  heading: string;
  paragraphs: string[];
  bullets: string[];
  tables: DocTable[];
}

const TABLE_LINE = /^\|.*\|$/;
const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/;

function tableCells(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => plain(cell.replace(/\\\|/g, '|')));
}

/** A markdown pipe table: the first row is the header; the separator row is dropped. */
function parseTable(lines: string[]): DocTable | null {
  const rows = lines.filter((line) => !TABLE_SEPARATOR.test(line)).map(tableCells);
  const headers = rows.shift();
  if (!headers || headers.every((cell) => !cell)) return null;
  return {
    headers,
    rows: rows.map((row) => headers.map((_, index) => row[index] ?? '')),
  };
}

/**
 * A research report's markdown as ordered sections of paragraphs, list items
 * and pipe tables. One parse feeds every format, so Word, Excel and PowerPoint
 * carry the same text.
 */
export function reportSections(title: string, markdown: string): ReportSection[] {
  const sections: ReportSection[] = [];
  let current: ReportSection = { heading: 'Summary', paragraphs: [], bullets: [], tables: [] };
  let paragraph: string[] = [];
  let table: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) current.paragraphs.push(paragraph.join(' '));
    paragraph = [];
  };
  const flushTable = () => {
    const parsed = table.length ? parseTable(table) : null;
    if (parsed) current.tables.push(parsed);
    table = [];
  };
  const flushSection = () => {
    flushParagraph();
    flushTable();
    if (current.paragraphs.length || current.bullets.length || current.tables.length)
      sections.push(current);
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (TABLE_LINE.test(line)) {
      flushParagraph();
      table.push(line);
      continue;
    }
    flushTable();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flushSection();
      const text = plain(heading[1]!);
      // The report's own top heading repeats the document title.
      current = {
        heading: text.toLowerCase() === title.trim().toLowerCase() ? 'Summary' : text,
        paragraphs: [],
        bullets: [],
        tables: [],
      };
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      const text = plain(bullet[1]!);
      if (text) current.bullets.push(text);
      continue;
    }
    if (!line || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushParagraph();
      continue;
    }
    const text = plain(line.replace(/^>\s?/, ''));
    if (text) paragraph.push(text);
  }
  flushSection();
  return sections;
}

/** A research report as a Word document spec (headings, paragraphs, lists, tables). */
export function researchReportWordSpec(title: string, markdown: string): WordSpec {
  return normalizeWordSpec({
    title,
    subtitle: null,
    sections: reportSections(title, markdown).map((section) => ({
      ...section,
      imageArtifactIds: [],
      images: [],
    })),
  });
}

/**
 * A research report as a workbook: each report table is a sheet named after
 * its section, followed by a "Report" sheet with every paragraph and list item
 * under its section, so no report text is left out of the file.
 */
export function researchReportExcelSpec(title: string, markdown: string): ExcelSpec {
  const sections = reportSections(title, markdown);
  const sheets: Array<{ name: string; headers: string[]; rows: string[][] }> = [];
  for (const section of sections) {
    section.tables.forEach((table, index) =>
      sheets.push({
        name: section.tables.length > 1 ? `${section.heading} ${index + 1}` : section.heading,
        headers: table.headers,
        rows: table.rows,
      }),
    );
  }
  const text = sections.flatMap((section) => [
    ...section.paragraphs.map((paragraph) => [section.heading, paragraph]),
    ...section.bullets.map((bullet) => [section.heading, `• ${bullet}`]),
  ]);
  if (text.length) sheets.push({ name: 'Report', headers: ['Section', 'Text'], rows: text });
  return normalizeExcelSpec({ title, sheets });
}

// One slide holds about 1,300 characters at 12 pt (docgen sizes the text down
// from 16 pt as a slide fills), so a section continues only past that.
const SLIDE_TEXT_BUDGET = 1_300;
const SLIDE_MAX_BULLETS = 8;
const SLIDE_MAX_TABLE_ROWS = 10;
const SOURCES_PER_SLIDE = 12;
const SOURCE_LABEL_CHARS = 90;
const SOURCES_HEADING = /^(?:sources?(?:\s+consulted)?|references|citations)$/i;
const PROVENANCE_LINE = /^(?:deep research report\b|topic:)/i;

/** Splits a long paragraph at sentence ends so a slide never truncates report text. */
function slideItems(text: string): string[] {
  const limit = SLIDE_TEXT_BUDGET / 2;
  if (text.length <= limit) return [text];
  const sentences = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()) ?? [text];
  const items: string[] = [];
  let current = '';
  for (const sentence of sentences.filter(Boolean)) {
    if (current && current.length + sentence.length + 1 > limit) {
      items.push(current);
      current = sentence;
    } else current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) items.push(current);
  return items;
}

/** "[7] Name — long description" becomes "[7] Name" for the slide face. */
function sourceLabel(entry: string): string {
  const head = entry.split(/\s+[—–]\s+|\s+-\s+/)[0]!.trim();
  return head.length > SOURCE_LABEL_CHARS ? `${head.slice(0, SOURCE_LABEL_CHARS - 1)}…` : head;
}

type DeckSlide = { title: string; bullets: string[]; table: DocTable | null; notes?: string };

/**
 * A research report as a deck. The report's provenance lines (generated date,
 * the request) become the title slide's subtitle instead of a slide. Each
 * section is one slide, continued only when its text passes what 12 pt holds.
 * Each table gets its own slides, ten rows each. The source register shows
 * short labels, twelve per slide, with every full entry in the speaker notes.
 * No paragraph or list item is dropped: everything is on a slide or in its notes.
 */
export function researchReportPptxSpec(title: string, markdown: string): PptxSpec {
  const slides: DeckSlide[] = [];
  let subtitle: string | null = null;
  let titleNotes: string | null = null;
  const titled = (heading: string) =>
    slides.some((slide) => slide.title === heading) ? `${heading} (cont.)` : heading;
  for (const [index, section] of reportSections(title, markdown).entries()) {
    let paragraphs = section.paragraphs;
    // The assembled report opens with its own top heading (the report's title,
    // which may differ from the deliverable's) and the provenance lines. Read
    // them by position: T12's second run titled its report differently and
    // the provenance became a slide (session 0f4a4df2, 2026-10-07).
    if (index === 0) {
      const provenance = paragraphs.filter((paragraph) => PROVENANCE_LINE.test(paragraph));
      const generated = provenance.find((line) => /^deep research report\b/i.test(line));
      if (generated) subtitle = generated;
      const topic = provenance.find((line) => /^topic:/i.test(line));
      paragraphs = paragraphs.filter((paragraph) => !PROVENANCE_LINE.test(paragraph));
      if (
        provenance.length &&
        !paragraphs.length &&
        !section.bullets.length &&
        !section.tables.length
      ) {
        // The title slide carries the date; the request itself goes in its notes.
        if (topic) titleNotes = topic;
        continue;
      }
    }
    if (SOURCES_HEADING.test(section.heading)) {
      const entries = [...section.bullets, ...paragraphs];
      for (let start = 0; start < entries.length; start += SOURCES_PER_SLIDE) {
        const page = entries.slice(start, start + SOURCES_PER_SLIDE);
        slides.push({
          title: titled(section.heading),
          bullets: page.map(sourceLabel),
          table: null,
          notes: page.join('\n'),
        });
      }
      continue;
    }
    const items = [...paragraphs, ...section.bullets].flatMap(slideItems);
    let page: string[] = [];
    let size = 0;
    const flush = () => {
      if (!page.length) return;
      slides.push({ title: titled(section.heading), bullets: page, table: null });
      page = [];
      size = 0;
    };
    for (const item of items) {
      if (
        page.length >= SLIDE_MAX_BULLETS ||
        (page.length && size + item.length > SLIDE_TEXT_BUDGET)
      )
        flush();
      page.push(item);
      size += item.length;
    }
    flush();
    for (const table of section.tables) {
      for (let start = 0; start < Math.max(table.rows.length, 1); start += SLIDE_MAX_TABLE_ROWS) {
        slides.push({
          title: titled(section.heading),
          bullets: [],
          table: {
            headers: table.headers,
            rows: table.rows.slice(start, start + SLIDE_MAX_TABLE_ROWS),
          },
        });
      }
    }
  }
  return normalizePptxSpec({
    title,
    subtitle,
    ...(titleNotes ? { titleNotes } : {}),
    slides: slides.map((slide) => ({ ...slide, imageArtifactIds: [], images: [] })),
  });
}

export function deliverableFileName(
  title: string,
  format: RenderableDeliverableFormat = 'docx',
): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return `${base || 'Meri deliverable'}.${format}`;
}

export class MeriDeliverableReadBackError extends Error {}

const MAIN_PART: Record<RenderableDeliverableFormat, { path: string; root: RegExp }> = {
  docx: { path: 'word/document.xml', root: /<w:document\b/ },
  xlsx: { path: 'xl/workbook.xml', root: /<workbook\b/ },
  pptx: { path: 'ppt/presentation.xml', root: /<p:presentation\b/ },
};

/** The text content of an XML part, entities decoded. */
function xmlText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Reads produced bytes back before they are served or filed: ZIP magic, the
 * Office container's content types and main part, and the expected count of
 * parts (Word title text, Excel sheets, PowerPoint slides including the title
 * slide). Throws MeriDeliverableReadBackError on any mismatch.
 */
export async function readBackDeliverable(
  format: RenderableDeliverableFormat,
  buffer: Buffer,
  expected: { title: string; sheets?: number; slides?: number },
): Promise<{ bytes: number; parts: number }> {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50)
    throw new MeriDeliverableReadBackError(`${format}: not a ZIP container`);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new MeriDeliverableReadBackError(`${format}: the container does not open`);
  }
  const main = MAIN_PART[format];
  const types = zip.file('[Content_Types].xml');
  const part = zip.file(main.path);
  if (!types || !part) throw new MeriDeliverableReadBackError(`${format}: missing ${main.path}`);
  const xml = await part.async('string');
  if (!main.root.test(xml))
    throw new MeriDeliverableReadBackError(`${format}: unreadable main part`);
  let parts = 1;
  if (format === 'docx') {
    if (!xmlText(xml).includes(expected.title))
      throw new MeriDeliverableReadBackError('docx: the title is not in the document');
  } else if (format === 'xlsx') {
    parts = zip.file(/^xl\/worksheets\/sheet\d+\.xml$/).length;
    if (parts !== expected.sheets)
      throw new MeriDeliverableReadBackError(`xlsx: ${parts} sheets, expected ${expected.sheets}`);
  } else {
    parts = zip.file(/^ppt\/slides\/slide\d+\.xml$/).length;
    if (parts !== expected.slides)
      throw new MeriDeliverableReadBackError(`pptx: ${parts} slides, expected ${expected.slides}`);
  }
  return { bytes: buffer.length, parts };
}
