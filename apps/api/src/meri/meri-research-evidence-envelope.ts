import {
  createMeriResultEnvelope,
  type MeriResultEnvelope,
  type MeriResultOutcome,
  type MeriResultSourceObservation,
} from '@capiro/shared';
import { notifyMeriResultObserver } from './meri-result-observer.js';

type RecordValue = Record<string, unknown>;
const SOURCE_ID = 'research_attachments';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function scopeFromResult(payload: RecordValue, request: RecordValue): Record<string, string | number | boolean | null> {
  const scope: Record<string, string | number | boolean | null> = {};
  if (typeof payload.sessionId === 'string' && UUID.test(payload.sessionId)) {
    scope.sessionId = payload.sessionId;
  }
  if (Array.isArray(request.attachmentIds) && request.attachmentIds.length > 0 &&
      request.attachmentIds.every((id) => typeof id === 'string' && UUID.test(id))) {
    // getResearchEvidence validates these IDs, deduplicates and sorts them before applying the filter.
    scope.attachmentSelection = JSON.stringify([...new Set(request.attachmentIds as string[])].sort());
  } else if (request.attachmentIds === undefined) {
    scope.attachmentSelection = 'all';
  }
  return scope;
}

function provenanceFromRecords(value: unknown, sessionId: unknown, rawCapturedAt: unknown, capturedAt: string | null) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asRecord(entry);
    const origin = asRecord(row?.provenance);
    const recordId = typeof row?.recordId === 'string' ? row.recordId : null;
    const payload = asRecord(row?.payload);
    if (!recordId || row?.domain !== SOURCE_ID || origin?.originalAttachmentId !== recordId ||
        origin.sessionId !== sessionId || origin.capturedAt !== rawCapturedAt) return [];
    const hash = typeof payload?.contentSha256 === 'string' && SHA256.test(payload.contentSha256)
      ? payload.contentSha256
      : undefined;
    return [{
      recordId,
      ...(hash ? { sourceVersion: hash } : {}),
      ...(capturedAt ? { observedAt: capturedAt } : {}),
    }];
  });
}

/** Adapt the explicit legacy research-evidence coverage without rewriting its payload. */
export function envelopeResearchEvidenceResult<T extends RecordValue>(
  legacyPayload: T,
  request: RecordValue,
): MeriResultEnvelope<T> {
  const coverage = asRecord(legacyPayload.coverage);
  const records = Array.isArray(legacyPayload.records) ? legacyPayload.records : null;
  const returned = nonNegativeInteger(coverage?.returned);
  const total = nonNegativeInteger(coverage?.total);
  const capturedAt = timestamp(legacyPayload.capturedAt);
  const sourceIdentityKnown = legacyPayload.tool === 'get_research_evidence' &&
    typeof legacyPayload.sessionId === 'string' && UUID.test(legacyPayload.sessionId);
  const status = coverage?.status;
  const hasMore = coverage?.truncated === true || typeof coverage?.nextCursor === 'string';
  const hasContinuationSignal = typeof coverage?.truncated === 'boolean' ||
    coverage?.nextCursor === null || typeof coverage?.nextCursor === 'string';
  const continuation = hasContinuationSignal
    ? { hasMore, ...(typeof coverage?.nextCursor === 'string' ? { cursor: coverage.nextCursor } : {}) }
    : undefined;
  const countsConsistent = records !== null && returned !== undefined && total !== undefined &&
    sourceIdentityKnown && returned === records.length && total === returned &&
    typeof request.cursor !== 'string';
  const countsKnown = records !== null && returned !== undefined && total !== undefined;
  const claimedComplete = status === 'complete' && coverage?.complete === true &&
    coverage.paginationComplete === true && coverage.contentComplete === true &&
    coverage.truncated === false && coverage.nextCursor === null;
  const complete = claimedComplete && countsConsistent;
  const explicitlyUnavailable = sourceIdentityKnown && status === 'unavailable';
  const recognizedStatus = sourceIdentityKnown &&
    (status === 'complete' || status === 'partial' || explicitlyUnavailable);
  const availability: MeriResultSourceObservation['availability'] = explicitlyUnavailable
    ? 'unavailable'
    : recognizedStatus ? 'available' : 'unknown';

  let completeness: MeriResultSourceObservation['coverage']['completeness'] = 'unknown';
  if (sourceIdentityKnown && status === 'partial') completeness = 'partial';
  else if (complete) completeness = 'complete';
  else if (sourceIdentityKnown && status === 'complete' && (coverage?.complete === false ||
      coverage?.paginationComplete === false || coverage?.contentComplete === false ||
      coverage?.truncated === true || typeof coverage?.nextCursor === 'string' ||
      (countsKnown && !countsConsistent))) completeness = 'partial';

  let outcome: MeriResultOutcome = 'partial';
  if (explicitlyUnavailable) outcome = 'unavailable';
  else if (complete && total === 0 && returned === 0) outcome = 'not_found_within_scope';
  else if (complete && typeof returned === 'number' && returned > 0) outcome = 'succeeded';

  const source: MeriResultSourceObservation = {
    family: 'document',
    sourceId: SOURCE_ID,
    availability,
    scope: scopeFromResult(legacyPayload, request),
    // capturedAt is the immutable snapshot time; it is not the time of this read.
    observedAt: capturedAt,
    coverage: {
      completeness,
      ...(continuation ? { continuation } : {}),
      ...(returned !== undefined ? { returnedCount: returned } : {}),
      matchedCount: total ?? null,
    },
    provenance: provenanceFromRecords(records, legacyPayload.sessionId, legacyPayload.capturedAt, capturedAt),
    ...(explicitlyUnavailable ? { failure: { code: 'research_handoff_unavailable' } } : {}),
  };
  const contentIncomplete = coverage?.contentComplete === false;
  const truncated = coverage?.truncated === true || hasMore || contentIncomplete;

  return createMeriResultEnvelope({
    outcome,
    legacyPayload,
    sources: [source],
    truncation: { truncated },
    errors: explicitlyUnavailable ? [{ code: 'research_handoff_unavailable' }] : [],
  });
}

/**
 * Opt-in observer for the unchanged legacy call path. Errors are neither
 * serialized nor classified; the original thrown value is rethrown by
 * reference, preserving the tool's authorization-oracle behavior.
 */
export async function observeResearchEvidenceCall<T extends RecordValue>(
  call: () => Promise<T>,
  request: RecordValue,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeResearchEvidenceResult(legacyPayload, request)));
  return legacyPayload;
}
