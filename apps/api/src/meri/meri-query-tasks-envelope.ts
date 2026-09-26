import {
  createMeriResultEnvelope,
  type MeriResultEnvelope,
  type MeriResultSourceObservation,
} from '@capiro/shared';
import { notifyMeriResultObserver } from './meri-result-observer.js';

type RecordValue = Record<string, unknown>;

export interface QueryTasksEnvelopeScope {
  /** True only when the server resolved and applied the explicit client filter. */
  readonly clientFilterApplied: boolean;
}

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Maps only the query_tasks page facts already asserted by the API handler.
 * A full page is always partial (the endpoint has no continuation cursor),
 * generatedAt is never treated as source freshness, and no ACL conclusion is
 * inferred by this mapper.
 */
export function envelopeQueryTasksResult<T extends RecordValue>(
  legacyPayload: T,
  scope: QueryTasksEnvelopeScope,
): MeriResultEnvelope<T> {
  const rows = Array.isArray(legacyPayload.tasks) ? legacyPayload.tasks : null;
  const returned = nonNegativeInteger(legacyPayload.returned);
  const pageLimit = nonNegativeInteger(legacyPayload.pageLimit);
  const reportedTotal = legacyPayload.total === null
    ? null
    : nonNegativeInteger(legacyPayload.total);
  const identityKnown = legacyPayload.tool === 'query_tasks';
  const countsKnown = rows !== null && returned !== undefined && pageLimit !== undefined && pageLimit > 0;
  const countConsistent = countsKnown && returned === rows.length && rows.length <= pageLimit;
  const shortPageComplete = identityKnown && countConsistent && rows.length < pageLimit &&
    reportedTotal === rows.length && legacyPayload.paginationComplete === true;
  const fullPagePartial = identityKnown && countConsistent && rows.length === pageLimit &&
    reportedTotal === null && legacyPayload.paginationComplete === false;
  const verified = identityKnown && (shortPageComplete || fullPagePartial);

  const completeness: MeriResultSourceObservation['coverage']['completeness'] = shortPageComplete
    ? 'complete'
    : fullPagePartial ? 'partial' : 'unknown';
  const availability: MeriResultSourceObservation['availability'] = identityKnown && rows !== null
    ? 'available'
    : 'unknown';
  // A complete page only means the handler exhausted its actual query. This
  // mapper does not bind all resolved filters (including selected client) into
  // the observation, so an empty result must not become an absence claim.
  const outcome = shortPageComplete ? 'succeeded' : 'partial';
  const source: MeriResultSourceObservation = {
    family: 'task',
    sourceId: 'engagement_tasks',
    availability,
    scope: identityKnown
      ? {
        tenantScope: 'authenticated_tenant',
        visibilityScope: 'handler_query_scope_filters_not_recorded',
        clientFilterApplied: scope.clientFilterApplied,
      }
      : { tenantScope: 'unknown' },
    // The legacy generatedAt value is response time, not source freshness.
    observedAt: null,
    coverage: {
      completeness,
      // A short result proves the handler exhausted this query. A full page
      // only shows that the cap was reached; without a cursor/count it cannot
      // assert whether another matching row exists.
      ...(shortPageComplete ? { continuation: { hasMore: false } } : {}),
      ...(returned !== undefined ? { returnedCount: returned } : {}),
      matchedCount: shortPageComplete ? returned! : null,
    },
    provenance: [],
  };

  return createMeriResultEnvelope({
    outcome,
    legacyPayload,
    sources: [source],
    truncation: {
      truncated: !shortPageComplete,
      ...(!shortPageComplete ? { reason: 'query_tasks_coverage_unverified_or_partial' } : {}),
    },
    errors: verified ? [] : [{ code: 'query_tasks_coverage_unverified' }],
  });
}

/**
 * Dormant success-only observer. It returns the exact legacy object, never
 * serializes an exception, and lets a source rejection propagate by identity.
 */
export async function observeQueryTasksCall<T extends RecordValue>(
  call: () => Promise<T>,
  scope: QueryTasksEnvelopeScope,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeQueryTasksResult(legacyPayload, scope)));
  return legacyPayload;
}
