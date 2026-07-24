/**
 * Stage D: LLM-free provenance retrieval over a context document's markdown.
 *
 * PURE module — no Nest, no Prisma, no I/O, and deliberately NO LLM: refs are
 * resolved by exact line-level string mechanics so a citation can always be
 * re-derived deterministically from the stored content.
 *
 * REF FORMAT (STABLE — Stage E emits these refs into sp_context_fact rows, so
 * changing it is a data migration, not a refactor):
 *   - 'heading:<exact heading text>'  — an ATX (#..######) section.
 *   - 'row:<exact heading text of the nearest preceding heading>:<1-based
 *     data-row index>' — one table row; the row index counts DATA rows only
 *     (header + |---| separator excluded), within the FIRST table under that
 *     heading.
 *
 * DUPLICATE HEADINGS: refs must be unique, so repeated heading text gets a
 * deterministic '#2', '#3', ... suffix in DOCUMENT ORDER (first occurrence is
 * unsuffixed, second is 'heading:Title#2', and row refs under it use
 * 'row:Title#2:<n>'). Deterministic because document order is.
 *
 * LINE NUMBERS are 1-based within the string passed in (the service passes the
 * FULL stored content including the frontmatter block, so line numbers align
 * with the persisted document).
 */

export interface SectionLocation {
  ref: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
}

export interface TableLocation {
  /** 'table:<heading ref suffix-part>' — unique per document (see below). */
  ref: string;
  /** The ref of the nearest preceding heading ('heading:...'), or 'heading:' if none. */
  sectionRef: string;
  headerCells: string[];
  rowCount: number;
  /** 1-based line of the table's header row. */
  startLine: number;
}

export interface LocateAllResult {
  sections: SectionLocation[];
  tables: TableLocation[];
}

export interface LocateResult {
  ref: string;
  kind: 'heading' | 'row';
  content: string;
  startLine: number;
  endLine: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

interface InternalTable {
  headingKey: string; // suffixed heading text ('' if no preceding heading)
  headerLine: number; // 0-based index of the header row
  headerCells: string[];
  dataRowLines: number[]; // 0-based indexes of data rows
}

function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

interface Scan {
  lines: string[];
  sections: Array<{ key: string; heading: string; level: number; start: number; end: number }>;
  tables: InternalTable[];
}

/** One deterministic pass: headings (with duplicate suffixing) + tables. */
function scan(body: string): Scan {
  const lines = body.split(/\r?\n/);

  const seen = new Map<string, number>();
  const sections: Scan['sections'] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i] ?? '');
    if (!m) continue;
    const heading = m[2] ?? '';
    const n = (seen.get(heading) ?? 0) + 1;
    seen.set(heading, n);
    const key = n === 1 ? heading : `${heading}#${n}`;
    sections.push({ key, heading, level: m[1]!.length, start: i, end: lines.length - 1 });
  }
  // A section runs to the line before the NEXT heading of ANY level (flat
  // sectioning — provenance cites the immediate block, not nested subtrees).
  for (let s = 0; s < sections.length; s++) {
    const next = sections[s + 1];
    if (next) sections[s]!.end = next.start - 1;
  }

  const tables: InternalTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!TABLE_ROW.test(lines[i] ?? '') || !TABLE_SEPARATOR.test(lines[i + 1] ?? '')) continue;
    // Nearest preceding heading (suffixed key), if any.
    let headingKey = '';
    for (let s = sections.length - 1; s >= 0; s--) {
      if (sections[s]!.start < i) {
        headingKey = sections[s]!.key;
        break;
      }
    }
    const dataRowLines: number[] = [];
    let j = i + 2;
    while (j < lines.length && TABLE_ROW.test(lines[j] ?? '') && !TABLE_SEPARATOR.test(lines[j] ?? '')) {
      dataRowLines.push(j);
      j++;
    }
    tables.push({ headingKey, headerLine: i, headerCells: splitCells(lines[i] ?? ''), dataRowLines });
    i = j - 1; // skip past this table
  }

  return { lines, sections, tables };
}

/** Enumerate every section and table with its stable ref. */
export function locateAll(body: string): LocateAllResult {
  const { sections, tables } = scan(body);

  const sectionsOut: SectionLocation[] = sections.map((s) => ({
    ref: `heading:${s.key}`,
    heading: s.heading,
    level: s.level,
    startLine: s.start + 1,
    endLine: s.end + 1,
  }));

  // Multiple tables under one heading get the same deterministic '#2' style
  // suffix on the TABLE ref ('table:Heading#2'); row refs always resolve to
  // the FIRST table under the heading (the pack has one table per section).
  const perHeading = new Map<string, number>();
  const tablesOut: TableLocation[] = tables.map((t) => {
    const n = (perHeading.get(t.headingKey) ?? 0) + 1;
    perHeading.set(t.headingKey, n);
    const suffix = n === 1 ? '' : `#${n}`;
    return {
      ref: `table:${t.headingKey}${suffix}`,
      sectionRef: `heading:${t.headingKey}`,
      headerCells: t.headerCells,
      rowCount: t.dataRowLines.length,
      startLine: t.headerLine + 1,
    };
  });

  return { sections: sectionsOut, tables: tablesOut };
}

/**
 * Resolve one stable ref to its exact content + 1-based line span.
 * Returns null for an unknown/unresolvable ref (the caller 404s).
 *
 * Row content is the raw data-row line followed by the table's header row
 * (column context), separated by '\n'; start/endLine point at the DATA row.
 */
export function locate(body: string, ref: string): LocateResult | null {
  const { lines, sections, tables } = scan(body);

  if (ref.startsWith('heading:')) {
    const key = ref.slice('heading:'.length);
    const s = sections.find((x) => x.key === key);
    if (!s) return null;
    return {
      ref,
      kind: 'heading',
      content: lines.slice(s.start, s.end + 1).join('\n'),
      startLine: s.start + 1,
      endLine: s.end + 1,
    };
  }

  if (ref.startsWith('row:')) {
    // 'row:<heading key>:<1-based index>' — the heading key may itself contain
    // ':' so split on the LAST colon.
    const rest = ref.slice('row:'.length);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon <= 0) return null;
    const headingKey = rest.slice(0, lastColon);
    const index = Number(rest.slice(lastColon + 1));
    if (!Number.isInteger(index) || index < 1) return null;
    const table = tables.find((t) => t.headingKey === headingKey); // FIRST table under the heading
    if (!table) return null;
    const rowLineIdx = table.dataRowLines[index - 1];
    if (rowLineIdx === undefined) return null;
    return {
      ref,
      kind: 'row',
      content: `${lines[rowLineIdx] ?? ''}\n${lines[table.headerLine] ?? ''}`,
      startLine: rowLineIdx + 1,
      endLine: rowLineIdx + 1,
    };
  }

  return null;
}
