/**
 * budget-doc-watch — pure logic for the watch-budget-docs verb (PE Watch
 * auto-update plan, Phase 1; docs/plans/2026-07-06-pe-watch-auto-update-plan.md).
 *
 * Everything here is deterministic and side-effect free so it can be spec'd:
 * link extraction from publisher index HTML, budget-document classification,
 * dedupe-key derivation, known-set diffing, and alert-email rendering. The
 * script (scripts/watch-budget-docs.ts) owns fetch/Prisma/SES wiring.
 */

export type BudgetDocType =
  | 'r1'
  | 'p1'
  | 'p1r'
  | 'o1'
  | 'm1'
  | 'c1'
  | 'rf1'
  | 'fy_index'
  | 'committee_report'
  | 'jbook_detail'
  | 'other';

export interface ExtractedLink {
  href: string;
  text: string;
}

export interface DetectedDoc {
  /** Stable identity for "have we alerted on this before" (see dedupeKeyForUrl). */
  dedupeKey: string;
  url: string;
  title: string;
  /** comptroller | secnav | saffm | congress.gov */
  publisher: string;
  docType: BudgetDocType;
  fiscalYear: number | null;
  /** false when the publisher blocks non-browser clients (manual download needed). */
  fetchable: boolean;
  loaderHint: string;
}

export interface RevisedDoc {
  dedupeKey: string;
  sourceKey: string;
  url: string;
  priorSha256: string;
  newSha256: string;
  loaderHint: string;
}

/**
 * Extract anchor links from static publisher HTML. Regex-based on purpose:
 * these are server-rendered .gov pages with plain <a href> tags (verified for
 * comptroller.war.gov) and apps/api carries no HTML-parser dependency.
 */
export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawHref = m[1]?.trim();
    if (!rawHref || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) continue;
    let href: string;
    try {
      href = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }
    const text = (m[2] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ href, text });
  }
  return out;
}

/** Normalized URL identity: lowercase host, no query/hash, decoded once. */
export function dedupeKeyForUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, '');
    return `${u.hostname.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

const COMPTROLLER_EXHIBITS: Record<string, BudgetDocType> = {
  r1: 'r1',
  p1: 'p1',
  p1r: 'p1r',
  o1: 'o1',
  m1: 'm1',
  c1: 'c1',
  rf1: 'rf1',
};

/**
 * Classify a comptroller.war.gov link. Returns null for non-budget links
 * (nav, press, .aspx chrome other than FY index pages).
 *
 * Patterns (verified live 2026-07-06):
 *   /Portals/45/Documents/defbudget/FY2027/FY2027_r1.pdf      -> r1
 *   /Portals/45/Documents/defbudget/FY2027/r1_display.xlsx    -> r1 (xlsx variant)
 *   /budgetmaterials/budget2028.aspx                          -> fy_index (new PB cycle!)
 *   any other pdf/xlsx under /defbudget/FY####/               -> jbook_detail
 */
export function classifyComptrollerLink(
  href: string,
  text: string,
): { docType: BudgetDocType; fiscalYear: number | null } | null {
  const lower = href.toLowerCase();

  const fyIndex = lower.match(/\/budgetmaterials\/budget(\d{4})\.aspx$/);
  if (fyIndex) return { docType: 'fy_index', fiscalYear: Number(fyIndex[1]) };

  const defbudget = lower.match(/\/defbudget\/fy(\d{4})\//);
  if (!defbudget) return null;
  const fiscalYear = Number(defbudget[1]);

  if (!/\.(pdf|xlsx)$/.test(lower)) return null;

  const file = lower.split('/').pop() ?? '';
  const exhibit =
    file.match(/^fy\d{4}_([a-z0-9]+)\.pdf$/)?.[1] ?? file.match(/^([a-z0-9]+)_display\.xlsx$/)?.[1];
  if (exhibit && COMPTROLLER_EXHIBITS[exhibit]) {
    return { docType: COMPTROLLER_EXHIBITS[exhibit], fiscalYear };
  }
  void text;
  return { docType: 'jbook_detail', fiscalYear };
}

/**
 * Classify a service FM-site link (secnav/saffm index pages). Only PDFs count.
 * Fiscal year from the "NNpres" path convention (e.g. /27pres/ -> 2027) or a
 * 4-digit year segment; null when neither is present.
 */
export function classifyServiceLink(
  href: string,
): { docType: BudgetDocType; fiscalYear: number | null } | null {
  const lower = href.toLowerCase();
  if (!lower.endsWith('.pdf')) return null;
  const pres = lower.match(/\/(\d{2})pres\//);
  const year4 = lower.match(/\/(20\d{2})\//);
  const fiscalYear = pres ? 2000 + Number(pres[1]) : year4 ? Number(year4[1]) : null;
  return { docType: 'jbook_detail', fiscalYear };
}

/** Human runbook hint: which loader chain applies to a detected document. */
export function loaderHintFor(docType: BudgetDocType, publisher: string): string {
  switch (docType) {
    case 'r1':
      return 'R-1 master list: extract_jbook_r1.py -> sync-comptroller-jbooks (update scripts/__config__/comptroller-document-urls.yaml first)';
    case 'p1':
    case 'p1r':
      return 'P-1 procurement: extract_pdoc.py -> parse-pdoc / load-pdoc-enrichment';
    case 'o1':
      return 'O-1 O&M: load-om (pe_code=<account><line>, O-1 is $K)';
    case 'committee_report':
      return 'Committee report: extract_armed_services_report.py -> parse-hasc-report/parse-sasc-report (armed services) or parse-hac-d-report/parse-sac-d-report (approps); NDAA conference -> extract_ndaa_funding_tables.py -> parse-ndaa-conference';
    case 'fy_index':
      return 'NEW FISCAL-YEAR BUDGET PAGE — a PB cycle is starting: update comptroller-document-urls.yaml and plan the ingest wave (see plan Phase 4)';
    case 'jbook_detail':
      return `J-book detail volume (${publisher}): extract_jbook_r2.py / extract_jbook_performers.py -> sync-jbook-r2 / sync-jbook-performers`;
    case 'm1':
    case 'c1':
    case 'rf1':
      return 'Not currently ingested (M-1/C-1/RF-1) — informational; MILCON is a money-graph roadmap line_type';
    default:
      return 'Unclassified budget document — triage manually';
  }
}

/**
 * The comptroller index links EVERY historical fiscal-year archive page
 * (budget2027 … budget2006). We only care about the current PB cycle and the
 * one immediately prior (prior-year exhibits still get revised during the
 * conference/enacted window). Given the fiscal years of all discovered
 * fy_index links, decide which FY pages to crawl and which years count as a
 * real fy_index detection.
 *
 *   crawlFloor  = maxFy - 1  → crawl current + prior cycle only
 *   detectFloor = maxFy      → a page is a "new PB cycle" detection only if it
 *                              is the current max or newer (so a future
 *                              budget2028 appearing fires; the archive never does)
 */
export function budgetCyclePlan(fiscalYears: number[]): {
  maxFy: number | null;
  crawlFloor: number;
  detectFloor: number;
} {
  const valid = fiscalYears.filter((y) => Number.isFinite(y));
  if (valid.length === 0) return { maxFy: null, crawlFloor: 0, detectFloor: 0 };
  const maxFy = Math.max(...valid);
  return { maxFy, crawlFloor: maxFy - 1, detectFloor: maxFy };
}

/** New detections = current inventory minus everything already known. */
export function diffNew(current: DetectedDoc[], knownKeys: Set<string>): DetectedDoc[] {
  const seen = new Set<string>();
  const out: DetectedDoc[] = [];
  for (const doc of current) {
    if (knownKeys.has(doc.dedupeKey) || seen.has(doc.dedupeKey)) continue;
    seen.add(doc.dedupeKey);
    out.push(doc);
  }
  return out;
}

/** Congress committee-report citation -> stable dedupe key ('crpt:h-rept-119-123'). */
export function dedupeKeyForReport(citation: string): string {
  return `crpt:${citation.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/** Defense relevance filter for full-committee approps report listings. */
export function isDefenseRelevantReportTitle(title: string): boolean {
  return /\b(defense|military construction|intelligence authorization|ndaa|armed services)\b/i.test(
    title,
  );
}

export function renderDetectionEmail(
  newDocs: DetectedDoc[],
  revised: RevisedDoc[],
): { subject: string; text: string; html: string } {
  const total = newDocs.length + revised.length;
  const subject = `Budget-doc watch: ${total} new/changed document${total === 1 ? '' : 's'} detected`;

  const lines: string[] = [];
  for (const d of newDocs) {
    lines.push(
      `NEW [${d.docType}${d.fiscalYear ? ` FY${d.fiscalYear}` : ''}] ${d.title || d.url}`,
      `  url: ${d.url}`,
      `  publisher: ${d.publisher}${d.fetchable ? '' : '  (MANUAL BROWSER DOWNLOAD REQUIRED — publisher blocks bots)'}`,
      `  next: ${d.loaderHint}`,
      '',
    );
  }
  for (const r of revised) {
    lines.push(
      `REVISED ${r.sourceKey}`,
      `  url: ${r.url}`,
      `  sha256 ${r.priorSha256.slice(0, 12)}… -> ${r.newSha256.slice(0, 12)}…`,
      `  next: re-run its loader chain (${r.loaderHint}); the registry will version-chain the prior head`,
      '',
    );
  }
  const text = lines.join('\n');

  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = (badge: string, title: string, url: string, hint: string, warn?: string): string =>
    `<tr><td style="padding:6px 10px;vertical-align:top"><strong>${esc(badge)}</strong></td>` +
    `<td style="padding:6px 10px"><div>${esc(title)}</div>` +
    `<div><a href="${esc(url)}">${esc(url)}</a></div>` +
    (warn ? `<div style="color:#b45309">${esc(warn)}</div>` : '') +
    `<div style="color:#555">${esc(hint)}</div></td></tr>`;
  const htmlRows = [
    ...newDocs.map((d) =>
      row(
        `NEW ${d.docType}${d.fiscalYear ? ` FY${d.fiscalYear}` : ''}`,
        d.title || d.url,
        d.url,
        d.loaderHint,
        d.fetchable ? undefined : 'Manual browser download required — publisher blocks bots',
      ),
    ),
    ...revised.map((r) =>
      row('REVISED', r.sourceKey, r.url, `sha changed — re-run loader chain (${r.loaderHint})`),
    ),
  ].join('');
  const html =
    `<p>The budget-document watcher detected <strong>${total}</strong> new/changed document${total === 1 ? '' : 's'}.</p>` +
    `<table style="border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px">${htmlRows}</table>` +
    `<p style="color:#777;font-size:12px">watch-budget-docs · PE Watch Phase 1 · dedupe-keyed, re-runs will not repeat this alert</p>`;

  return { subject, text, html };
}
