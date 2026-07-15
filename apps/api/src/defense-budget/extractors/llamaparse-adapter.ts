/**
 * Adapter: raw LlamaParse job JSON -> normalized ParsedPage[] the extractors consume.
 *
 * LlamaParse "json" result shape (v1) looks like:
 *   { pages: [ { page: 1, md: "...", text: "...", items: [
 *       { type: "heading"|"text", value/md, ... },
 *       { type: "table", rows: [[...],[...]], csv?: "...", md?: "..." } ] } ] }
 *
 * We defensively normalize because LlamaParse fields drift across versions. Tables are
 * pulled from `items[type=table].rows`; when only markdown tables exist we parse GitHub
 * pipe tables out of the page markdown. Header row is separated from body rows.
 */
import type { ParsedPage, ParsedTable } from './rdte.extractor.types.js';

interface RawItem {
  type?: string;
  rows?: unknown;
  md?: string;
  value?: string;
  label?: string;
  title?: string;
}
interface RawPage {
  page?: number;
  pageNumber?: number;
  printedPage?: string;
  md?: string;
  text?: string;
  items?: RawItem[];
}
interface RawJson {
  pages?: RawPage[];
}

function toStringMatrix(rows: unknown): string[][] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => Array.isArray(r))
    .map((r) => (r as unknown[]).map((c) => (c == null ? '' : String(c).trim())));
}

/** Parse GitHub-style pipe tables out of markdown as a fallback when no structured table exists. */
export function parseMarkdownTables(md: string): ParsedTable[] {
  const out: ParsedTable[] = [];
  const lines = md.split(/\r?\n/);
  let block: string[] = [];
  const flush = () => {
    if (block.length >= 2) {
      const rows = block
        .map((l) => l.trim())
        .filter((l) => l.startsWith('|'))
        .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
      // Drop the separator row (---|---).
      const body = rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''));
      if (body.length >= 1) {
        const header = body[0];
        out.push({ header, rows: body.slice(1) });
      }
    }
    block = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith('|')) block.push(line);
    else flush();
  }
  flush();
  return out;
}

export function adaptLlamaParseJson(json: unknown, opts?: { markdownFallback?: string }): ParsedPage[] {
  const raw = (json ?? {}) as RawJson & { markdown?: string };
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  const out: ParsedPage[] = [];

  for (const p of pages) {
    const pdfPage = p.page ?? p.pageNumber ?? out.length + 1;
    const md = p.md ?? p.text ?? '';
    const tables: ParsedTable[] = [];

    const items = Array.isArray(p.items) ? p.items : [];
    for (const it of items) {
      if (it.type === 'table') {
        const matrix = toStringMatrix(it.rows);
        if (matrix.length > 0) {
          tables.push({ label: it.label ?? it.title, header: matrix[0], rows: matrix.slice(1) });
        } else if (it.md) {
          tables.push(...parseMarkdownTables(it.md));
        }
      }
    }
    // Fallback: parse markdown pipe tables when no structured table items were present.
    if (tables.length === 0 && md) tables.push(...parseMarkdownTables(md));

    out.push({ pdfPage, printedPage: p.printedPage, markdown: md, tables });
  }

  // LlamaParse v1 commonly returns a single { markdown, job_metadata } object (no `pages`).
  // Split that markdown on PDF page boundaries ("\n---\n") so per-page provenance is real.
  const wholeMd = raw.markdown ?? opts?.markdownFallback;
  if (out.length === 0 && wholeMd) {
    const chunks = wholeMd.split(/\n-{3,}\n/);
    chunks.forEach((chunk, i) => {
      const trimmed = chunk.trim();
      if (!trimmed) return;
      out.push({
        pdfPage: i + 1,
        printedPage: extractPrintedPage(trimmed),
        markdown: trimmed,
        tables: parseMarkdownTables(trimmed),
      });
    });
  }
  return out;
}

/** Pull a printed page label like "Volume 1a - 117" or "R-1 Line #5" from a page's text. */
function extractPrintedPage(md: string): string | undefined {
  const vol = /Volume\s+[\w-]+\s*-\s*[ivxlcdm\d]+/i.exec(md);
  if (vol) return vol[0].trim();
  const line = /R-1 Line #\d+/i.exec(md);
  return line ? line[0] : undefined;
}
