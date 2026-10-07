/**
 * Bill-text navigation for Meri (Neo, 2026-10-06): find provisions inside one
 * stored bill version, and find which bills contain words or a phrase. Both
 * read the immutable federal evidence owner; nothing here writes.
 */

/**
 * Characters one read_bill_text page returns. The orchestrator shows the model
 * at most 12,000 characters of a tool result and strips a larger result down
 * to its metadata, so a page plus its identity fields must stay below that.
 */
export const BILL_TEXT_PAGE_CHARS = 9_000;
/** Characters around a match that a located passage returns. */
export const BILL_TEXT_PASSAGE_CHARS = 1_000;
/** Passages one located read returns; with metadata it stays under 12,000 characters. */
export const MAX_BILL_TEXT_PASSAGES = 6;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

// "SEC. 1234." / "Sec. 102." / "SECTION 5." at a line start, the usual statutory heading.
const SECTION_HEADING_RE = /(?:^|\n)[ \t]*((?:SEC(?:TION)?|Sec)\.?[ \t]+\d+[A-Za-z0-9-]*\.?[^\n]{0,160})/g;

export interface BillTextQueryTerms {
  phrases: string[];
  terms: string[];
}

/** Quoted phrases stay whole; other words become terms (stop words and 1-2 letter words dropped). */
export function parseBillTextQuery(query: string): BillTextQueryTerms {
  const phrases: string[] = [];
  const rest = query.replace(/"([^"]{2,200})"/g, (_match, phrase: string) => {
    const normalized = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized) phrases.push(normalized);
    return ' ';
  });
  const terms = [
    ...new Set(
      rest
        .toLowerCase()
        .split(/[^a-z0-9.§-]+/)
        .map((term) => term.replace(/^[.-]+|[.-]+$/g, ''))
        .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
    ),
  ];
  return { phrases: [...new Set(phrases)], terms };
}

export interface LocatedBillTextPassage {
  startOffset: number;
  endOffset: number;
  heading: string | null;
  matchedTerms: string[];
}

function sectionHeadings(text: string): Array<{ offset: number; heading: string }> {
  const headings: Array<{ offset: number; heading: string }> = [];
  for (const match of text.matchAll(SECTION_HEADING_RE)) {
    const heading = match[1]!.trim().replace(/\s+/g, ' ');
    headings.push({ offset: (match.index ?? 0) + match[0].indexOf(match[1]!), heading });
  }
  return headings;
}

function headingBefore(
  headings: ReadonlyArray<{ offset: number; heading: string }>,
  offset: number,
): string | null {
  let low = 0;
  let high = headings.length - 1;
  let found: string | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (headings[mid]!.offset <= offset) {
      found = headings[mid]!.heading;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/**
 * The best non-overlapping passages for a query inside one bill version.
 * A window scores by distinct query parts present (a phrase counts double),
 * then by hit count; ties keep document order. Deterministic for a given
 * text and query, so a re-checked read reproduces it exactly.
 */
export function locateBillTextPassages(
  text: string,
  query: string,
  limit = MAX_BILL_TEXT_PASSAGES,
): { passages: LocatedBillTextPassage[]; totalHits: number; parts: string[] } {
  const { phrases, terms } = parseBillTextQuery(query);
  const parts = [...phrases, ...terms];
  if (!parts.length || !text) return { passages: [], totalHits: 0, parts };
  const lower = text.toLowerCase();
  const hits: Array<{ offset: number; part: string; weight: number }> = [];
  for (const part of parts) {
    const weight = phrases.includes(part) ? 2 : 1;
    let at = lower.indexOf(part);
    let count = 0;
    while (at >= 0 && count < 5_000) {
      hits.push({ offset: at, part, weight });
      count += 1;
      at = lower.indexOf(part, at + part.length);
    }
  }
  if (!hits.length) return { passages: [], totalHits: 0, parts };
  hits.sort((left, right) => left.offset - right.offset);
  const half = Math.floor(BILL_TEXT_PASSAGE_CHARS / 2);
  const candidates = hits.map((hit) => {
    const start = Math.max(0, Math.min(hit.offset - half, text.length - BILL_TEXT_PASSAGE_CHARS));
    const end = Math.min(text.length, start + BILL_TEXT_PASSAGE_CHARS);
    const inside = hits.filter((other) => other.offset >= start && other.offset < end);
    const distinct = new Map(inside.map((other) => [other.part, other.weight]));
    const score =
      [...distinct.values()].reduce((sum, weight) => sum + weight, 0) * 1_000 + inside.length;
    return { start, end, anchor: hit.offset, score, matchedTerms: [...distinct.keys()] };
  });
  candidates.sort((left, right) => right.score - left.score || left.start - right.start);
  const chosen: typeof candidates = [];
  for (const candidate of candidates) {
    if (chosen.length >= limit) break;
    if (chosen.some((other) => candidate.start < other.end && other.start < candidate.end)) continue;
    chosen.push(candidate);
  }
  const headings = sectionHeadings(text);
  return {
    passages: chosen
      .sort((left, right) => left.start - right.start)
      .map((candidate) => ({
        startOffset: candidate.start,
        endOffset: candidate.end,
        // The section that contains the match, not the one the window starts in.
        heading: headingBefore(headings, candidate.anchor),
        matchedTerms: candidate.matchedTerms,
      })),
    totalHits: hits.length,
    parts,
  };
}

/** The read_bill_text continuation for one exact revision, starting at `offset`. */
export function billTextCursor(
  billId: string,
  versionCode: string,
  revisionId: string,
  extractionHash: string,
  offset: number,
): string {
  return Buffer.from(
    JSON.stringify([billId, versionCode, revisionId, extractionHash, offset]),
  ).toString('base64url');
}

/**
 * Passages of current bill versions that match a web-style query
 * (`"exact phrase"`, `or`, `-exclude`), best first, at most two per bill.
 * Windows overlap by 400 characters, so a phrase never falls between two.
 *
 * Paged by BILL: `$3` bills per page from offset `$4`, ranked by each bill's
 * best passage. Every row carries `totalBills`, the exact number of matching
 * bills (the window count runs before LIMIT), so a caller can say how many
 * there are and page through all of them.
 */
export const BILL_TEXT_PASSAGE_SEARCH_SQL = `
WITH q AS (SELECT websearch_to_tsquery('english', $1) AS query),
hits AS (
  SELECT p.revision_id, p.start_offset, p.end_offset, ts_rank_cd(p.tsv, q.query) AS rank
    FROM federal_evidence_passage p, q
   WHERE p.tsv @@ q.query
),
current_bills AS (
  SELECT c.revision_id, c.bill_id, c.version_code
    FROM federal_evidence_current c
   WHERE c.state = 'present' AND c.collection = 'BILLS'
     AND c.bill_id IS NOT NULL AND c.version_code IS NOT NULL
     AND ($2::int IS NULL OR c.bill_id LIKE $2::int || '-%')
),
ranked AS (
  SELECT cur.bill_id, cur.version_code, cur.revision_id, h.start_offset, h.end_offset, h.rank,
         row_number() OVER (PARTITION BY cur.bill_id ORDER BY h.rank DESC, h.start_offset) AS rn
    FROM hits h JOIN current_bills cur ON cur.revision_id = h.revision_id
),
bills AS (
  SELECT bill_id, max(rank) AS best_rank FROM ranked GROUP BY bill_id
),
page AS (
  SELECT bill_id, best_rank, count(*) OVER () AS total_bills
    FROM bills ORDER BY best_rank DESC, bill_id LIMIT $3 OFFSET $4
),
best AS (
  SELECT r.*, p.best_rank, p.total_bills
    FROM ranked r JOIN page p ON p.bill_id = r.bill_id
   WHERE r.rn <= 2
)
SELECT b.bill_id AS "billId", b.version_code AS "versionCode", b.revision_id AS "revisionId",
       r.extraction_hash AS "extractionHash", b.start_offset AS "startOffset",
       b.end_offset AS "endOffset", b.rank::float8 AS "rank", b.total_bills::int AS "totalBills",
       ts_headline('english', substr(r.extracted_text, b.start_offset + 1, b.end_offset - b.start_offset),
                   q.query, 'MaxFragments=1, MaxWords=35, MinWords=12, StartSel="«", StopSel="»"') AS "snippet",
       cb.title AS "title"
  FROM best b
  JOIN federal_evidence_revision r ON r.id = b.revision_id
  LEFT JOIN congress_bill cb ON cb.id = b.bill_id
  CROSS JOIN q
 ORDER BY b.best_rank DESC, b.bill_id, b.rank DESC, b.start_offset`;

export interface BillTextSearchRow {
  billId: string;
  versionCode: string;
  revisionId: string;
  extractionHash: string;
  startOffset: number;
  endOffset: number;
  rank: number;
  /** Matching bills across all pages (absent on rows from older callers). */
  totalBills?: number;
  snippet: string;
  title: string | null;
}

/** Group passage rows by bill, keeping rank order, with a cursor to read on from each passage. */
export function groupBillTextSearchRows(rows: readonly BillTextSearchRow[]) {
  const bills = new Map<
    string,
    {
      billId: string;
      title: string | null;
      versionCode: string;
      passages: Array<{ snippet: string; startOffset: number; readCursor: string | null }>;
    }
  >();
  for (const row of rows) {
    const bill = bills.get(row.billId) ?? {
      billId: row.billId,
      title: row.title,
      versionCode: row.versionCode,
      passages: [],
    };
    bill.passages.push({
      snippet: row.snippet.replace(/\s+/g, ' ').trim(),
      startOffset: row.startOffset,
      readCursor:
        row.startOffset > 0
          ? billTextCursor(
              row.billId,
              row.versionCode,
              row.revisionId,
              row.extractionHash,
              row.startOffset,
            )
          : null,
    });
    bills.set(row.billId, bill);
  }
  return [...bills.values()];
}

export const BILL_TEXT_BILLS_PER_PAGE = 8;
export const BILL_TEXT_MAX_BILLS_PER_PAGE = 10;
/**
 * The orchestrator projects any tool result over 12,000 characters down to a
 * few rows and metadata, which showed the model a partial list with a total
 * that disagreed with it. A text-search page stays under this budget whole.
 */
export const BILL_TEXT_RESPONSE_BUDGET = 10_500;

/**
 * One page of a bill-text search as the tool returns it: bills best first, an
 * exact `totalBills`, and the page to ask for next. If the page would exceed
 * the response budget, second passages go first, then the lowest-ranked bills,
 * and the response says so.
 */
export function billTextSearchResponse(
  rows: readonly BillTextSearchRow[],
  request: { textQuery: string; page: number; perPage: number; generatedAt: string },
) {
  const results = groupBillTextSearchRows(rows);
  const listed = results.length;
  const totalBills = rows.length
    ? (rows[0]!.totalBills ?? null)
    : request.page === 1
      ? 0
      : null;
  const build = (omittedBills: number, morePassages: boolean) => {
    const shown = (request.page - 1) * request.perPage + listed;
    const hasMore = totalBills !== null && shown < totalBills;
    const notes = [
      results.length
        ? 'Bills whose stored text matches, best first, with matching passages (« » marks the match). Read a passage in context with read_bill_text and its readCursor. Stored text covers 119th-Congress bills.'
        : request.page > 1
          ? 'No more matching bills on this page.'
          : 'No stored bill text matches. Stored text covers 119th-Congress bills; try other wording before concluding no bill addresses the topic.',
      ...(totalBills !== null && totalBills > 0
        ? [`${totalBills} bill${totalBills === 1 ? '' : 's'} match in all.${hasMore ? ` Ask for page ${request.page + 1} for more.` : ''}`]
        : []),
      ...(morePassages
        ? ['Only the best passage is shown for some bills; read_bill_text with the bill and query finds the rest.']
        : []),
      ...(omittedBills
        ? [`${omittedBills} lower-ranked bill${omittedBills === 1 ? ' on this page was' : 's on this page were'} left out to fit; narrow the query or ask with a smaller limit to see ${omittedBills === 1 ? 'it' : 'them'}.`]
        : []),
    ];
    return {
      tool: 'search_congress_bills',
      generatedAt: request.generatedAt,
      mode: 'bill_text',
      textQuery: request.textQuery,
      results,
      total: results.length,
      totalBills,
      page: request.page,
      perPage: request.perPage,
      hasMore,
      ...(hasMore ? { nextPage: request.page + 1 } : {}),
      ...(omittedBills ? { omittedBills } : {}),
      note: notes.join(' '),
    };
  };
  let morePassages = false;
  let response = build(0, false);
  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (JSON.stringify(response).length <= BILL_TEXT_RESPONSE_BUDGET) return response;
    if (results[index]!.passages.length > 1) {
      results[index]!.passages.length = 1;
      morePassages = true;
      response = build(0, morePassages);
    }
  }
  let omitted = 0;
  while (results.length > 1 && JSON.stringify(response).length > BILL_TEXT_RESPONSE_BUDGET) {
    results.pop();
    omitted += 1;
    response = build(omitted, morePassages);
  }
  return response;
}
