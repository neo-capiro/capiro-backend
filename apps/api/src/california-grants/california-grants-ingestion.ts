/** @cleanup-smoke noArgsExit=1 helpExit=0 */
import { runWithSyncRun, type RunCounts } from '../ingestion/sync-run.helper.js';

export const CALIFORNIA_GRANTS_SOURCE = 'sync-california-grants';
export const CALIFORNIA_RESOURCE_ID = '111c8c88-21f6-453c-ae2c-b4785a0624f5';
export const CALIFORNIA_API_ROOT = 'https://data.ca.gov/api/3/action/datastore_search';
export const CALIFORNIA_PAGE_SIZE = 100;
export const CALIFORNIA_MAX_PAGES = 100;
export const CALIFORNIA_MAX_RECORDS = CALIFORNIA_PAGE_SIZE * CALIFORNIA_MAX_PAGES;
export const CALIFORNIA_REQUEST_TIMEOUT_MS = 15_000;

export interface CaliforniaGrantRow {
  _id?: number;
  PortalID?: string | null;
  GrantID?: string | null;
  Status?: string | null;
  LastUpdated?: string | null;
  ChangeNotes?: string | null;
  AgencyDept?: string | null;
  Title?: string | null;
  Type?: string | null;
  LOI?: string | null;
  Categories?: string | null;
  CategorySuggestion?: string | null;
  Purpose?: string | null;
  Description?: string | null;
  ApplicantType?: string | null;
  ApplicantTypeNotes?: string | null;
  Geography?: string | null;
  FundingSource?: string | null;
  FundingSourceNotes?: string | null;
  MatchingFunds?: string | null;
  MatchingFundsNotes?: string | null;
  EstAvailFunds?: string | null;
  EstAwards?: string | null;
  EstAmounts?: string | null;
  FundingMethod?: string | null;
  FundingMethodNotes?: string | null;
  OpenDate?: string | null;
  ApplicationDeadline?: string | null;
  AwardPeriod?: string | null;
  ExpAwardDate?: string | null;
  ElecSubmission?: string | null;
  GrantURL?: string | null;
  AgencyURL?: string | null;
  AgencySubscribeURL?: string | null;
  GrantEventsURL?: string | null;
  ContactInfo?: string | null;
  AwardStats?: string | null;
  [key: string]: unknown;
}

export interface CaliforniaSearchResult {
  records: CaliforniaGrantRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface CaliforniaSearchResponse {
  success: boolean;
  result?: {
    records?: CaliforniaGrantRow[];
    total?: number;
    limit?: number;
    offset?: number;
  };
  error?: unknown;
}

export interface CaliforniaGrantOpportunityData {
  portalId: string;
  grantId: string | null;
  status: string | null;
  lastUpdatedRaw: string | null;
  lastUpdatedCalendarDate: Date | null;
  changeNotes: string | null;
  agencyDept: string | null;
  title: string | null;
  type: string | null;
  loi: string | null;
  categoriesRaw: string | null;
  categories: string[];
  categorySuggestion: string | null;
  purpose: string | null;
  description: string | null;
  applicantTypeRaw: string | null;
  applicantTypes: string[];
  applicantTypeNotes: string | null;
  geography: string | null;
  fundingSource: string | null;
  fundingSourceNotes: string | null;
  matchingFundsRaw: string | null;
  matchingFundsPercent: number | null;
  matchingFundsNotes: string | null;
  estimatedAvailableFundsRaw: string | null;
  estimatedAvailableFundsAmount: number | null;
  estimatedAwardsRaw: string | null;
  estimatedAwardsCount: number | null;
  estimatedAmountsRaw: string | null;
  estimatedAmountMin: number | null;
  estimatedAmountMax: number | null;
  fundingMethod: string | null;
  fundingMethodNotes: string | null;
  openDateRaw: string | null;
  openDateCalendarDate: Date | null;
  applicationDeadlineRaw: string | null;
  applicationDeadlineCalendarDate: Date | null;
  awardPeriod: string | null;
  expectedAwardDate: string | null;
  electronicSubmissionRaw: string | null;
  electronicSubmissionUrls: string[];
  electronicSubmissionEmails: string[];
  grantUrl: string | null;
  agencyUrl: string | null;
  agencySubscribeUrl: string | null;
  grantEventsUrl: string | null;
  contactInfo: string | null;
  awardStats: string | null;
  raw: Record<string, unknown>;
}

export interface CaliforniaGrantPrisma {
  californiaGrantOpportunity: {
    findUnique(args: { where: { portalId: string }; select?: { portalId: true } }): Promise<{ portalId: string } | null>;
    upsert(args: { where: { portalId: string }; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface CaliforniaFetchPage {
  (offset: number, limit: number): Promise<CaliforniaSearchResult>;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\u00a0/g, ' ').trim();
  return cleaned.length ? cleaned : null;
}

function splitSourceList(value: unknown): string[] {
  const raw = text(value);
  return raw ? raw.split(';').map((part) => part.trim()).filter(Boolean) : [];
}

/** Parse only the portal's known offsetless calendar format. */
export function parseCaliforniaCalendarDate(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    ? date
    : null;
}

function parseMoney(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /^\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)$/.exec(raw);
  if (!match) return null;
  const amount = Number(match[1]!.replace(/,/g, ''));
  return Number.isSafeInteger(amount) && amount <= 9007199254740991 ? amount : null;
}

function parsePercent(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d+(?:\.\d+)?)%$/.exec(raw);
  if (!match) return null;
  const percent = Number(match[1]!);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 && /^\d+(?:\.\d{1,4})?%$/.test(raw) ? percent : null;
}

function parseCount(value: unknown): number | null {
  const raw = text(value);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const count = Number(raw);
  return Number.isSafeInteger(count) && count <= 2147483647 ? count : null;
}

function parseAmountRange(value: unknown): { min: number | null; max: number | null } {
  const raw = text(value);
  if (!raw) return { min: null, max: null };
  const match = /^(?:between\s+)?\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:and|[-–—])\s*\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)$/i.exec(raw);
  if (!match) return { min: null, max: null };
  const min = Number(match[1]!.replace(/,/g, ''));
  const max = Number(match[2]!.replace(/,/g, ''));
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) && min <= max && max <= 9007199254740991 ? { min, max } : { min: null, max: null };
}

function parseSubmission(value: unknown): { urls: string[]; emails: string[] } {
  const raw = text(value) ?? '';
  const urls = [...raw.matchAll(/url:\s*(https?:\/\/[^;\s]+)/gi)].map((m) => m[1]!).filter(Boolean);
  const emails = [...raw.matchAll(/email:\s*([^;\s]+@[^;\s]+)/gi)].map((m) => m[1]!).filter(Boolean);
  return { urls, emails };
}

export function mapCaliforniaGrantRow(row: CaliforniaGrantRow): CaliforniaGrantOpportunityData {
  const portalId = text(row.PortalID);
  if (!portalId) throw new Error('California grant row is missing PortalID');
  const amounts = parseAmountRange(row.EstAmounts);
  const submission = parseSubmission(row.ElecSubmission);
  return {
    portalId,
    grantId: text(row.GrantID),
    status: text(row.Status),
    lastUpdatedRaw: text(row.LastUpdated),
    lastUpdatedCalendarDate: parseCaliforniaCalendarDate(row.LastUpdated),
    changeNotes: text(row.ChangeNotes),
    agencyDept: text(row.AgencyDept),
    title: text(row.Title),
    type: text(row.Type),
    loi: text(row.LOI),
    categoriesRaw: text(row.Categories),
    categories: splitSourceList(row.Categories),
    categorySuggestion: text(row.CategorySuggestion),
    purpose: text(row.Purpose),
    description: text(row.Description),
    applicantTypeRaw: text(row.ApplicantType),
    applicantTypes: splitSourceList(row.ApplicantType),
    applicantTypeNotes: text(row.ApplicantTypeNotes),
    geography: text(row.Geography),
    fundingSource: text(row.FundingSource),
    fundingSourceNotes: text(row.FundingSourceNotes),
    matchingFundsRaw: text(row.MatchingFunds),
    matchingFundsPercent: parsePercent(row.MatchingFunds),
    matchingFundsNotes: text(row.MatchingFundsNotes),
    estimatedAvailableFundsRaw: text(row.EstAvailFunds),
    estimatedAvailableFundsAmount: parseMoney(row.EstAvailFunds),
    estimatedAwardsRaw: text(row.EstAwards),
    estimatedAwardsCount: parseCount(row.EstAwards),
    estimatedAmountsRaw: text(row.EstAmounts),
    estimatedAmountMin: amounts.min,
    estimatedAmountMax: amounts.max,
    fundingMethod: text(row.FundingMethod),
    fundingMethodNotes: text(row.FundingMethodNotes),
    openDateRaw: text(row.OpenDate),
    openDateCalendarDate: parseCaliforniaCalendarDate(row.OpenDate),
    applicationDeadlineRaw: text(row.ApplicationDeadline),
    applicationDeadlineCalendarDate: parseCaliforniaCalendarDate(row.ApplicationDeadline),
    awardPeriod: text(row.AwardPeriod),
    expectedAwardDate: text(row.ExpAwardDate),
    electronicSubmissionRaw: text(row.ElecSubmission),
    electronicSubmissionUrls: submission.urls,
    electronicSubmissionEmails: submission.emails,
    grantUrl: text(row.GrantURL),
    agencyUrl: text(row.AgencyURL),
    agencySubscribeUrl: text(row.AgencySubscribeURL),
    grantEventsUrl: text(row.GrantEventsURL),
    contactInfo: text(row.ContactInfo),
    awardStats: text(row.AwardStats),
    raw: JSON.parse(JSON.stringify(row)) as Record<string, unknown>,
  };
}

function makeUrl(offset: number, limit: number): string {
  const url = new URL(CALIFORNIA_API_ROOT);
  url.searchParams.set('resource_id', CALIFORNIA_RESOURCE_ID);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('sort', 'PortalID asc');
  return url.toString();
}

export async function fetchCaliforniaPage(offset: number, limit: number): Promise<CaliforniaSearchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALIFORNIA_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(makeUrl(offset, limit), { signal: controller.signal });
    if (!response.ok) throw new Error(`California Grants Portal HTTP ${response.status}`);
    const body = (await response.json()) as CaliforniaSearchResponse;
    if (!body.success || !body.result || !Array.isArray(body.result.records)) {
      throw new Error(`California Grants Portal returned an invalid CKAN response: ${JSON.stringify(body.error ?? body).slice(0, 500)}`);
    }
    const total = body.result.total;
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
      throw new Error('California Grants Portal response has no valid total');
    }
    if (body.result.limit !== undefined && body.result.limit !== limit) {
      throw new Error(`California Grants Portal changed page limit: requested ${limit}, received ${body.result.limit}`);
    }
    if (body.result.offset !== undefined && body.result.offset !== offset) {
      throw new Error(`California Grants Portal changed page offset: requested ${offset}, received ${body.result.offset}`);
    }
    return { records: body.result.records, total: total as number, limit, offset };
  } finally {
    clearTimeout(timer);
  }
}

export interface SyncCaliforniaOptions {
  fetchPage?: CaliforniaFetchPage;
  pageSize?: number;
  maxPages?: number;
  maxRecords?: number;
}

export async function syncCaliforniaGrants(
  prisma: CaliforniaGrantPrisma,
  options: SyncCaliforniaOptions = {},
): Promise<RunCounts> {
  const fetchPage = options.fetchPage ?? fetchCaliforniaPage;
  const pageSize = options.pageSize ?? CALIFORNIA_PAGE_SIZE;
  const maxPages = options.maxPages ?? CALIFORNIA_MAX_PAGES;
  const maxRecords = options.maxRecords ?? CALIFORNIA_MAX_RECORDS;
  if (![pageSize, maxPages, maxRecords].every((value) => Number.isFinite(value) && Number.isInteger(value) && value > 0)) {
    throw new Error('pageSize, maxPages, and maxRecords must be positive integers');
  }
  let total: number | null = null;
  let offset = 0;
  let pages = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let incompleteReason: string | undefined;
  const seenPortalIds = new Set<string>();
  let stoppedByCap = false;

  while (pages < maxPages && offset < maxRecords) {
    let page: CaliforniaSearchResult;
    try {
      page = await fetchPage(offset, Math.min(pageSize, maxRecords - offset));
    } catch (error) {
      if (pages === 0) throw error;
      errors += 1;
      incompleteReason = `Page at offset ${offset} failed: ${(error as Error).message}`;
      break;
    }
    if (total === null) total = page.total;
    if (page.total !== total || page.offset !== offset || page.limit !== Math.min(pageSize, maxRecords - offset)) {
      errors += 1;
      incompleteReason = `Pagination contract changed at offset ${offset}`;
      break;
    }
    if (page.records.length > page.limit || offset + page.records.length > total) {
      errors += 1;
      incompleteReason = `Page at offset ${offset} exceeded its requested limit`;
      break;
    }

    for (const row of page.records) {
      let data: CaliforniaGrantOpportunityData;
      try {
        data = mapCaliforniaGrantRow(row);
      } catch (error) {
        errors += 1;
        console.warn(`[${CALIFORNIA_GRANTS_SOURCE}] malformed row: ${(error as Error).message}`);
        continue;
      }
      if (seenPortalIds.has(data.portalId)) {
        skipped += 1;
        continue;
      }
      seenPortalIds.add(data.portalId);
      try {
        const existed = await prisma.californiaGrantOpportunity.findUnique({ where: { portalId: data.portalId }, select: { portalId: true } });
        const payload = { ...data, ingestedAt: new Date() };
        await prisma.californiaGrantOpportunity.upsert({ where: { portalId: data.portalId }, create: payload, update: payload });
        if (existed) updated += 1;
        else inserted += 1;
      } catch (error) {
        errors += 1;
        console.warn(`[${CALIFORNIA_GRANTS_SOURCE}] ${data.portalId} upsert failed: ${(error as Error).message}`);
      }
    }

    const nextOffset = offset + page.records.length;
    if (page.records.length === 0 && total === 0) break;
    if (page.records.length === 0 || nextOffset <= offset) {
      errors += 1;
      incompleteReason = `No forward progress at offset ${offset}`;
      break;
    }
    offset = nextOffset;
    pages += 1;
    if (offset >= total) break;
  }

  if (total !== null && offset < total && !incompleteReason) {
    incompleteReason = `Bounded catalog walk stopped at offset ${offset} of reported total ${total}`;
  }
  if (total !== null && seenPortalIds.size < total && !incompleteReason) {
    incompleteReason = `Catalog walk observed only ${seenPortalIds.size} unique PortalIDs of reported total ${total}`;
  }
  return {
    inserted,
    updated,
    skipped,
    errors,
    complete: !incompleteReason,
    incompleteReason,
    errorMessage: errors ? `California catalog sync observed ${errors} error(s)` : null,
  };
}

export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL is required for sync-california-grants');
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new Error('unsupported protocol');
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  return value;
}

export async function runCaliforniaGrantsCli(): Promise<RunCounts> {
  requireDatabaseUrl();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    return await runWithSyncRun(
      prisma as unknown as Parameters<typeof runWithSyncRun>[0],
      CALIFORNIA_GRANTS_SOURCE,
      () => syncCaliforniaGrants(prisma as unknown as CaliforniaGrantPrisma),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/california-grants-ingestion.ts')) {
  const usage = 'Usage: sync-california-grants [--help] (requires DATABASE_URL)';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
  } else if (args.length > 0) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    if (!process.env.DATABASE_URL?.trim()) console.error(usage);
    runCaliforniaGrantsCli().catch((error: unknown) => {
      console.error(`[${CALIFORNIA_GRANTS_SOURCE}] FAILED`, error);
      process.exitCode = 1;
    });
  }
}

export type { RunCounts };
