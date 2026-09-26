import { createHash } from 'node:crypto';
import {
  createMeriResultEnvelope,
  type MeriResultEnvelope,
  type MeriResultOutcome,
  type MeriResultSourceObservation,
} from '@capiro/shared';
import { notifyMeriResultObserver } from './meri-result-observer.js';

type RecordValue = Record<string, unknown>;
const SOURCE_ID = 'engagement_attachment';
const SHA256 = /^[a-f0-9]{64}$/i;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Opt-in adapter. Listing coverage is enumeration-only; document content needs exact read proof. */
export function envelopeClientDocumentsResult<T extends RecordValue>(
  legacyPayload: T,
  request: RecordValue,
): MeriResultEnvelope<T> {
  const listing = request.documentId === undefined;
  const coverage = asRecord(legacyPayload.coverage);
  const clientId = typeof legacyPayload.clientId === 'string' ? legacyPayload.clientId : null;
  const identityKnown = legacyPayload.tool === 'read_client_documents' && clientId !== null &&
    (typeof request.clientId !== 'string' || request.clientId === clientId);
  const requestedQuery = request.query === undefined ? '' :
    typeof request.query === 'string' ? request.query.trim() : null;
  const queryScopeMatches = requestedQuery !== null &&
    coverage?.query === (requestedQuery || null);
  const scope: Record<string, string | number | boolean | null> = {
    mode: listing ? 'listing' : typeof request.query === 'string' && request.query ? 'document_search' : 'document_read',
    ...(clientId ? { clientId } : {}),
  };
  if (listing && typeof coverage?.query === 'string' && coverage.queryAppliesTo === 'fileName') {
    scope.fileNameQuery = coverage.query;
  }

  let source: MeriResultSourceObservation;
  let outcome: MeriResultOutcome = 'partial';
  let truncated = coverage?.truncated === true;

  if (listing) {
    const docs = Array.isArray(legacyPayload.documents) ? legacyPayload.documents : null;
    const returned = count(coverage?.returned);
    const total = count(coverage?.total);
    const cursorRequested = typeof request.cursor === 'string' && request.cursor.length > 0;
    const paginationComplete = identityKnown && docs !== null && returned === docs.length && total === returned &&
      !cursorRequested && coverage?.complete === true && coverage.paginationComplete === true &&
      coverage.truncated === false && coverage.nextCursor === null && queryScopeMatches &&
      coverage.queryAppliesTo === 'fileName';
    const hasMore = coverage?.truncated === true || typeof coverage?.nextCursor === 'string';
    source = {
      family: 'document', sourceId: SOURCE_ID,
      availability: identityKnown ? 'available' : 'unknown', scope,
      coverage: {
        completeness: paginationComplete ? 'complete' : identityKnown && (hasMore || returned !== total) ? 'partial' : 'unknown',
        ...(coverage?.nextCursor === null || typeof coverage?.nextCursor === 'string'
          ? { continuation: { hasMore, ...(typeof coverage.nextCursor === 'string' ? { cursor: coverage.nextCursor } : {}) } }
          : {}),
        ...(returned !== undefined ? { returnedCount: returned } : {}),
        matchedCount: total ?? null,
      },
      // Listing entries are not content evidence and carry no content provenance.
      provenance: [],
    };
    truncated = hasMore;
    if (paginationComplete && total === 0) outcome = 'not_found_within_scope';
    else if (paginationComplete && total !== undefined && total > 0) outcome = 'succeeded';
  } else {
    const document = asRecord(legacyPayload.document);
    const records = Array.isArray(legacyPayload.records) ? legacyPayload.records : null;
    const section = count(coverage?.section);
    const sectionCount = count(coverage?.sectionCount);
    const returned = records?.length;
    const requestHasCursor = typeof request.cursor === 'string' && request.cursor.length > 0;
    const documentId = typeof document?.id === 'string' ? document.id : null;
    const validIdentity = identityKnown && documentId !== null && documentId === request.documentId &&
      records !== null && records.every((raw) => {
        const row = asRecord(raw); const payload = asRecord(row?.payload); const provenance = asRecord(row?.provenance);
        return typeof row?.recordId === 'string' && payload?.documentId === documentId &&
          typeof payload.text === 'string' && payload.text.trim().length > 0 &&
          provenance?.sourceRecordId === documentId && provenance.clientId === clientId &&
          provenance.sourceTable === SOURCE_ID && typeof provenance.contentHash === 'string' &&
          SHA256.test(provenance.contentHash) && document?.contentHash === provenance.contentHash &&
          typeof provenance.sectionHash === 'string' &&
          SHA256.test(provenance.sectionHash) && count(provenance.section) !== undefined &&
          payload.id === row.recordId &&
          payload.section === provenance.section && payload.section === section &&
          count(provenance.characterStart) !== undefined && payload.characterStart === provenance.characterStart &&
          payload.characterStart === coverage?.characterStart &&
          count(provenance.characterEnd) !== undefined && payload.characterEnd === provenance.characterEnd &&
          payload.characterEnd === coverage?.characterEnd &&
          row?.recordId === `${documentId}:${String(provenance.contentHash).slice(0, 16)}:${String(provenance.section)}:${String(provenance.characterStart)}-${String(provenance.characterEnd)}`;
      });
    const completeRecord = validIdentity && records!.length === 1 ? asRecord(records![0]) : null;
    const completePayload = asRecord(completeRecord?.payload);
    const completeProvenance = asRecord(completeRecord?.provenance);
    const readability = asRecord(coverage?.readability);
    const readabilityScopeMatches = !readability ||
      (readability.section === section && readability.sectionCount === sectionCount &&
        readability.chars === coverage?.sectionCharacters);
    const complete = validIdentity && records!.length === 1 && typeof completePayload?.text === 'string' &&
      completePayload.text.trim().length > 0 && typeof completeProvenance?.sectionHash === 'string' &&
      sha256(completePayload.text) === completeProvenance.sectionHash &&
      readabilityScopeMatches &&
      request.query === undefined && !requestHasCursor && requestedQuery === '' && queryScopeMatches &&
      (request.section === undefined || request.section === 1) &&
      (request.characterOffset === undefined || request.characterOffset === 0) &&
      coverage?.complete === true && coverage.truncated === false && coverage.nextCursor === null &&
      coverage.extractedSectionEmpty === false && coverage.sectionComplete === true &&
      section === 1 && sectionCount === 1 && coverage.characterStart === 0 &&
      coverage.characterEnd === coverage.sectionCharacters && coverage.extractionTruncated === false;
    const hasMore = coverage?.truncated === true || typeof coverage?.nextCursor === 'string';
    const querySearch = typeof request.query === 'string' && request.query.length > 0;
    const explicitlyUnavailable = validIdentity && readability?.status === 'ocr_unavailable';
    const provenance = validIdentity ? records!.flatMap((raw) => {
      const row = asRecord(raw)!; const origin = asRecord(row.provenance)!;
      return [{
        recordId: row.recordId as string,
        sourceId: SOURCE_ID,
        ...(typeof origin.contentHash === 'string' && SHA256.test(origin.contentHash)
          ? { sourceVersion: origin.contentHash } : {}),
        locator: `section:${String(origin.section)};chars:${String(origin.characterStart)}-${String(origin.characterEnd)}`,
      }];
    }) : [];
    source = {
      family: 'document', sourceId: SOURCE_ID,
      availability: explicitlyUnavailable ? 'unavailable' : validIdentity ? 'available' : 'unknown', scope: {
        ...scope, ...(documentId ? { documentId } : {}),
        ...(section !== undefined ? { section } : {}),
        ...(querySearch && coverage?.query === request.query ? { sectionQuery: request.query as string } : {}),
      },
      coverage: {
        completeness: complete ? 'complete' : validIdentity && (hasMore || coverage?.complete === false || querySearch) ? 'partial' : 'unknown',
        ...(coverage?.nextCursor === null || typeof coverage?.nextCursor === 'string'
          ? { continuation: { hasMore, ...(typeof coverage.nextCursor === 'string' ? { cursor: coverage.nextCursor } : {}) } }
          : {}),
        ...(returned !== undefined ? { returnedCount: returned } : {}),
        matchedCount: querySearch && typeof coverage?.matched === 'boolean' ? (coverage.matched ? 1 : 0) : null,
      },
      provenance,
      ...(explicitlyUnavailable ? { failure: { code: 'document_section_unreadable' } } : {}),
    };
    truncated = hasMore || coverage?.extractionTruncated === true || coverage?.continuationBlocked === true;
    if (explicitlyUnavailable) outcome = 'unavailable';
    else if (complete) outcome = 'succeeded';
  }

  const explicitlyUnavailable = source.availability === 'unavailable';
  return createMeriResultEnvelope({ legacyPayload, outcome, sources: [source], truncation: { truncated },
    errors: explicitlyUnavailable ? [{ code: 'document_section_unreadable' }] : [] });
}

/** Successful reads only. Thrown values propagate unchanged and produce no observation. */
export async function observeClientDocumentsCall<T extends RecordValue>(
  call: () => Promise<T>, request: RecordValue,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeClientDocumentsResult(legacyPayload, request)));
  return legacyPayload;
}
