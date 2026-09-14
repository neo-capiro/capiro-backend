/** Florida notices, all linked rules and bounded tracked-rule history.

 * Discovery remains the proposed-notice listing; each other family reports its qualified scope.

 * Notice identity, publication, filing, effective and observed dates remain distinct. */

import * as cheerio from 'cheerio';

import { createHash } from 'node:crypto';

import { validDateOnly } from '@capiro/shared';

import { fetchPublisherBytes } from './publisher-fetch.js';

const BASE_URL = 'https://flrules.org';

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
  rules: Array<{ number: string; title: string | null; sourceUrl: string }>;

  filingDate: string | null;

  effectiveDate: string | null;

  rawDates: Record<string, string>;

  originalHtml: string;

  contentHash: string;

  parserVersion: string;

  linkedNotices: string[];

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

  const value = `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;

  return validDateOnly(value) ? value : null;
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

  const rules: FlFarNoticeDetail['rules'] = [];

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
      $value.find('a.FX_Link_ID').each((_, a) => {
        const number = $(a).text().trim();

        const sourceUrl = publisherLink($(a).attr('href'));

        if (!/^[A-Za-z0-9]+-\d+[A-Za-z0-9.-]*\.\d+$/.test(number) || !sourceUrl) return;

        const row = $(a).closest('tr');

        const title = row.find('td.results').last().text().replace(/\s+/g, ' ').trim() || null;

        if (!rules.some((r) => r.number === number)) rules.push({ number, title, sourceUrl });
      });

      ruleNumber = rules[0]?.number ?? null;

      ruleTitle = rules[0]?.title ?? null;

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
    rules,

    filingDate: parseMdyDate(fields.get('RULE FILE DATE')),

    effectiveDate: parseMdyDate(fields.get('RULE EFFECTIVE DATE')),

    rawDates: Object.fromEntries([...fields].filter(([key]) => /DATE|COMMENTS/.test(key))),

    originalHtml: html,

    contentHash: createHash('sha256').update(html).digest('hex'),

    parserVersion: 'fl-far-notice-v2',

    linkedNotices: [
      ...new Set(
        $('a[href]')
          .toArray()
          .map((a) => publisherLink($(a).attr('href')))
          .filter((u): u is string => Boolean(u && /view_notice\.asp\?id=\d+/i.test(u))),
      ),
    ],

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
  noticeEvidence?: FlFarNoticeDetail;

  id: string;
  state: string;
  agency: string;
  title: string;
  abstract: string | null;
  ruleType: string;
  docketId: string | null;
  registerCitation: string | null;

  publicationDate: string | null;

  filingDate: string | null;

  linkedRuleNumbers: string[];

  sourceRevision: string;

  commentStartDate: string | null;
  commentEndDate: string | null;
  effectiveDate: string | null;
  sourceUrl: string;
}

/**
 * Map a parsed notice to the StateRule upsert shape, or null when a

 * required title or all source dates are missing — never

 * fabricated, the row is simply skipped and logged by the caller.
 */
export function toStateRuleInput(detail: FlFarNoticeDetail): StateRuleUpsertInput | null {
  if (!detail.ruleTitle || (!detail.publishDate && !detail.filingDate && !detail.effectiveDate))
    return null;

  const agency =
    [detail.department, detail.division].filter(Boolean).join(' — ') || 'Unknown agency';

  const ruleType = classifyFlNotice(detail.noticeType);

  return {
    noticeEvidence: detail,

    id: `FL-${detail.noticeId}`,
    state: 'FL',
    agency,
    title: detail.ruleTitle,
    abstract: [detail.purpose, detail.summary].filter(Boolean).join('\n\n') || null,
    ruleType,
    docketId: detail.noticeId,
    registerCitation: detail.registerCitation,
    publicationDate: detail.publishDate,

    filingDate: detail.filingDate,

    linkedRuleNumbers: detail.rules.map((r) => r.number),

    sourceRevision: detail.contentHash,

    commentStartDate: detail.commentStartDate,
    commentEndDate: detail.commentEndDate,

    effectiveDate: detail.effectiveDate,

    sourceUrl: `${BASE_URL}/Gateway/View_notice.asp?id=${detail.noticeId}`,
  };
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchPublisherBytes(url, ['flrules.org', 'www.flrules.org']);

      if (result.contentType !== 'text/html') throw Error('FAR_INVALID_BODY');

      return result.bytes.toString('utf8');
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
  if (!/^\d{1,12}$/.test(noticeId)) throw Error('INVALID_NOTICE_ID');

  const url = `${BASE_URL}/Gateway/View_notice.asp?id=${encodeURIComponent(noticeId)}`;

  const detail = parseFlFarNoticeDetail(await fetchWithRetry(url), noticeId);

  if (
    !new RegExp(`Notice:\\s*${noticeId}\\b`).test(
      cheerio.load(detail.originalHtml)('body').text(),
    ) ||
    !detail.noticeType
  )
    throw Error('FAR_NOTICE_IDENTITY_OR_LAYOUT_UNQUALIFIED');

  return detail;
}

export function classifyFlNotice(raw: string | null): string {
  const value = (raw ?? '').toLowerCase();

  if (/withdraw/.test(value)) return 'withdrawal';

  if (/correct/.test(value)) return 'correction';

  if (/change/.test(value)) return 'change';

  if (/development/.test(value)) return 'development';

  if (/emergency/.test(value)) return 'emergency';

  if (/final adopted|adopted version/.test(value)) return 'final';

  if (/proposed rule/.test(value)) return 'proposed';

  if (/meeting|hearing|workshop/.test(value)) return 'meeting';

  return 'unknown';
}

export function publisherLink(href: string | undefined): string | null {
  try {
    const url = new URL(href ?? '', BASE_URL);
    if (
      !href ||
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !['flrules.org', 'www.flrules.org'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

export function parseFlRuleHistory(html: string, ruleNumber: string) {
  const $ = cheerio.load(html);

  const notices = parseFlFarListingPage(html);

  const attachments = $('a[href]')
    .toArray()
    .map((a) => ({ url: publisherLink($(a).attr('href')), label: $(a).text().trim() }))
    .filter((a): a is { url: string; label: string } =>
      Boolean(a.url && /\/(?:readFile|textdownload|notice_Files)\.asp/i.test(a.url)),
    );

  return {
    ruleNumber,
    notices,
    attachments,
    originalHtml: html,
    contentHash: createHash('sha256').update(html).digest('hex'),
    parserVersion: 'fl-fac-history-v1',
    complete: !notices.hasNextPage,
    coverage: 'history_and_publisher_links_only',
  };
}

export async function fetchFlRuleHistory(ruleNumber: string) {
  if (!/^[A-Za-z0-9]+-\d+[A-Za-z0-9.-]*\.\d+$/.test(ruleNumber)) throw Error('INVALID_RULE_NUMBER');

  return parseFlRuleHistory(
    await fetchWithRetry(`${BASE_URL}/gateway/RuleNo.asp?id=${encodeURIComponent(ruleNumber)}`),
    ruleNumber,
  );
}
