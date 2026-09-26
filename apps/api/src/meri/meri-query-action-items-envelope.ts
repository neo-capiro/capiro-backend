import {
  createMeriResultEnvelope,
  type MeriResultEnvelope,
  type MeriResultSourceObservation,
} from '@capiro/shared';
import { notifyMeriResultObserver } from './meri-result-observer.js';

type RecordValue = Record<string, unknown>;

export interface QueryActionItemsEnvelopeScope {
  /** True only when the server resolved and applied the explicit client filter. */
  readonly clientFilterApplied: boolean;
  /** The successful handler query applied this exact status filter, when present. */
  readonly statusFilter: string | null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Maps only the action-item count/page facts asserted by the API handler.
 * The filter summary is explicit, due dates are not query filters, and source
 * freshness is unknown: generatedAt is the response clock.
 */
export function envelopeQueryActionItemsResult<T extends RecordValue>(
  legacyPayload: T,
  scope: QueryActionItemsEnvelopeScope,
): MeriResultEnvelope<T> {
  const rows = Array.isArray(legacyPayload.actions) ? legacyPayload.actions : null;
  const returned = nonNegativeInteger(legacyPayload.returned);
  const pageLimit = nonNegativeInteger(legacyPayload.pageLimit);
  const total = nonNegativeInteger(legacyPayload.total);
  const identityKnown = legacyPayload.tool === 'query_action_items';
  const countsKnown = rows !== null && returned !== undefined && pageLimit !== undefined && pageLimit > 0 &&
    total !== undefined;
  const countsConsistent = countsKnown && returned === rows.length && returned <= total && rows.length <= pageLimit;
  const complete = identityKnown && countsConsistent && returned === total &&
    legacyPayload.paginationComplete === true;
  const validPartial = identityKnown && countsConsistent && returned < total &&
    legacyPayload.paginationComplete === false;
  const verified = complete || validPartial;

  const completeness: MeriResultSourceObservation['coverage']['completeness'] = complete
    ? 'complete'
    : validPartial ? 'partial' : 'unknown';
  const source: MeriResultSourceObservation = {
    family: 'action',
    sourceId: 'action_recommendations',
    availability: identityKnown && rows !== null ? 'available' : 'unknown',
    scope: identityKnown
      ? {
        tenantScope: 'authenticated_tenant',
        visibilityScope: 'client_grant_filtered',
        attributionScope: scope.clientFilterApplied ? 'selected_client' : 'visible_clients_in_tenant',
        clientFilterApplied: scope.clientFilterApplied,
        statusFilter: scope.statusFilter,
        dueDateFilterApplied: false,
      }
      : { tenantScope: 'unknown' },
    // The legacy generatedAt value is response time, not source freshness.
    observedAt: null,
    coverage: {
      completeness,
      ...(complete ? { continuation: { hasMore: false } } : {}),
      ...(returned !== undefined ? { returnedCount: returned } : {}),
      matchedCount: complete || validPartial ? total! : null,
    },
    provenance: [],
  };

  return createMeriResultEnvelope({
    outcome: complete ? 'succeeded' : 'partial',
    legacyPayload,
    sources: [source],
    truncation: {
      truncated: !complete,
      ...(!complete ? { reason: 'query_action_items_coverage_unverified_or_partial' } : {}),
    },
    errors: verified ? [] : [{ code: 'query_action_items_coverage_unverified' }],
  });
}

/** Dormant success-only observer preserving legacy payload and rejection identity. */
export async function observeQueryActionItemsCall<T extends RecordValue>(
  call: () => Promise<T>,
  scope: QueryActionItemsEnvelopeScope,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeQueryActionItemsResult(legacyPayload, scope)));
  return legacyPayload;
}
