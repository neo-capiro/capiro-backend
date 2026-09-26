import {
  createMeriResultEnvelope,
  type MeriResultEnvelope,
  type MeriResultProvenance,
} from '@capiro/shared';
import { notifyMeriResultObserver } from './meri-result-observer.js';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null;
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function localLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.max(1, Math.min(25, Math.trunc(parsed))) : 10;
}

function cboUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['cbo.gov', 'www.cbo.gov'].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function publicationDate(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Dormant observation of the local CBO-estimate table read. Completeness here
 * describes only the bounded local query, never the upstream CBO record set or
 * Congress API/RSS ingest freshness.
 */
export function envelopeCboCostEstimatesResult<T extends RecordValue>(
  legacyPayload: T,
  request: RecordValue,
): MeriResultEnvelope<T> {
  const billId = optionalString(request.billId, 40)?.toLowerCase() ?? null;
  const query = optionalString(request.query, 200);
  const rawCongress = request.congress;
  const parsedCongress = rawCongress ? Number(rawCongress) : null;
  const congress = parsedCongress !== null && Number.isInteger(parsedCongress) &&
    parsedCongress > 0 ? parsedCongress : null;
  const scopeKnown = (request.billId == null || typeof request.billId === 'string') &&
    (request.query == null || typeof request.query === 'string') &&
    (rawCongress == null || congress !== null);
  const limit = localLimit(request.limit);
  const scope = {
    storage: 'capiro_local_database',
    ...(billId ? { billId } : {}),
    ...(query ? { query } : {}),
    ...(congress !== null ? { congress } : {}),
    limit,
  };

  const estimates = Array.isArray(legacyPayload.estimates) ? legacyPayload.estimates : null;
  const rowsValid = estimates !== null && estimates.every((value) => {
    const row = record(value);
    return row !== null &&
      typeof row.id === 'string' && row.id.length > 0 &&
      (row.billId === null || typeof row.billId === 'string') &&
      typeof row.congress === 'number' && Number.isInteger(row.congress) &&
      row.congress > 0 &&
      typeof row.billType === 'string' && row.billType.length > 0 &&
      typeof row.billNumber === 'string' && row.billNumber.length > 0 &&
      typeof row.title === 'string' && row.title.length > 0 &&
      publicationDate(row.pubDate) && cboUrl(row.cboUrl) !== null &&
      (!billId || row.billId === billId) &&
      (congress === null || row.congress === congress) &&
      (!query || (row.title as string).toLowerCase().includes(query.toLowerCase()));
  });
  const verified = scopeKnown && legacyPayload.tool === 'search_cbo_cost_estimates' &&
    rowsValid && legacyPayload.estimatesFound === estimates!.length &&
    estimates!.length <= limit;
  const atCap = verified && estimates!.length === limit;
  const provenance: MeriResultProvenance[] = verified
    ? estimates!.map((value) => {
      const row = value as RecordValue;
      return { recordId: row.id as string, sourceId: 'cbo_cost_estimate',
        url: cboUrl(row.cboUrl)! };
    }) : [];

  return createMeriResultEnvelope({
    outcome: verified
      ? atCap ? 'partial' : estimates!.length === 0 ? 'not_found_within_scope' : 'succeeded'
      : 'partial',
    legacyPayload,
    sources: [{
      family: 'legislative', sourceId: 'cbo_cost_estimate',
      availability: verified ? 'available' : 'unknown',
      scope, observedAt: null,
      coverage: {
        completeness: verified ? atCap ? 'partial' : 'complete' : 'unknown',
        ...(verified && !atCap ? { continuation: { hasMore: false } } : {}),
        ...(verified ? { returnedCount: estimates!.length } : {}),
        matchedCount: verified && !atCap ? estimates!.length : null,
      },
      provenance,
    }],
    // A full page may have more rows, but the query does not check or expose it.
    truncation: { truncated: false },
    errors: verified ? [] : [{ code: 'cbo_cost_estimates_observation_unverified' }],
  });
}

/** Observe a successful legacy call without changing its result or thrown error. */
export async function observeCboCostEstimatesCall<T extends RecordValue>(
  call: () => Promise<T>,
  request: RecordValue,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeCboCostEstimatesResult(legacyPayload, request)));
  return legacyPayload;
}
