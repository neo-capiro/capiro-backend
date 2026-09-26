import {
  createMeriResultEnvelope,
  type MeriResultEnvelope,
  type MeriResultProvenance,
} from '@capiro/shared';

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

/** Check URL syntax and exact official origin, without fetching the document. */
function officialCrsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://crsreports.congress.gov' ||
      url.username || url.password || url.port) return null;
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
 * Dormant observation of the local CRS report query. Its page and count are
 * read in separate system transactions, and the handler omits syncedAt, so
 * neither result-set completeness nor source freshness can be established.
 */
export function envelopeCrsReportsResult<T extends RecordValue>(
  legacyPayload: T,
  request: RecordValue,
): MeriResultEnvelope<T> {
  const query = optionalString(request.query, 240);
  const limit = localLimit(request.limit);
  const scopeKnown = request.query == null || typeof request.query === 'string';
  const scope = {
    storage: 'capiro_local_database',
    activeOnly: true,
    ...(query ? { query } : {}),
    limit,
  };

  const data = Array.isArray(legacyPayload.data) ? legacyPayload.data : null;
  const ids = new Set<string>();
  const pageValid = data !== null && data.length <= limit && data.every((value) => {
    const row = record(value);
    if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) return false;
    ids.add(row.id);
    return typeof row.title === 'string' &&
      publicationDate(row.date) &&
      Array.isArray(row.authors) && row.authors.every((author) => typeof author === 'string') &&
      Array.isArray(row.topics) && row.topics.every((topic) => typeof topic === 'string') &&
      typeof row.summary === 'string' &&
      (row.pdfUrl === null || typeof row.pdfUrl === 'string') &&
      (row.htmlUrl === null || typeof row.htmlUrl === 'string');
  });
  const reportedTotal = legacyPayload.total;
  const totalValid = typeof reportedTotal === 'number' &&
    Number.isSafeInteger(reportedTotal) && reportedTotal >= 0;
  const verified = scopeKnown && legacyPayload.tool === 'search_crs_reports' &&
    pageValid && totalValid;
  const badUrls = verified && data!.some((value) => {
    const row = value as RecordValue;
    return (row.pdfUrl !== null && officialCrsUrl(row.pdfUrl) === null) ||
      (row.htmlUrl !== null && officialCrsUrl(row.htmlUrl) === null);
  });
  const countBelowPage = verified && reportedTotal < data!.length;
  const moreReportedThanReturned = verified && reportedTotal > data!.length;
  const possibleDisplayCap = verified && data!.some((value) => {
    const row = value as RecordValue;
    return (typeof row.title === 'string' && row.title.length === 240 && row.title.endsWith('...')) ||
      (typeof row.summary === 'string' && row.summary.length === 400 && row.summary.endsWith('...'));
  });
  const possibleResultCap = verified && (data!.length === limit || moreReportedThanReturned);
  const provenance: MeriResultProvenance[] = verified
    ? data!.map((value) => {
      const row = value as RecordValue;
      const url = officialCrsUrl(row.htmlUrl) ?? officialCrsUrl(row.pdfUrl);
      return {
        recordId: row.id as string,
        sourceId: 'crs_report',
        ...(url ? { url } : {}),
      };
    }) : [];
  const errors: { code: string }[] = [];
  if (!verified) {
    errors.push({ code: 'crs_reports_observation_unverified' });
  } else {
    if (badUrls) errors.push({ code: 'crs_report_url_unverified' });
    if (countBelowPage) errors.push({ code: 'crs_reports_count_page_inconsistent' });
  }

  return createMeriResultEnvelope({
    outcome: !verified || badUrls || countBelowPage || moreReportedThanReturned
      ? 'partial' : 'succeeded',
    legacyPayload,
    sources: [{
      family: 'search', sourceId: 'crs_report',
      availability: verified ? 'available' : 'unknown',
      scope, observedAt: null,
      coverage: {
        completeness: 'unknown',
        ...(verified ? { returnedCount: data!.length } : {}),
        matchedCount: null,
      },
      provenance,
    }],
    truncation: !verified
      ? { truncated: true, reason: 'possible_unverified_result_truncation' }
      : possibleDisplayCap && possibleResultCap
        ? { truncated: true, reason: 'possible_display_text_and_local_result_cap' }
        : possibleDisplayCap
          ? { truncated: true, reason: 'possible_display_text_truncation' }
          : possibleResultCap
            ? { truncated: true, reason: 'possible_local_result_cap' }
            : { truncated: false },
    errors,
  });
}

/** Observe a successful legacy call without changing its result or thrown error. */
export async function observeCrsReportsCall<T extends RecordValue>(
  call: () => Promise<T>,
  request: RecordValue,
  observe: (envelope: MeriResultEnvelope<T>) => void | Promise<void>,
): Promise<T> {
  const legacyPayload = await call();
  try {
    void Promise.resolve(observe(envelopeCrsReportsResult(legacyPayload, request)))
      .catch(() => undefined);
  } catch {
    // Synchronous observation failure must not change the legacy result.
  }
  return legacyPayload;
}
