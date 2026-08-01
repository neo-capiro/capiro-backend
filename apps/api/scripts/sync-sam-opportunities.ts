/**
 * SAM.gov federal contract-opportunities ingestion + review-gated matching.
 *
 *   pnpm --filter @capiro/api sync:sam-opportunities -- --commit
 *   tsx scripts/sync-sam-opportunities.ts --since 2026-05-01 --commit
 *
 * Pulls Contract Opportunities from the SAM.gov API. The default scope remains
 * DoD for backward compatibility; pass `--all-federal` for the complete federal
 * opportunity catalog used by Funding Opportunities.
 * (api.sam.gov/opportunities/v2/search), upserts each notice into sam_opportunity
 * (idempotent on noticeId), derives `active` from the archive date, then runs a PURE,
 * review-gated matching pass (sam-opportunity-matcher) to propose opportunity ->
 * PE / program links into sam_opportunity_match.
 *
 * Wrapped in runWithSyncRun: the incremental window comes from the last successful
 * run's watermark (ctx.since), or an explicit `--since YYYY-MM-DD`. The DoD scope
 * uses both the API department filter and a client-side org-path check. The
 * all-federal scope has its own SyncRun source/watermark so the two schedules can
 * coexist safely during rollout.
 *
 * Complete-window + network safety (PE Phase F / closeout Phase 3):
 *   - oversized windows recursively split; single-day overflow stays partial
 *   - notice IDs dedupe across split boundaries
 *   - only complete runs close as success (partial never advances watermark)
 *   - search/description calls: timeout, HTTPS, host allowlist, private-IP guard,
 *     response size limit, API-key redaction
 *   - historical backfill uses a distinct SyncRun source per scope
 *   - opportunity + match writes are atomic; accepted/rejected human decisions stick
 *
 * HISTORICAL BACKFILL. The daily job only pulls the last ~30 days; older/closed
 * notices need a one-off backfill. SAM.gov caps a single search's date span at ~1
 * year, so walk it in <=1yr windows (newest first is fine — upsert is idempotent):
 *   tsx scripts/sync-sam-opportunities.ts --backfill --since 2024-07-01 --posted-to 2025-06-30 --commit
 * `--backfill` bypasses the "already running" guard and writes to a SEPARATE
 * source so the daily watermark is unaffected.
 *
 * Review gating (sam-opportunity-matcher):
 *   - a verbatim PE-code hit in the text         -> review_status 'accepted'
 *   - a program alias + office/PSC agreement     -> review_status 'candidate'
 *   - PSC/NAICS alone                            -> review_status 'quarantined'
 * No fuzzy / coarse path is ever auto-accepted.
 *
 * Requires SAM_GOV_API_KEY (Secrets Manager -> env). Dry-run by default; pass
 * `--commit` to write. Idempotent. Dry-run never opens a SyncRun row.
 *
 * MATCH-ONLY (no API key, no network):
 *   tsx scripts/sync-sam-opportunities.ts --match-only --commit
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import sanitizeHtml from 'sanitize-html';
import { runWithSyncRun, lastSuccessfulWatermark, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import {
  matchOpportunity,
  trigrams,
  normalizeText,
  type AliasForMatch,
  type OpportunityForMatch,
  type ProposedSamMatch,
} from './sam-opportunity-matcher.js';
import { extractPromotedFields } from './backfill-sam-opportunity-fields.js';

dotenvConfig();

const SAM_URL = 'https://api.sam.gov/opportunities/v2/search';
const SOURCE_DOD = 'sync-sam-opportunities';
const SOURCE_ALL_FEDERAL = 'sync-sam-opportunities-all-federal';
const DEFAULT_DOD_LOOKBACK_DAYS = 30;
const DEFAULT_ALL_FEDERAL_LOOKBACK_DAYS = 2;
const PAGE_LIMIT = 100;
// Circuit breaker on pages/leaf-window (PAGE_LIMIT rows each). Env-overridable so a dense
// historical backfill window can pull deeper than the daily's 5,000-row default.
const MAX_PAGES = Number(process.env.SAM_MAX_PAGES) || 50;
const SEARCH_TIMEOUT_MS = 30_000;
const DESCRIPTION_TIMEOUT_MS = 15_000;
const DESCRIPTION_MAX_BYTES = 1_048_576;
const UTC_DAY_MS = 86_400_000;

function arg(name: string, argv: string[] = process.argv): string | undefined {
  const withEq = argv.find((value) => value.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function flag(name: string, argv: string[] = process.argv): boolean {
  return argv.includes(`--${name}`);
}

export type SamIngestionScope = 'dod' | 'all_federal';

export interface SamSyncArgs {
  scope: SamIngestionScope;
  commit: boolean;
  backfill: boolean;
  matchOnly: boolean;
  since: string | null;
  postedTo: string | null;
}

export function parseSamSyncArgs(argv: string[]): SamSyncArgs {
  return {
    scope: flag('all-federal', argv) ? 'all_federal' : 'dod',
    commit: flag('commit', argv),
    backfill: flag('backfill', argv),
    matchOnly: flag('match-only', argv),
    since: arg('since', argv) ?? null,
    postedTo: arg('posted-to', argv) ?? null,
  };
}

/**
 * The ledger source for one run.
 *
 * A historical backfill gets its OWN source, per scope. It previously shared the
 * daily's source and relied on `overrideSince` to avoid reading the watermark —
 * but writing is the problem, not reading: a successful backfill of, say,
 * 2023-07-01..2024-06-30 closed a SyncRun under `sync-sam-opportunities`, and
 * `runWithSyncRun` derives the incremental window from THE LAST SUCCESSFUL RUN'S
 * `startedAt`. The backfill's startedAt is *now*, so the next daily run's window
 * began at the moment the backfill started and every notice posted between the
 * previous daily and that instant was skipped — permanently, because nothing ever
 * revisits a passed window.
 *
 * Separate sources make the two ledgers independent, which is what the daily
 * watermark being meaningful requires.
 */
export function syncSourceForScope(scope: SamIngestionScope, backfill = false): string {
  const base = scope === 'all_federal' ? SOURCE_ALL_FEDERAL : SOURCE_DOD;
  return backfill ? `${base}-backfill` : base;
}

/**
 * Parse and VALIDATE a `YYYY-MM-DD` CLI date.
 *
 * `safeDate(x) ?? new Date()` was the old behaviour for `--posted-to`, so
 * `--posted-to 2026-13-45` silently became "now" — turning a bounded historical
 * window into an unbounded one that also moved the watermark. A typo must not
 * change what a run does; it must stop the run.
 */
export function parseCliDate(raw: string | undefined, label: string): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label} must be YYYY-MM-DD; received ${JSON.stringify(raw)}`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} is not a real date: ${JSON.stringify(raw)}`);
  }
  // Round-trip check: `2026-02-30` parses in JS and rolls into March.
  if (parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error(`${label} is not a real calendar date: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export interface ResolvedSamWindow {
  since: Date | null;
  postedTo: Date | null;
}

/**
 * Validate the window before anything touches the network or the ledger.
 *
 * A historical backfill must state BOTH bounds explicitly. Without that rule
 * `--backfill` alone fell through to the watermark or the default lookback, so a
 * command whose whole purpose is "ingest this specific past year" quietly ingested
 * the last two days instead and reported success.
 */
export function resolveSamWindow(args: SamSyncArgs): ResolvedSamWindow {
  const since = parseCliDate(args.since ?? undefined, '--since');
  const postedTo = parseCliDate(args.postedTo ?? undefined, '--posted-to');

  if (args.backfill) {
    if (!since) {
      throw new Error(
        '--backfill requires an explicit --since YYYY-MM-DD. Without it the run falls back to the incremental watermark and ingests the last few days instead of the historical window you asked for.',
      );
    }
    if (!postedTo) {
      throw new Error(
        '--backfill requires an explicit --posted-to YYYY-MM-DD. SAM caps a single search span at about one year, so an open-ended backfill silently truncates.',
      );
    }
  }
  if (since && postedTo && since.getTime() > postedTo.getTime()) {
    throw new Error(
      `--since (${since.toISOString().slice(0, 10)}) is after --posted-to (${postedTo.toISOString().slice(0, 10)}); the window is empty.`,
    );
  }
  return { since, postedTo };
}

export function defaultLookbackDaysForScope(scope: SamIngestionScope): number {
  return scope === 'all_federal' ? DEFAULT_ALL_FEDERAL_LOOKBACK_DAYS : DEFAULT_DOD_LOOKBACK_DAYS;
}

/** MM/dd/yyyy (SAM.gov date format). */
function samDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// ── SAM.gov opportunities/v2 record (the subset we read) ─────────────────────
interface SamPlaceOfPerformance {
  city?: { code?: string; name?: string };
  state?: { code?: string; name?: string };
  zip?: string;
  country?: { code?: string; name?: string };
}
interface SamPointOfContact {
  fullName?: string;
  email?: string;
  type?: string;
}
export interface SamOpportunityRecord {
  noticeId?: string;
  solicitationNumber?: string;
  title?: string;
  type?: string; // notice type
  /** The notice's ORIGINAL type before amendment. Promoted to its own column. */
  baseType?: string;
  /** Set-aside code and its human-readable description, when the notice restricts. */
  typeOfSetAside?: string;
  typeOfSetAsideDescription?: string;
  fullParentPathName?: string; // org hierarchy "DEPT OF DEFENSE.DEPT OF THE ARMY..."
  department?: string;
  subTier?: string;
  office?: string;
  organizationType?: string;
  classificationCode?: string; // PSC
  naicsCode?: string;
  postedDate?: string;
  responseDeadLine?: string;
  archiveDate?: string;
  description?: string; // a URL to the description endpoint OR inline text
  pointOfContact?: SamPointOfContact[];
  placeOfPerformance?: SamPlaceOfPerformance;
  uiLink?: string;
  active?: string; // 'Yes' | 'No'
}

export interface SamSearchResponse {
  totalRecords?: number;
  opportunitiesData?: SamOpportunityRecord[];
  error?: { message?: string };
}

/** Is this notice from DoD? (org-path / department check — mirrors the personnel sync). */
export function isDod(rec: SamOpportunityRecord): boolean {
  const hay =
    `${rec.fullParentPathName ?? ''} ${rec.department ?? ''} ${rec.subTier ?? ''}`.toUpperCase();
  return /DEPT OF DEFENSE|DEPARTMENT OF DEFENSE|\bDOD\b|DEPT OF THE (ARMY|NAVY|AIR FORCE)|DEFENSE/.test(
    hay,
  );
}

/** Sub-department agency from the org path. SAM's `department`/`subTier` fields
 *  are almost always null on DoD records, but `fullParentPathName` is populated
 *  ("DEPT OF DEFENSE.DEFENSE LOGISTICS AGENCY.DLA MARITIME..."). We take the 2nd
 *  segment — the meaningful service/agency (Army, Navy, Air Force, DLA, DISA…) —
 *  falling back to the API fields and finally the top segment. */
function agencyOf(rec: SamOpportunityRecord): string | null {
  const segs = (rec.fullParentPathName ?? '')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return (
    str(rec.department) ??
    str(rec.subTier) ??
    (segs.length > 1 ? str(segs[1]) : null) ??
    (segs.length > 0 ? str(segs[0]) : null)
  );
}

/** Best-effort contracting-office label: SAM's office field if present, else the
 *  deepest (most specific) org-path segment. */
function officeOf(rec: SamOpportunityRecord): string | null {
  const segs = (rec.fullParentPathName ?? '')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return (
    str(rec.office) ??
    (segs.length > 2 ? str(segs[segs.length - 1]) : null) ??
    str(rec.subTier) ??
    str(rec.department)
  );
}

/** First POC's name + email (public header fields). */
function primaryPoc(rec: SamOpportunityRecord): { name: string | null; email: string | null } {
  const poc =
    (rec.pointOfContact ?? []).find((p) => (p.type ?? '').toLowerCase() === 'primary') ??
    (rec.pointOfContact ?? [])[0];
  return { name: str(poc?.fullName), email: str(poc?.email) };
}

export function buildSamSearchParams(args: {
  apiKey: string;
  postedFrom: string;
  postedTo: string;
  offset: number;
  scope: SamIngestionScope;
}): URLSearchParams {
  const params = new URLSearchParams({
    api_key: args.apiKey,
    postedFrom: args.postedFrom,
    postedTo: args.postedTo,
    limit: String(PAGE_LIMIT),
    offset: String(args.offset),
  });
  if (args.scope === 'dod') params.set('deptname', 'DEPARTMENT OF DEFENSE');
  return params;
}

export function recordInSamScope(rec: SamOpportunityRecord, scope: SamIngestionScope): boolean {
  return scope === 'all_federal' || isDod(rec);
}

export type SamFetchPage = (
  apiKey: string,
  postedFrom: string,
  postedTo: string,
  offset: number,
  pageLimit: number,
) => Promise<SamSearchResponse>;

export async function fetchPage(
  apiKey: string,
  postedFrom: string,
  postedTo: string,
  offset: number,
  pageLimit = PAGE_LIMIT,
  scopeOrFetch: SamIngestionScope | typeof fetch = 'dod',
  fetchOrTimeout: typeof fetch | number = fetch,
  maybeTimeoutMs = SEARCH_TIMEOUT_MS,
): Promise<SamSearchResponse> {
  let scope: SamIngestionScope = 'dod';
  let fetchImpl: typeof fetch = fetch;
  let timeoutMs = SEARCH_TIMEOUT_MS;

  if (typeof scopeOrFetch === 'function') {
    fetchImpl = scopeOrFetch;
    timeoutMs = typeof fetchOrTimeout === 'number' ? fetchOrTimeout : SEARCH_TIMEOUT_MS;
  } else {
    scope = scopeOrFetch;
    if (typeof fetchOrTimeout === 'function') {
      fetchImpl = fetchOrTimeout;
      timeoutMs = maybeTimeoutMs;
    } else {
      timeoutMs = fetchOrTimeout;
    }
  }

  const params = buildSamSearchParams({
    apiKey,
    postedFrom,
    postedTo,
    offset,
    scope,
  });
  params.set('limit', String(pageLimit));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${SAM_URL}?${params.toString()}`, { signal: controller.signal });
    let json: SamSearchResponse;
    try {
      json = (await res.json()) as SamSearchResponse;
    } catch {
      throw new Error(`SAM.gov ${res.status}: response was not valid JSON`);
    }
    if (!res.ok) {
      throw new Error(
        `SAM.gov ${res.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`,
      );
    }
    return json;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const redacted = apiKey ? rawMessage.split(apiKey).join('[REDACTED]') : rawMessage;
    throw new Error(`SAM.gov request failed: ${redacted.slice(0, 500)}`);
  } finally {
    clearTimeout(timer);
  }
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function utcDayCount(window: SamDateWindow): number {
  return (
    Math.floor(
      (utcDayStart(window.postedTo).getTime() - utcDayStart(window.postedFrom).getTime()) /
        UTC_DAY_MS,
    ) + 1
  );
}

export interface SamDateWindow {
  postedFrom: Date;
  postedTo: Date;
}

/**
 * Split an inclusive UTC-date window into two smaller, non-overlapping windows.
 * SAM's API accepts date-only bounds, so an overlapping split can recurse forever
 * for a two-day range. The collector still de-duplicates noticeIds globally because
 * upstream date-boundary behavior can return the same notice in adjacent windows.
 */
export function splitSamWindow(window: SamDateWindow): [SamDateWindow, SamDateWindow] {
  const postedFrom = utcDayStart(window.postedFrom);
  const postedTo = utcDayStart(window.postedTo);
  const days = utcDayCount({ postedFrom, postedTo });
  if (days <= 1) {
    throw new Error(`Cannot split single-day SAM window ${samDate(postedFrom)}`);
  }

  const leftDays = Math.floor(days / 2);
  const leftTo = new Date(postedFrom.getTime() + (leftDays - 1) * UTC_DAY_MS);
  const rightFrom = new Date(leftTo.getTime() + UTC_DAY_MS);
  return [
    { postedFrom, postedTo: leftTo },
    { postedFrom: rightFrom, postedTo },
  ];
}

export interface SamWindowCollection {
  records: SamOpportunityRecord[];
  complete: boolean;
  incompleteReason: string | null;
  incompleteReasons: string[];
  duplicateNoticeCount: number;
  reportedTotal: number;
  rowsFetched: number;
  leafWindows: number;
}

export interface CollectSamWindowOptions {
  fetchPage?: SamFetchPage;
  pageLimit?: number;
  maxPages?: number;
  scope?: SamIngestionScope;
}

/**
 * Exhaust a SAM date range without silently accepting the page cap. Windows that
 * exceed the configured capacity are recursively divided until each leaf fits.
 * A single UTC day that still overflows is processed up to the cap and returned as
 * incomplete, which causes runWithSyncRun to persist status='partial'.
 */
export async function collectSamWindowRecords(
  apiKey: string,
  rootWindow: SamDateWindow,
  options: CollectSamWindowOptions = {},
): Promise<SamWindowCollection> {
  const pageLimit = options.pageLimit ?? PAGE_LIMIT;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const scope = options.scope ?? 'dod';
  const fetchPageFn: SamFetchPage =
    options.fetchPage ??
    ((key, from, to, offset, limit) => fetchPage(key, from, to, offset, limit, scope));
  if (!Number.isInteger(pageLimit) || pageLimit <= 0) {
    throw new Error(`SAM pageLimit must be a positive integer; received ${pageLimit}`);
  }
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(`SAM maxPages must be a positive integer; received ${maxPages}`);
  }

  const normalizedRoot = {
    postedFrom: utcDayStart(rootWindow.postedFrom),
    postedTo: utcDayStart(rootWindow.postedTo),
  };
  if (normalizedRoot.postedFrom > normalizedRoot.postedTo) {
    throw new Error(
      `Invalid SAM window ${samDate(normalizedRoot.postedFrom)}..${samDate(normalizedRoot.postedTo)}`,
    );
  }

  const capacity = pageLimit * maxPages;
  const records: SamOpportunityRecord[] = [];
  const seenNoticeIds = new Set<string>();
  const incompleteReasons: string[] = [];
  let duplicateNoticeCount = 0;
  let reportedTotal = 0;
  let rowsFetched = 0;
  let leafWindows = 0;

  const append = (batch: SamOpportunityRecord[]): void => {
    rowsFetched += batch.length;
    for (const record of batch) {
      const noticeId = str(record.noticeId);
      if (!noticeId) {
        // Keep malformed records so the caller can count them as skipped rather
        // than making the source denominator disappear.
        records.push(record);
        continue;
      }
      if (seenNoticeIds.has(noticeId)) {
        duplicateNoticeCount += 1;
        continue;
      }
      seenNoticeIds.add(noticeId);
      records.push(record);
    }
  };

  const processWindow = async (window: SamDateWindow): Promise<void> => {
    const postedFrom = samDate(window.postedFrom);
    const postedTo = samDate(window.postedTo);
    const first = await fetchPageFn(apiKey, postedFrom, postedTo, 0, pageLimit);
    const firstBatch = first.opportunitiesData ?? [];
    const total =
      typeof first.totalRecords === 'number' && Number.isFinite(first.totalRecords)
        ? Math.max(0, Math.trunc(first.totalRecords))
        : undefined;

    if (total !== undefined && total > capacity && utcDayCount(window) > 1) {
      const [left, right] = splitSamWindow(window);
      await processWindow(left);
      await processWindow(right);
      return;
    }

    const batches: SamOpportunityRecord[][] = [firstBatch];
    let offset = pageLimit;
    let lastBatchLength = firstBatch.length;
    for (let page = 1; page < maxPages; page += 1) {
      if (lastBatchLength < pageLimit) break;
      if (total !== undefined && offset >= total) break;
      const response = await fetchPageFn(apiKey, postedFrom, postedTo, offset, pageLimit);
      const batch = response.opportunitiesData ?? [];
      batches.push(batch);
      lastBatchLength = batch.length;
      offset += pageLimit;
      if (batch.length === 0) break;
    }

    const fetchedForWindow = batches.reduce((sum, batch) => sum + batch.length, 0);
    const capped =
      total !== undefined
        ? fetchedForWindow < total
        : batches.length >= maxPages && lastBatchLength >= pageLimit;

    if (capped && utcDayCount(window) > 1) {
      const [left, right] = splitSamWindow(window);
      await processWindow(left);
      await processWindow(right);
      return;
    }

    leafWindows += 1;
    reportedTotal += Math.max(total ?? fetchedForWindow, fetchedForWindow);
    for (const batch of batches) append(batch);

    if (capped) {
      const exactTotal = total ?? `more than ${capacity}`;
      incompleteReasons.push(
        `SAM.gov single-day window ${postedFrom} reported ${exactTotal} records; ` +
          `processed ${fetchedForWindow} within capacity ${capacity} ` +
          `(SAM_MAX_PAGES=${maxPages}, pageLimit=${pageLimit})`,
      );
    }
  };

  await processWindow(normalizedRoot);
  return {
    records,
    complete: incompleteReasons.length === 0,
    incompleteReason: incompleteReasons.length ? incompleteReasons.join('; ') : null,
    incompleteReasons,
    duplicateNoticeCount,
    reportedTotal,
    rowsFetched,
    leafWindows,
  };
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function isSamHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'sam.gov' || normalized.endsWith('.sam.gov');
}

function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return true;
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function safeSamUrl(rawDescription: string): URL | null {
  const trimmed = rawDescription.trim();
  if (!looksLikeUrl(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('SAM description URL is malformed');
  }
  if (url.protocol !== 'https:') {
    throw new Error(`SAM description URL protocol is not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('SAM description URL must not contain credentials');
  }
  if (isPrivateIpLiteral(url.hostname)) {
    throw new Error('SAM description URL points to a private or loopback host');
  }
  if (!isSamHost(url.hostname)) {
    throw new Error(`SAM description URL host is not allowed: ${url.hostname}`);
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error(`SAM description URL port is not allowed: ${url.port}`);
  }
  return url;
}

export function samDescriptionSourceUrl(rawDescription: string | null): string | null {
  const value = str(rawDescription);
  if (!value || !looksLikeUrl(value)) return null;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      if (normalized === 'apikey') url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`SAM description response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`SAM description response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function descriptionTextFromResponse(body: string, contentType: string | null): string | null {
  let candidate = body;
  if ((contentType ?? '').toLowerCase().includes('json')) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed === 'string') candidate = parsed;
      else if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const nested =
          (typeof obj.description === 'string' && obj.description) ||
          (typeof obj.content === 'string' && obj.content) ||
          (typeof obj.text === 'string' && obj.text) ||
          (obj.opportunity &&
          typeof obj.opportunity === 'object' &&
          typeof (obj.opportunity as Record<string, unknown>).description === 'string'
            ? ((obj.opportunity as Record<string, unknown>).description as string)
            : null);
        candidate = nested ?? '';
      }
    } catch {
      throw new Error('SAM description endpoint returned malformed JSON');
    }
  }

  const blockSeparated = candidate.replace(
    /<(?:br\s*\/?|\/?(?:p|div|li|h[1-6]|tr|section|article))[^>]*>/gi,
    ' ',
  );
  const text = sanitizeHtml(blockSeparated, { allowedTags: [], allowedAttributes: {} })
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

export interface ResolveSamDescriptionOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Resolve a SAM-hosted description endpoint without ever matching the URL itself. */
export async function resolveSamDescription(
  rawDescription: string | null,
  apiKey: string,
  options: ResolveSamDescriptionOptions = {},
): Promise<{ text: string | null; sourceUrl: string | null }> {
  const value = str(rawDescription);
  if (!value) return { text: null, sourceUrl: null };
  if (!looksLikeUrl(value)) return { text: value, sourceUrl: null };

  const source = safeSamUrl(value);
  if (!source) return { text: value, sourceUrl: null };
  const sourceUrl = samDescriptionSourceUrl(value);
  const requestUrl = new URL(source.toString());
  if (
    requestUrl.hostname.toLowerCase() === 'api.sam.gov' &&
    !requestUrl.searchParams.has('api_key')
  ) {
    requestUrl.searchParams.set('api_key', apiKey);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DESCRIPTION_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(requestUrl, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { accept: 'application/json, text/html, text/plain;q=0.9' },
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`SAM description endpoint redirected with status ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`SAM description endpoint returned HTTP ${response.status}`);
    }
    const body = await readBoundedBody(response, options.maxBytes ?? DESCRIPTION_MAX_BYTES);
    return {
      text: descriptionTextFromResponse(body, response.headers.get('content-type')),
      sourceUrl,
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const redacted = apiKey ? rawMessage.split(apiKey).join('[REDACTED]') : rawMessage;
    throw new Error(
      `Unable to resolve SAM.gov description ${sourceUrl ?? source.origin}: ${redacted.slice(0, 500)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the in-memory alias index the matcher needs: each program alias with its
 * precomputed trigram set + optional office/PSC corroboration hints. Pure shaping —
 * no network.
 *
 * ⚠️ DORMANT TIER: the matcher's `program_alias` tier only emits a match when a
 * trigram-hit alias ALSO has office/PSC agreement (matchOpportunity precision guard).
 * No office/PSC hint source is wired today — the `ProgramAlias` model has NO
 * officeHint/pscHints columns, and the caller's query below selects only
 * {programId, aliasNormalized, aliasType}. So `officeHint`/`pscHints` are always
 * undefined here and the `program_alias` tier NEVER fires in production; SAM matches
 * come only from the description_pe_code (verbatim) and psc_naics_component
 * (quarantined) tiers. To activate the alias tier, derive per-program office/PSC
 * hints (e.g. the contracting offices + PSCs seen on that program's federal_award
 * history) into new ProgramAlias columns and select them here — see the coverage
 * remediation plan §4.2. The fields are kept optional so that enhancement is additive.
 */
function buildAliasIndex(
  aliases: Array<{
    programId: string;
    aliasNormalized: string;
    aliasType: string;
    officeHint?: string | null;
    pscHints?: string[];
  }>,
): AliasForMatch[] {
  return aliases.map((a) => ({
    programId: a.programId,
    aliasNormalized: a.aliasNormalized,
    aliasType: a.aliasType,
    tg: trigrams(a.aliasNormalized),
    officeHint: a.officeHint ?? null,
    pscHints: a.pscHints ? new Set(a.pscHints.map((p) => p.toUpperCase())) : undefined,
  }));
}

type SamMatchPersistenceClient = Pick<Prisma.TransactionClient, 'samOpportunityMatch'>;

type ExistingSamMatch = {
  id: string;
  matchBasis: string;
  confidence: number;
  reviewStatus: string;
};

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function persistOneMatch(
  client: SamMatchPersistenceClient,
  opportunityId: string,
  match: ProposedSamMatch,
): Promise<number> {
  const where = {
    opportunityId,
    programId: match.programId,
    peCode: match.peCode,
  };
  const select = {
    id: true,
    matchBasis: true,
    confidence: true,
    reviewStatus: true,
  } as const;

  const applyExisting = async (existing: ExistingSamMatch): Promise<number> => {
    // Human review decisions are terminal for machine reruns. Do not touch updatedAt,
    // confidence, basis, or status: accepted and rejected rows remain explicit decisions.
    if (existing.reviewStatus === 'rejected' || existing.reviewStatus === 'accepted') return 0;

    // Same evidence basis: refresh confidence and Prisma's updatedAt while preserving
    // the existing review status. The schema has no reviewer/machine-author column, so
    // preserving status is the only safe behavior for both human-accepted and machine
    // candidate rows.
    if (existing.matchBasis === match.matchBasis) {
      await client.samOpportunityMatch.update({
        where: { id: existing.id },
        data: { confidence: match.confidence },
      });
      return 1;
    }

    // A changed machine basis must not rewrite an existing human-visible decision.
    // The proposed evidence will be reconsidered only through a separately keyed row
    // (programId/peCode) or a future explicit review workflow.
    return 0;
  };

  const existing = await client.samOpportunityMatch.findFirst({ where, select });
  if (existing) return applyExisting(existing);

  try {
    await client.samOpportunityMatch.create({
      data: {
        opportunityId,
        programId: match.programId,
        peCode: match.peCode,
        matchBasis: match.matchBasis,
        confidence: match.confidence,
        reviewStatus: match.reviewStatus,
      },
    });
    return 1;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Another worker won the functional-natural-key race. Re-read and apply the
    // same review-preserving update instead of creating a duplicate or returning 500.
    const raced = await client.samOpportunityMatch.findFirst({ where, select });
    if (!raced) throw error;
    return applyExisting(raced);
  }
}

/**
 * Persist proposed matches without overwriting human review decisions. The functional
 * natural key prevents duplicate opportunity/program/PE rows; a race is re-read and
 * handled idempotently.
 */
export async function persistMatches(
  client: SamMatchPersistenceClient,
  opportunityId: string,
  proposed: ProposedSamMatch[],
): Promise<number> {
  let written = 0;
  for (const match of proposed) {
    written += await persistOneMatch(client, opportunityId, match);
  }
  return written;
}

export function descriptionForMatching(description: string | null): string | null {
  const value = str(description);
  return value && looksLikeUrl(value) ? null : value;
}

interface PreparedOpportunity {
  data: {
    noticeId: string;
    solicitationNumber: string | null;
    title: string;
    noticeType: string;
    baseType: string | null;
    agency: string | null;
    subAgency: string | null;
    setAside: string | null;
    setAsideCode: string | null;
    office: string | null;
    pscCode: string | null;
    naicsCode: string | null;
    postedDate: Date | null;
    responseDeadline: Date | null;
    archiveDate: Date | null;
    description: string | null;
    pocName: string | null;
    pocEmail: string | null;
    placeOfPerformance: Prisma.InputJsonValue;
    sourceUrl: string;
    active: boolean;
  };
  raw: Prisma.InputJsonValue;
  descriptionError: string | null;
}

async function prepareOpportunity(
  record: SamOpportunityRecord,
  noticeId: string,
  apiKey: string,
): Promise<PreparedOpportunity> {
  const archiveDate = safeDate(record.archiveDate);
  const active =
    record.active != null
      ? record.active.toLowerCase() !== 'no'
      : archiveDate == null || archiveDate.getTime() > Date.now();
  const poc = primaryPoc(record);
  const promoted = extractPromotedFields(record);
  const rawDescription = str(record.description);
  const descriptionSourceUrl = samDescriptionSourceUrl(rawDescription);
  let description: string | null = null;
  let descriptionError: string | null = null;
  let descriptionResolution: 'none' | 'inline' | 'resolved' | 'failed' = 'none';

  try {
    const resolved = await resolveSamDescription(rawDescription, apiKey);
    description = resolved.text;
    descriptionResolution = resolved.sourceUrl ? 'resolved' : description ? 'inline' : 'none';
  } catch (error) {
    descriptionError = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    descriptionResolution = 'failed';
  }

  const raw = JSON.parse(
    JSON.stringify({
      ...record,
      _capiro: {
        descriptionResolution,
        descriptionSourceUrl,
        descriptionError,
      },
    }),
  ) as Prisma.InputJsonValue;

  return {
    data: {
      noticeId,
      solicitationNumber: str(record.solicitationNumber),
      title: str(record.title) ?? '(untitled)',
      noticeType: (str(record.type) ?? str(record.baseType) ?? 'unknown').slice(0, 32),
      baseType: promoted.baseType,
      agency: agencyOf(record),
      subAgency: promoted.subAgency,
      setAside: promoted.setAside,
      setAsideCode: promoted.setAsideCode,
      office: officeOf(record),
      pscCode: str(record.classificationCode)?.slice(0, 8) ?? null,
      naicsCode: str(record.naicsCode)?.slice(0, 8) ?? null,
      postedDate: safeDate(record.postedDate),
      responseDeadline: safeDate(record.responseDeadLine),
      archiveDate,
      description,
      pocName: poc.name,
      pocEmail: poc.email,
      placeOfPerformance: JSON.parse(
        JSON.stringify(record.placeOfPerformance ?? {}),
      ) as Prisma.InputJsonValue,
      sourceUrl: str(record.uiLink) ?? `https://sam.gov/opp/${noticeId}/view`,
      active,
    },
    raw,
    descriptionError,
  };
}

async function main(): Promise<void> {
  const parsed = parseSamSyncArgs(process.argv.slice(2));
  const { commit, backfill, matchOnly, scope } = parsed;

  if (matchOnly) {
    const prismaMatch = new PrismaClient();
    try {
      await rematchExisting(prismaMatch, commit);
    } finally {
      await prismaMatch.$disconnect();
    }
    return;
  }

  const apiKey = process.env.SAM_GOV_API_KEY ?? '';
  if (!apiKey) throw new Error('SAM_GOV_API_KEY not configured');
  const window = resolveSamWindow(parsed);
  const sinceArg = window.since ?? undefined;
  const postedToDate = window.postedTo ?? new Date();
  const t0 = Date.now();
  console.log(
    `[sam-opportunities] starting scope=${scope} (${commit ? 'COMMIT' : 'DRY-RUN'}${backfill ? ', BACKFILL' : ''}) maxPages=${MAX_PAGES}`,
  );

  const prisma = new PrismaClient();
  try {
    const execute = async (ctx: { since: Date | null }): Promise<RunCounts> => {
      const since =
        ctx.since ?? new Date(Date.now() - defaultLookbackDaysForScope(scope) * UTC_DAY_MS);
      const rootWindow = { postedFrom: since, postedTo: postedToDate };
      console.log(
        `[sam-opportunities] window postedFrom=${samDate(since)} postedTo=${samDate(postedToDate)}`,
      );

      const pes = await prisma.programElement.findMany({ select: { peCode: true } });
      const knownPeCodes = new Set<string>(pes.map((p) => p.peCode.toUpperCase()));
      const aliasRows = await prisma.programAlias.findMany({
        select: { programId: true, aliasNormalized: true, aliasType: true },
      });
      const aliasIndex = buildAliasIndex(aliasRows);
      console.log(
        `[sam-opportunities] ${knownPeCodes.size} known PEs, ${aliasIndex.length} program aliases`,
      );

      const collection = await collectSamWindowRecords(apiKey, rootWindow, { scope });
      console.log(
        `[sam-opportunities] sourceTotal=${collection.reportedTotal} uniqueRows=${collection.records.length} ` +
          `rowsFetched=${collection.rowsFetched} duplicateNotices=${collection.duplicateNoticeCount} ` +
          `leafWindows=${collection.leafWindows} complete=${collection.complete}`,
      );
      for (const reason of collection.incompleteReasons) {
        console.warn(`[sam-opportunities] PARTIAL: ${reason}`);
      }

      const counts: RunCounts = {
        inserted: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        complete: collection.complete,
        incompleteReason: collection.incompleteReason ?? undefined,
      };
      let matchesWritten = 0;
      let matchesProposed = 0;

      for (const rec of collection.records) {
        if (!recordInSamScope(rec, scope)) {
          counts.skipped += 1;
          continue;
        }
        const noticeId = str(rec.noticeId);
        if (!noticeId) {
          counts.skipped += 1;
          continue;
        }

        const prepared = await prepareOpportunity(rec, noticeId, apiKey);
        if (prepared.descriptionError) {
          counts.errors += 1;
          console.warn(
            `[sam-opportunities] description unavailable for ${noticeId}: ${prepared.descriptionError}`,
          );
        }

        try {
          if (commit) {
            const result = await prisma.$transaction(async (tx) => {
              const existing = await tx.samOpportunity.findUnique({
                where: { noticeId },
                select: { id: true },
              });
              const row = await tx.samOpportunity.upsert({
                where: { noticeId },
                create: { ...prepared.data, raw: prepared.raw, lastSyncedAt: new Date() },
                update: { ...prepared.data, raw: prepared.raw, lastSyncedAt: new Date() },
                select: { id: true },
              });
              const forMatch: OpportunityForMatch = {
                title: prepared.data.title,
                description: descriptionForMatching(prepared.data.description),
                office: prepared.data.office,
                pscCode: prepared.data.pscCode,
                naicsCode: prepared.data.naicsCode,
              };
              const proposed = matchOpportunity(forMatch, knownPeCodes, aliasIndex);
              const written = await persistMatches(tx, row.id, proposed);
              return { existed: Boolean(existing), proposed: proposed.length, written };
            });
            if (result.existed) counts.updated += 1;
            else counts.inserted += 1;
            matchesProposed += result.proposed;
            matchesWritten += result.written;
          } else {
            const existing = await prisma.samOpportunity.findUnique({
              where: { noticeId },
              select: { id: true },
            });
            if (existing) counts.updated += 1;
            else counts.inserted += 1;
            matchesProposed += matchOpportunity(
              {
                title: prepared.data.title,
                description: descriptionForMatching(prepared.data.description),
                office: prepared.data.office,
                pscCode: prepared.data.pscCode,
                naicsCode: prepared.data.naicsCode,
              },
              knownPeCodes,
              aliasIndex,
            ).length;
          }
        } catch (err) {
          counts.errors += 1;
          console.warn(
            `[sam-opportunities] upsert/match failed for ${noticeId}: ${(err as Error).message}`,
          );
        }
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        commit
          ? `[sam-opportunities] inserted=${counts.inserted} updated=${counts.updated} skipped=${counts.skipped} errors=${counts.errors} matches=${matchesWritten} proposed=${matchesProposed} complete=${counts.complete !== false} in ${elapsed}s`
          : `[sam-opportunities] DRY RUN — would insert=${counts.inserted} would update=${counts.updated} skipped=${counts.skipped} errors=${counts.errors} would match=${matchesProposed} complete=${counts.complete !== false} in ${elapsed}s (NOTHING WAS WRITTEN, no SyncRun row, watermark unchanged)`,
      );
      return counts;
    };

    if (commit) {
      await runWithSyncRun(
        prisma as never,
        syncSourceForScope(scope, backfill),
        execute,
        { overrideSince: sinceArg ?? null, skipIfRunning: !backfill },
      );
    } else {
      // Dry-run must not create a SyncRun row (would advance / pollute the ledger).
      const watermark = sinceArg
        ? sinceArg
        : await lastSuccessfulWatermark(prisma as never, syncSourceForScope(scope, backfill));
      await execute({ since: watermark });
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Re-run the pure matcher over EVERY existing sam_opportunity row (no network).
 * URL-shaped legacy descriptions are treated as absent rather than scanned as notice text.
 */
async function rematchExisting(prisma: PrismaClient, commit: boolean): Promise<void> {
  const t0 = Date.now();
  console.log(
    `[sam-opportunities] MATCH-ONLY re-match over existing opportunities (${commit ? 'COMMIT' : 'DRY-RUN'})`,
  );

  const pes = await prisma.programElement.findMany({ select: { peCode: true } });
  const knownPeCodes = new Set<string>(pes.map((p) => p.peCode.toUpperCase()));
  const aliasRows = await prisma.programAlias.findMany({
    select: { programId: true, aliasNormalized: true, aliasType: true },
  });
  const aliasIndex = buildAliasIndex(aliasRows);
  console.log(
    `[sam-opportunities] ${knownPeCodes.size} known PEs, ${aliasIndex.length} program aliases`,
  );

  const BATCH = 1000;
  let scanned = 0;
  let withProposed = 0;
  let matchesWritten = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.samOpportunity.findMany({
      select: {
        id: true,
        title: true,
        description: true,
        office: true,
        pscCode: true,
        naicsCode: true,
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const runMatch = () =>
        matchOpportunity(
          {
            title: row.title,
            description: descriptionForMatching(row.description),
            office: row.office,
            pscCode: row.pscCode,
            naicsCode: row.naicsCode,
          },
          knownPeCodes,
          aliasIndex,
        );
      if (commit) {
        const result = await prisma.$transaction(async (tx) => {
          const proposed = runMatch();
          return { proposed: proposed.length, written: await persistMatches(tx, row.id, proposed) };
        });
        if (result.proposed > 0) withProposed += 1;
        matchesWritten += result.written;
      } else {
        if (runMatch().length > 0) withProposed += 1;
      }
      scanned += 1;
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < BATCH) break;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[sam-opportunities] MATCH-ONLY done: scanned=${scanned} ` +
      `opportunitiesWithProposedMatch=${withProposed} matchesWritten=${matchesWritten} ` +
      `(${commit ? 'COMMITTED' : 'DRY-RUN, nothing written'}) in ${elapsed}s`,
  );
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-sam-opportunities(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('[sam-opportunities] FAILED', err);
    process.exit(1);
  });
}

export { main, officeOf, buildAliasIndex, normalizeText };
