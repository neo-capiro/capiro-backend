import { createHash } from 'node:crypto';

export type ForecastPeriod =
  | { precision: 'month'; raw: string; year: number; month: number }
  | { precision: 'unknown'; raw: string };
export interface ForecastSource {
  rin: string;
  edition: string;
  url: string;
  issuedAt: string | null;
  sha256: string;
}
export interface ForecastContent {
  title: string;
  eventType: 'proposed_rule' | 'final_rule';
  period: ForecastPeriod;
  status: 'published' | 'withdrawn' | 'source_completed';
  source: ForecastSource;
  confidence: 'not_supplied';
  completionEvidence?: { action: string; rawDate: string };
  withdrawalEvidence?: { action: string; rawDate: string };
}
export interface ForecastRecord extends ForecastContent {
  id: string;
  revision: number;
  observedAt: string;
  recordedAt: string;
}
export const OBSERVATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function civilDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Civil bounds are filtering boundaries, never a forecast event timestamp. */
export function monthBounds(period: ForecastPeriod): { from: string; to: string } | null {
  if (period.precision === 'unknown') return null;
  const { year, month } = period;
  if (
    !Number.isInteger(year) ||
    year < 1900 ||
    year > 9998 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  )
    throw new Error('Invalid forecast month');
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
  return { from, to };
}

export function validateContent(value: ForecastContent): void {
  if (
    !value ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 4000 ||
    !['proposed_rule', 'final_rule'].includes(value.eventType) ||
    !['published', 'withdrawn', 'source_completed'].includes(value.status) ||
    value.confidence !== 'not_supplied' ||
    !value.period ||
    !['month', 'unknown'].includes(value.period.precision) ||
    typeof value.period.raw !== 'string' ||
    value.period.raw.length > 500
  )
    throw new Error('Invalid forecast content');
  monthBounds(value.period);
  const source = value.source;
  if (
    !source ||
    !/^[A-Za-z0-9-]{4,40}$/.test(source.rin) ||
    !/^\d{6}$/.test(source.edition) ||
    !/^[a-f0-9]{64}$/.test(source.sha256)
  )
    throw new Error('Invalid forecast provenance');
  const url = new URL(source.url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.reginfo.gov' ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Unsupported forecast source');
  if (source.issuedAt !== null && !civilDay(source.issuedAt))
    throw new Error('Invalid publisher issue date');
  const evidence =
    value.status === 'source_completed'
      ? value.completionEvidence
      : value.status === 'withdrawn'
        ? value.withdrawalEvidence
        : null;
  if (
    value.status !== 'published' &&
    (!evidence || !evidence.action || !/^\d{2}\/\d{2}\/\d{4}$/.test(evidence.rawDate))
  )
    throw new Error('Terminal forecast requires source evidence');
}

export function forecastId(sourceKey: string): string {
  if (!sourceKey || sourceKey.length > 200) throw new Error('Invalid forecast identity');
  return createHash('sha256').update(`reginfo-unified-agenda:${sourceKey}`).digest('hex');
}

export function contentHash(content: ForecastContent): string {
  validateContent(content);
  // Explicit field order makes an unchanged observation independent of object key order.
  const p = content.period;
  const s = content.source;
  return createHash('sha256')
    .update(
      JSON.stringify([
        content.title,
        content.eventType,
        p.precision,
        p.raw,
        p.precision === 'month' ? p.year : null,
        p.precision === 'month' ? p.month : null,
        content.status,
        s.rin,
        s.edition,
        s.url,
        s.issuedAt,
        s.sha256,
        content.confidence,
        content.completionEvidence?.action ?? null,
        content.completionEvidence?.rawDate ?? null,
        content.withdrawalEvidence?.action ?? null,
        content.withdrawalEvidence?.rawDate ?? null,
      ]),
    )
    .digest('hex');
}

export function parseRange(input: {
  from?: string;
  to?: string;
  page?: string;
  pageSize?: string;
  includeWithdrawn?: string;
  includeUndated?: string;
}) {
  if (
    !civilDay(input.from) ||
    !civilDay(input.to) ||
    input.from >= input.to ||
    Date.parse(input.to) - Date.parse(input.from) > 366 * 86400000
  )
    throw new Error('Use a civil date range of 1–366 days');
  return {
    from: input.from,
    to: input.to,
    ...parsePage(input),
    includeWithdrawn: parseBoolean(input.includeWithdrawn),
    includeUndated: parseBoolean(input.includeUndated),
  };
}
export function parsePage(input: { page?: string; pageSize?: string }) {
  for (const value of [input.page, input.pageSize])
    if (value !== undefined && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)))
      throw new Error('Invalid forecast pagination');
  const page = Number(input.page ?? '1');
  const pageSize = Number(input.pageSize ?? '50');
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new Error('Invalid forecast pagination');
  return { page, pageSize };
}
function parseBoolean(value?: string): boolean {
  if (value !== undefined && value !== 'true' && value !== 'false')
    throw new Error('Invalid forecast filter');
  return value === 'true';
}
