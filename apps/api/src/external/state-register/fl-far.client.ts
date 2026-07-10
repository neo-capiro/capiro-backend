/**
 * Florida Administrative Register (FAR) client — Phase 1 M3.2, the FIRST
 * (and, per the M3.2 feasibility spike, ONLY currently-verified) state
 * register adapter. flrules.org is classic server-rendered ASP with no API/
 * feed — every field below was confirmed by fetching REAL live pages
 * (`View_notice.asp?id=...`, `QuickResult.asp?P0=Stat_Prop_All...`) and
 * inspecting the actual HTML, not guessed from documentation. Uses cheerio
 * (not regex) because the real markup is inconsistently quoted
 * (`class=notice_text` vs `class="notice_text"`, `id=textarea2` unquoted) —
 * exactly the kind of markup regex silently mis-parses.
 *
 * Scope, stated plainly (never silently missing):
 * - PROPOSED rules only for v1 (Stat_Prop_All listing). Emergency rules
 *   (`emergencyRules.asp`) have a verified-different field layout (no
 *   register citation, a direct effective-date field) and are deferred
 *   until that page is spiked separately — NOT built blind.
 * - `effectiveDate` is left null for every proposed-rule notice: FL doesn't
 *   publish it on the notice page for an ordinary amendment — only on the
 *   rule's own history page (`RuleNo.asp?id=<ruleNumber>`), a second
 *   chained fetch this v1 does not make. Documented gap, not a guess.
 * - A notice amending MULTIPLE rules is stored once, keyed to the FIRST
 *   rule row (the register-level entity is the notice; finer per-rule
 *   granularity is a P2 nice-to-have, not a data-integrity issue).
 */
import * as cheerio from 'cheerio';

const BASE_URL = 'https://flrules.org';
const USER_AGENT = 'Capiro-Ingestion-Bot/1.0 (+https://capiro.ai)';

export interface FlFarListingRow {
  noticeId: string;
  ruleNumber: string | null;
  /** YYYY-MM-DD */
  publishDate: string | null;
}

export interface FlFarListingPage {
  rows: FlFarListingRow[];
  totalFound: number | null;
  hasNextPage: boolean;
}

export interface FlFarNoticeDetail {
  noticeId: string;
  /** Raw text, e.g. "Notice of Proposed Rule" — used for ruleType classification. */
  noticeType: string | null;
  department: string | null;
  division: string | null;
  ruleNumber: string | null;
  ruleTitle: string | null;
  purpose: string | null;
  summary: string | null;
  /** YYYY-MM-DD */
  publishDate: string | null;
  registerCitation: string | null;
  /** YYYY-MM-DD */
  commentStartDate: string | null;
  /** YYYY-MM-DD */
  commentEndDate: string | null;
}

/** "7/10/2026" -> "2026-07-10". Null-safe; never throws on a malformed date. */
export function parseMdyDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
}

function textOf($el: cheerio.Cheerio<never>): string {
  return $el.text().replace(/\s+/g, ' ').trim();
}

/** Parse one page of the QuickResult.asp listing (proposed-rule notices). */
export function parseFlFarListingPage(html: string): FlFarListingPage {
  const $ = cheerio.load(html);
  const rows: FlFarListingRow[] = [];
  $('table.tabDisplay > tbody > tr, table.tabDisplay > tr').each((_, tr) => {
    const $tr = $(tr);
    const idAnchor = $tr.find('a.id');
    if (!idAnchor.length) return;
    const href = idAnchor.attr('href') ?? '';
    const idMatch = href.match(/id=(\d+)/);
    if (!idMatch) return;
    const ruleNumber = textOf($tr.find('a.RuleNumber') as cheerio.Cheerio<never>) || null;
    // textOf() already flattens the <br> between the date and "Vol. N/N"
    // into a single space, so pull the date out with a regex rather than
    // assuming it's the whole string (or splitting on a newline that no
    // longer exists post-flatten).
    const publishRaw = textOf($tr.find('a.PublishDate') as cheerio.Cheerio<never>);
    const publishDate = parseMdyDate(publishRaw.match(/(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1] ?? null);
    rows.push({ noticeId: idMatch[1]!, ruleNumber, publishDate });
  });

  const totalMatch = $('body')
    .text()
    .match(/Total number found:\s*(\d+)/i);
  const totalFound = totalMatch ? Number(totalMatch[1]) : null;
  const hasNextPage = $('a').filter((_, a) => /^NEXT/i.test($(a).text().trim())).length > 0;

  return { rows, totalFound, hasNextPage };
}

/** Parse one notice detail page (View_notice.asp?id=...). */
export function parseFlFarNoticeDetail(html: string, noticeId: string): FlFarNoticeDetail {
  const $ = cheerio.load(html);

  // Notice type: the row right after the "Notice: <id>" header row — a
  // single notice_text td spanning both columns (colspan=2), distinguishing
  // it from the two-column field rows below.
  let noticeType: string | null = null;
  $('td.HeaderGrayBar').each((_, el) => {
    if (!/Notice:\s*\d+/.test($(el).text())) return;
    const $typeRow = $(el).closest('tr').next('tr');
    const text = textOf($typeRow.find('td.notice_text') as cheerio.Cheerio<never>);
    if (text) noticeType = text;
  });

  const fields = new Map<string, string>();
  let ruleNumber: string | null = null;
  let ruleTitle: string | null = null;
  $('td.field_header').each((_, el) => {
    const $label = $(el);
    const label = textOf($label as cheerio.Cheerio<never>)
      .replace(/:$/, '')
      .trim()
      .toUpperCase();
    if (!label) return;
    const $value = $label.next('td');
    if (label === 'RULE') {
      ruleNumber = textOf($value.find('a.FX_Link_ID') as cheerio.Cheerio<never>) || null;
      ruleTitle = textOf($value.find('td.results') as cheerio.Cheerio<never>) || null;
      return;
    }
    fields.set(label, textOf($value as cheerio.Cheerio<never>));
  });

  const publishRaw = (fields.get('PRINT PUBLISH DATE') ?? '').match(
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
  )?.[1];
  const citationMatch = (fields.get('PRINT PUBLISH DATE') ?? '').match(/(Vol\.\s*\d+\/\d+)/i);
  const commentsRaw = fields.get('COMMENTS') ?? '';
  const commentDates = [...commentsRaw.matchAll(/(\d{1,2}\/\d{1,2}\/\d{4})/g)].map((m) => m[1]);

  return {
    noticeId,
    noticeType,
    department: fields.get('DEPARTMENT') || null,
    division: fields.get('DIVISION') || null,
    ruleNumber,
    ruleTitle,
    purpose: fields.get('PURPOSE') || null,
    summary: fields.get('SUMMARY') || null,
    publishDate: parseMdyDate(publishRaw ?? null),
    registerCitation: citationMatch?.[1] ?? null,
    commentStartDate: parseMdyDate(commentDates[0] ?? null),
    commentEndDate: parseMdyDate(commentDates[1] ?? null),
  };
}

export interface StateRuleUpsertInput {
  id: string;
  state: string;
  agency: string;
  title: string;
  abstract: string | null;
  ruleType: string;
  docketId: string | null;
  registerCitation: string | null;
  publicationDate: string;
  commentStartDate: string | null;
  commentEndDate: string | null;
  effectiveDate: string | null;
  sourceUrl: string;
}

/**
 * Map a parsed notice to the StateRule upsert shape, or null when a
 * required field (rule title, publication date) is missing — never
 * fabricated, the row is simply skipped and logged by the caller.
 */
export function toStateRuleInput(detail: FlFarNoticeDetail): StateRuleUpsertInput | null {
  if (!detail.ruleTitle || !detail.publishDate) return null;
  const agency =
    [detail.department, detail.division].filter(Boolean).join(' — ') || 'Unknown agency';
  const noticeTypeLower = (detail.noticeType ?? '').toLowerCase();
  const ruleType = /emergency/.test(noticeTypeLower)
    ? 'emergency'
    : /adopted|final/.test(noticeTypeLower)
      ? 'final'
      : 'proposed';
  return {
    id: `FL-${detail.noticeId}`,
    state: 'FL',
    agency,
    title: detail.ruleTitle,
    abstract: [detail.purpose, detail.summary].filter(Boolean).join('\n\n') || null,
    ruleType,
    docketId: detail.noticeId,
    registerCitation: detail.registerCitation,
    publicationDate: detail.publishDate,
    commentStartDate: detail.commentStartDate,
    commentEndDate: detail.commentEndDate,
    effectiveDate: null, // documented gap — see file header
    sourceUrl: `${BASE_URL}/Gateway/View_notice.asp?id=${detail.noticeId}`,
  };
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} (non-retryable)`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchFlFarListingPage(page: number): Promise<FlFarListingPage> {
  const url = `${BASE_URL}/notice/QuickResult.asp?P0=Stat_Prop_All&P1=0&P2=169&page=${page}`;
  return parseFlFarListingPage(await fetchWithRetry(url));
}

export async function fetchFlFarNoticeDetail(noticeId: string): Promise<FlFarNoticeDetail> {
  const url = `${BASE_URL}/Gateway/View_notice.asp?id=${encodeURIComponent(noticeId)}`;
  return parseFlFarNoticeDetail(await fetchWithRetry(url), noticeId);
}
