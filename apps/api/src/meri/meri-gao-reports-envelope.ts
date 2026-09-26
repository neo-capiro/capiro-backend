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
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.trunc(parsed))) : 20;
}

/** Syntax and origin check only; this does not fetch or certify a GAO page. */
function gaoUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['gao.gov', 'www.gao.gov'].includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function publicationDate(value: unknown): boolean {
  if (value === null) return true;
  if (value instanceof Date) return Number.isFinite(value.getTime());
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Dormant observation of the local GAO report table. The legacy handler reads
 * page and count concurrently in separate system transactions and truncates
 * displayed title/summary, so this adapter never claims complete query coverage
 * or an exact snapshot-wide match count.
 */
export function envelopeGaoReportsResult<T extends RecordValue>(
  legacyPayload: T,
  request: RecordValue,
): MeriResultEnvelope<T> {
  const query = optionalString(request.query, 240);
  const reportType = optionalString(request.reportType, 60);
  const limit = localLimit(request.limit);
  const scopeKnown = (request.query == null || typeof request.query === 'string') &&
    (request.reportType == null || typeof request.reportType === 'string');
  const scope = {
    storage: 'capiro_local_database',
    ...(query ? { query } : {}),
    ...(reportType ? { reportType } : {}),
    limit,
  };

  const data = Array.isArray(legacyPayload.data) ? legacyPayload.data : null;
  const pageValid = data !== null && data.length <= limit && data.every((value) => {
    const row = record(value);
    return row !== null &&
      typeof row.id === 'string' && row.id.length > 0 &&
      typeof row.title === 'string' &&
      (row.url === null || typeof row.url === 'string') &&
      publicationDate(row.publishDate) &&
      (row.reportType === null || typeof row.reportType === 'string') &&
      Array.isArray(row.topics) && row.topics.every((topic) => typeof topic === 'string') &&
      Array.isArray(row.agencies) && row.agencies.every((agency) => typeof agency === 'string') &&
      typeof row.summary === 'string' &&
      (row.recommendations === null ||
        typeof row.recommendations === 'number' && Number.isInteger(row.recommendations)) &&
      (!reportType || row.reportType === reportType);
  });
  const reportedTotal = legacyPayload.total;
  const totalValid = typeof reportedTotal === 'number' &&
    Number.isSafeInteger(reportedTotal) && reportedTotal >= 0;
  const verified = scopeKnown && legacyPayload.tool === 'search_gao_reports' &&
    pageValid && totalValid;
  const badUrls = verified && data!.some((value) => {
    const url = (value as RecordValue).url;
    return url != null && gaoUrl(url) === null;
  });
  const countDiffers = verified && reportedTotal !== data!.length;
  // The handler summarizes display fields before returning them. Its capped
  // strings end in `...`, but an uncapped source may naturally do so too, so
  // this is deliberately a possible-truncation signal rather than a claim
  // about the unseen source text.
  const possibleDisplayCap = verified && data!.some((value) => {
    const row = value as RecordValue;
    return (typeof row.title === 'string' && row.title.length === 240 && row.title.endsWith('...')) ||
      (typeof row.summary === 'string' && row.summary.length === 400 && row.summary.endsWith('...'));
  });
  const possibleResultCap = verified && (data!.length === limit || reportedTotal > data!.length);
  const provenance: MeriResultProvenance[] = verified
    ? data!.map((value) => {
      const row = value as RecordValue;
      const url = gaoUrl(row.url);
      return {
        recordId: row.id as string,
        sourceId: 'gao_report',
        ...(url ? { url } : {}),
      };
    }) : [];

  return createMeriResultEnvelope({
    outcome: !verified || badUrls || countDiffers
      ? 'partial' : 'succeeded',
    legacyPayload,
    sources: [{
      family: 'search', sourceId: 'gao_report',
      availability: verified ? 'available' : 'unknown',
      scope, observedAt: null,
      coverage: {
        completeness: 'unknown',
        ...(verified ? { returnedCount: data!.length } : {}),
        matchedCount: null,
      },
      provenance,
    }],
    // A full page or a larger separately read count only proves a possible
    // result cap; the exact count/page snapshot is not shared.
    truncation: !verified
      ? { truncated: true, reason: 'possible_unverified_result_truncation' }
      : possibleDisplayCap && possibleResultCap
        ? { truncated: true, reason: 'possible_display_text_and_local_result_cap' }
        : possibleDisplayCap
          ? { truncated: true, reason: 'possible_display_text_truncation' }
          : possibleResultCap
            ? { truncated: true, reason: 'possible_local_result_cap' }
            : { truncated: false },
    errors: !verified ? [{ code: 'gao_reports_observation_unverified' }]
      : badUrls ? [{ code: 'gao_report_url_unverified' }] : [],
  });
}

/** Observe a successful legacy call without changing its result or thrown error. */
export async function observeGaoReportsCall<T extends RecordValue>(
  call: () => Promise<T>,
  request: RecordValue,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeGaoReportsResult(legacyPayload, request)));
  return legacyPayload;
}
