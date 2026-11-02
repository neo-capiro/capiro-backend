import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { load } from 'cheerio';
import { extractPdfText, type PdfTextItem } from '../meri/meri-attachment-extract.js';

export const BILL_EXTRACTION_VERSION = 'bill-structure-v1';
export type BillTable = { startOffset: number; endOffset: number; rows: string[][] };
export type BillStructuredSection = {
  locator: string;
  sourceLocator: string;
  number: string | null;
  heading: string | null;
  path: string[];
  text: string;
  startOffset: number;
  endOffset: number;
  tables: BillTable[];
  references: string[];
  definitionTerms: string[];
};
export type BillDocumentStructure = {
  parserVersion: typeof BILL_EXTRACTION_VERSION;
  completeness: 'complete' | 'partial' | 'unreadable';
  warnings: string[];
  text: string;
  textHash: string;
  structureHash: string;
  sections: BillStructuredSection[];
};
type Node = { name: string; text?: string; children: Node[]; attributes?: Record<string, string> };
type Context = {
  number: string | null;
  heading: string | null;
  path: string[];
  sourceLocator: string;
};
type Draft = Context & { text: string; tables: Array<{ text: string; rows: string[][] }> };
const structural = new Set([
  'section',
  'subsection',
  'paragraph',
  'subparagraph',
  'clause',
  'subclause',
  'article',
  'division',
  'part',
  'chapter',
  'subchapter',
]);
const blockTags = new Set([
  'p',
  'text',
  'quoted-block',
  'content',
  'div',
  'li',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
const labels = new Set(['num', 'enum', 'heading', 'header', 'designator']);
const ignored = new Set(['script', 'style', 'metadata', 'meta', 'head']);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** JSONB may reorder object keys; the derived identity is independent of serialization order. */
export function billStructureHash(
  value: Omit<BillDocumentStructure, 'structureHash'> | BillDocumentStructure,
): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .filter(([key]) => key !== 'structureHash')
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : item;
  return sha(JSON.stringify(canonical(value)));
}

function textOf(node: Node): string {
  if (ignored.has(node.name)) return '';
  return node.text ?? node.children.map(textOf).join('');
}
function xmlNodes(value: Array<Record<string, unknown>>): Node[] {
  return value.flatMap((item) =>
    Object.entries(item)
      .filter(([name]) => name !== ':@' && !name.startsWith('?'))
      .map(([name, child]) => ({
        name: name.toLowerCase().split(':').at(-1)!,
        ...(name === '#text' ? { text: String(child) } : {}),
        children: Array.isArray(child) ? xmlNodes(child) : [],
        attributes: item[':@'] as Record<string, string> | undefined,
      })),
  );
}
function htmlNodes(raw: string): Node[] {
  const $ = load(raw);
  type HtmlNode = {
    type: string;
    name?: string;
    data?: string;
    children?: HtmlNode[];
    attribs?: Record<string, string>;
  };
  const convert = (node: HtmlNode): Node => ({
    name: node.name?.toLowerCase() ?? node.type,
    text: node.type === 'text' ? node.data : undefined,
    children: (node.children ?? []).map(convert),
    attributes: node.attribs,
  });
  return ($.root()[0]?.children ?? []).map((node) => convert(node as HtmlNode));
}
function tableRows(node: Node): string[][] {
  const rows: string[][] = [];
  const visit = (n: Node) => {
    if (n.name === 'tr' || n.name === 'row') {
      const cells: string[] = [];
      const collect = (c: Node) => {
        if (['td', 'th', 'entry'].includes(c.name))
          cells.push(textOf(c).replace(/\s+/g, ' ').trim());
        else c.children.forEach(collect);
      };
      n.children.forEach(collect);
      if (cells.length) rows.push(cells);
    } else n.children.forEach(visit);
  };
  visit(node);
  return rows;
}

function finish(drafts: Draft[], warnings: string[] = [], partial = false): BillDocumentStructure {
  const sections: BillStructuredSection[] = [];
  let text = '';
  for (const draft of drafts) {
    const body = draft.text
      .replace(/ +\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!body) continue;
    if (text) text += '\n';
    const startOffset = text.length;
    text += body;
    let tableAfter = 0;
    const tables: BillTable[] = draft.tables.flatMap((table) => {
      const at = body.indexOf(table.text, tableAfter);
      if (at < 0) {
        warnings.push('TABLE_OFFSET_UNRESOLVED');
        return [];
      }
      tableAfter = at + table.text.length;
      return [{ startOffset: at, endOffset: tableAfter, rows: table.rows }];
    });
    const references = [
      ...new Set(
        [...body.matchAll(/\bsections?\s+([0-9][\w.-]*(?:\([a-z0-9]+\))*)/gi)]
          .filter((m) => !(draft.number && m.index === 0))
          .map((m) => m[1]!.replace(/\.+$/, '')),
      ),
    ];
    const definitionTerms = [
      ...new Set(
        [...body.matchAll(/["“]([^"”\n]{1,120})["”]\s+(?:means|includes)\b/gi)].map((m) => m[1]!),
      ),
    ];
    sections.push({
      ...draft,
      text: body,
      locator: `${draft.sourceLocator}#${sections.length}`,
      startOffset,
      endOffset: text.length,
      tables,
      references,
      definitionTerms,
    });
  }
  const result: Omit<BillDocumentStructure, 'structureHash'> = {
    parserVersion: BILL_EXTRACTION_VERSION,
    completeness: (!text
      ? 'unreadable'
      : partial || warnings.length > 0
        ? 'partial'
        : 'complete') as BillDocumentStructure['completeness'],
    warnings: [...new Set(warnings)],
    text,
    textHash: sha(text),
    sections,
  };
  return { ...result, structureHash: billStructureHash(result) };
}

/** Ordered markup traversal retains mixed inline text and table cells; raw bytes stay immutable. */
export function structureMarkup(raw: string, format: 'xml' | 'html'): BillDocumentStructure {
  if (format === 'xml' && XMLValidator.validate(raw) !== true)
    return finish([], ['XML_PARSE_FAILED']);
  let nodes: Node[];
  try {
    nodes =
      format === 'xml'
        ? xmlNodes(
            new XMLParser({
              preserveOrder: true,
              ignoreAttributes: false,
              trimValues: false,
              parseTagValue: false,
            }).parse(raw),
          )
        : htmlNodes(raw);
  } catch {
    return finish([], ['MARKUP_PARSE_FAILED']);
  }
  const drafts: Draft[] = [];
  const warnings: string[] = [];
  let current: Draft = {
    number: null,
    heading: null,
    path: [],
    sourceLocator: 'document',
    text: '',
    tables: [],
  };
  const flush = () => {
    if (current.text.trim()) drafts.push(current);
    current = { ...current, text: '', tables: [] };
  };
  const visit = (node: Node) => {
    if (ignored.has(node.name)) return;
    if (node.text !== undefined) {
      current.text += node.text.replace(/\s+/g, ' ');
      return;
    }
    if (structural.has(node.name)) {
      flush();
      const parent = current;
      const number = node.children.find((n) => ['num', 'enum', 'designator'].includes(n.name));
      const heading = node.children.find((n) => ['heading', 'header'].includes(n.name));
      const label = number ? textOf(number).trim() : null;
      const title = heading ? textOf(heading).trim() : null;
      const path = [...parent.path, label ?? `${node.name}:${drafts.length}`];
      current = {
        number: label,
        heading: title,
        path,
        sourceLocator:
          node.attributes?.['@_id'] ?? node.attributes?.id ?? `${node.name}:${path.join('/')}`,
        text: [label, title].filter(Boolean).join(' ') + '\n',
        tables: [],
      };
      node.children.filter((child) => !labels.has(child.name)).forEach(visit);
      flush();
      current = { ...parent, text: '', tables: [] };
      return;
    }
    if (/^h[1-6]$/.test(node.name)) {
      flush();
      const heading = textOf(node).replace(/\s+/g, ' ').trim();
      const number = /^(?:SEC(?:TION)?\.?|§)\s*([0-9]+[A-Za-z0-9.-]*)/i.exec(heading)?.[1] ?? null;
      current = {
        number,
        heading,
        path: [number ?? `heading:${drafts.length}`],
        sourceLocator: node.attributes?.id ?? `heading:${drafts.length}`,
        text: heading + '\n',
        tables: [],
      };
      return;
    }
    if (node.name === 'table') {
      const rows = tableRows(node);
      if (rows.length) {
        const text = rows.map((row) => row.join('\t')).join('\n');
        current.text += `\n${text}\n`;
        current.tables.push({ text, rows });
      } else {
        warnings.push('TABLE_STRUCTURE_UNAVAILABLE');
        node.children.forEach(visit);
      }
      return;
    }
    if (blockTags.has(node.name)) current.text += '\n';
    node.children.forEach(visit);
    if (blockTags.has(node.name)) current.text += '\n';
  };
  nodes.forEach(visit);
  flush();
  // Publisher HTML commonly has headings rather than legal <section> wrappers.
  if (
    format === 'html' &&
    warnings.length === 0 &&
    drafts.every((d) => d.path.length === 0) &&
    drafts.every((d) => !d.tables.length)
  )
    return structureText(drafts.map((d) => d.text).join('\n'));
  return finish(drafts, warnings);
}

/** Conservative section detection: no title/number is invented when plain text has none. */
export function structureText(
  raw: string,
  sourceLocator = 'document',
  prior?: Pick<Context, 'number' | 'heading' | 'path'>,
): BillDocumentStructure {
  const drafts: Draft[] = [];
  let context: Context = { number: null, heading: null, path: [], ...prior, sourceLocator };
  let body = '';
  const flush = () => {
    if (body.trim()) drafts.push({ ...context, text: body, tables: [] });
    body = '';
  };
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const section = /^\s*(?:SEC(?:TION)?\.?|§)\s*([0-9]+[A-Za-z0-9.-]*)[.\s]+(.*)$/i.exec(line);
    const subsection = /^\s*\(([A-Za-z0-9]{1,4})\)\s+(.+)$/.exec(line);
    if (section) {
      flush();
      context = {
        number: section[1]!.replace(/\.$/, ''),
        heading: section[2]!.trim() || null,
        path: [section[1]!.replace(/\.$/, '')],
        sourceLocator,
      };
    } else if (subsection && context.path.length) {
      flush();
      const label = subsection[1]!;
      const depth = /^\d+$/.test(label)
        ? 2
        : /^[A-Z]+$/.test(label)
          ? 3
          : /^[ivxlcdm]+$/.test(label) && context.path.length > 2
            ? 4
            : 1;
      context = {
        ...context,
        number: `(${label})`,
        heading: null,
        path: [...context.path.slice(0, depth), `(${label})`],
      };
    }
    body += line + '\n';
  }
  flush();
  return finish(drafts);
}

/** Native PDF geometry identifies rows and stable column boundaries without inferring missing cells. */
export function structurePdfPage(
  items: readonly PdfTextItem[],
  fallback: string,
  page: number,
  prior?: Pick<Context, 'number' | 'heading' | 'path'>,
): BillDocumentStructure {
  const visible = items.filter((item) => item.str?.trim());
  if (!visible.length || visible.some((item) => !item.transform || item.transform.length < 6))
    return finish(
      [
        {
          number: null,
          heading: null,
          path: [],
          ...prior,
          sourceLocator: `page:${page}`,
          text: fallback,
          tables: [],
        },
      ],
      ['PDF_LAYOUT_UNAVAILABLE'],
    );
  const rows: Array<{ y: number; items: PdfTextItem[] }> = [];
  for (const item of visible) {
    const y = item.transform![5]!;
    const row = rows.find((r) => Math.abs(r.y - y) <= 2);
    if (row) row.items.push(item);
    else rows.push({ y, items: [item] });
  }
  rows.sort((a, b) => b.y - a.y);
  const lines = rows.map((row) => {
    row.items.sort((a, b) => a.transform![4]! - b.transform![4]!);
    const cells: Array<{ x: number; text: string }> = [];
    let previousEnd = -Infinity;
    for (const item of row.items) {
      const x = item.transform![4]!;
      const gap = x - previousEnd;
      if (!cells.length || gap > Math.max(12, (item.height ?? 10) * 1.5))
        cells.push({ x, text: item.str! });
      else cells.at(-1)!.text += (gap > 1 ? ' ' : '') + item.str!;
      previousEnd = x + (item.width ?? 0);
    }
    return cells;
  });
  // Numbered bill PDFs print a narrow sequential margin before the legal text.
  // Remove only a run of at least four short consecutive line labels, never years/amount columns.
  const numbered = lines.filter(
    (line) =>
      line.length > 1 &&
      /^\d{1,2}$/.test(line[0]!.text.trim()) &&
      line[0]!.x < 80 &&
      line[1]!.text.trim().length >= 12,
  );
  const layoutWarnings: string[] = [];
  if (
    numbered.length >= 4 &&
    numbered.length >= lines.length * 0.6 &&
    numbered.every(
      (line, index) =>
        Math.abs(line[0]!.x - numbered[0]![0]!.x) <= 4 &&
        (index === 0 || Number(line[0]!.text) === Number(numbered[index - 1]![0]!.text) + 1),
    )
  ) {
    const legalHeading = numbered.some((line) =>
      /^(?:SEC(?:TION)?\.?|§)\s*\d+|^Be it enacted\b/i.test(line[1]!.text.trim()),
    );
    if (!legalHeading) layoutWarnings.push('PDF_AMBIGUOUS_NUMBERED_COLUMNS');
    const marginX = numbered[0]![0]!.x;
    for (const line of lines)
      if (
        legalHeading &&
        line.length > 1 &&
        /^\d{1,2}$/.test(line[0]!.text.trim()) &&
        Math.abs(line[0]!.x - marginX) <= 4
      )
        line.shift();
  }
  const drafts: Draft[] = [];
  let text = '';
  let context = prior;
  const flushText = () => {
    if (text.trim())
      for (const section of structureText(text, `page:${page}`, context).sections) {
        drafts.push({ ...section, tables: [] });
        context = { number: section.number, heading: section.heading, path: section.path };
      }
    text = '';
  };
  for (let i = 0; i < lines.length;) {
    const start = i;
    const first = lines[i]!;
    const aligns = (line: typeof first) =>
      first.length > 1 &&
      line.length === first.length &&
      line.every((cell, index) => Math.abs(cell.x - first[index]!.x) <= 8);
    while (i + 1 < lines.length && aligns(lines[i + 1]!)) i++;
    if (i > start && first.length > 1) {
      flushText();
      const rows = lines.slice(start, i + 1).map((line) => line.map((cell) => cell.text.trim()));
      const rendered = rows.map((row) => row.join('\t')).join('\n');
      drafts.push({
        number: null,
        heading: null,
        path: [],
        ...context,
        sourceLocator: `page:${page}`,
        text: rendered,
        tables: [{ text: rendered, rows }],
      });
    } else text += first.map((cell) => cell.text).join(' ') + '\n';
    i++;
  }
  flushText();
  return finish(drafts, layoutWarnings);
}

export async function extractBillDocumentStructure(
  bytes: Buffer,
  mime: string,
): Promise<BillDocumentStructure> {
  if (mime.startsWith('text/') || mime === 'application/xml' || mime === 'application/xhtml+xml') {
    if (bytes.toString('utf8').includes('\uFFFD'))
      return finish([], ['DOCUMENT_TEXT_ENCODING_UNQUALIFIED']);
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml')
    return structureMarkup(bytes.toString('utf8'), 'html');
  if (mime === 'text/xml' || mime === 'application/xml')
    return structureMarkup(bytes.toString('utf8'), 'xml');
  if (mime === 'text/plain') return structureText(bytes.toString('utf8'));
  if (mime !== 'application/pdf' || bytes.subarray(0, 5).toString() !== '%PDF-')
    return finish([], ['UNSUPPORTED_DOCUMENT_FORMAT']);
  const layouts = new Map<number, readonly PdfTextItem[]>();
  const pages: BillDocumentStructure[] = [];
  let context: Pick<Context, 'number' | 'heading' | 'path'> | undefined;
  const result = await extractPdfText(bytes, {
    limits: { pages: 500, characters: 2_000_000 },
    preserveLineBreaks: true,
    onPageLayout: (page, items, truncated) => layouts.set(page, truncated ? [] : items),
    onPage: (page, text) => {
      const structured = structurePdfPage(layouts.get(page) ?? [], text, page, context);
      // Truncated pages receive no geometry, so omitted text cannot be reconstructed.
      pages.push(structured);
      const last = structured.sections.at(-1);
      if (last) context = { number: last.number, heading: last.heading, path: last.path };
      layouts.delete(page);
    },
  });
  const drafts = pages.flatMap((page) =>
    page.sections.map((section) => ({
      ...section,
      tables: section.tables.map((table) => ({
        text: section.text.slice(table.startOffset, table.endOffset),
        rows: table.rows,
      })),
    })),
  );
  return finish(
    drafts,
    [
      ...pages.flatMap((page) => page.warnings),
      ...(result.unreadablePages.length ? ['PDF_UNREADABLE_PAGES'] : []),
      ...(result.truncated ? ['PDF_EXTRACTION_TRUNCATED'] : []),
    ],
    result.truncated || result.unreadablePages.length > 0,
  );
}
