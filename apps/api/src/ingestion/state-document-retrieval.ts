import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  getBillText,
  getSupportingDocument,
  type LegiscanDocument,
} from '../external/legiscan/legiscan.client.js';
import { currentQuotaMonth, LEGISCAN_HARD_CAP, monthToDateQueries } from './legiscan-quota.util.js';
import { fetchStatePublisherDocument, PublisherDocumentError } from './state-publisher-document.js';
import { validDocumentIdentity, type StateDocumentStub } from './state-document-stub.js';

export interface StateDocumentRequest {
  state: string;
  billKey: string;
  providerBillId: number;
  cursorId: string;
  stub: StateDocumentStub;
  apiKey?: string;
  publisherOnly?: boolean;
}
export class StateDocumentRetrievalError extends Error {
  constructor(
    code: string,
    readonly retryAfterMs = 3 * 3600_000,
    readonly publisherFailure?: string,
  ) {
    super(code);
  }
}

function checkedDocument(
  doc: LegiscanDocument | null,
  request: StateDocumentRequest,
): LegiscanDocument {
  const stub = request.stub;
  if (!doc) throw new StateDocumentRetrievalError('DOCUMENT_UNAVAILABLE');
  if (
    doc.bill_id !== request.providerBillId ||
    doc.doc_id !== stub.providerId ||
    doc.text_hash?.toLowerCase() !== stub.providerHash?.toLowerCase() ||
    (stub.mime && doc.mime !== stub.mime) ||
    (stub.size != null && doc.text_size !== stub.size)
  )
    throw new StateDocumentRetrievalError('DOCUMENT_IDENTITY_OR_SOURCE_HASH_CHANGED');
  return doc;
}

/** Existing provider quota cursor owns reservations. Publisher attempts consume
 * no API units. Every API attempt/failure is charged, including transport retries. */
export async function retrieveStateDocument(prisma: PrismaClient, request: StateDocumentRequest) {
  if (!validDocumentIdentity(request.stub))
    throw new StateDocumentRetrievalError('DOCUMENT_IDENTITY_OR_HASH_UNQUALIFIED');
  let publisherFailure = 'PUBLISHER_METADATA_UNQUALIFIED',
    retryAfterMs = 3 * 3600_000;
  try {
    const document = await fetchStatePublisherDocument(
      request.state,
      request.providerBillId,
      request.stub,
    );
    return { document, apiAttempts: 0, acquisition: 'publisher' as const };
  } catch (error) {
    if (error instanceof PublisherDocumentError) {
      publisherFailure = error.message;
      retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs);
    } else publisherFailure = 'PUBLISHER_TRANSPORT_FAILED';
  }
  if (request.publisherOnly || !request.apiKey)
    throw new StateDocumentRetrievalError(publisherFailure, retryAfterMs, publisherFailure);
  const month = currentQuotaMonth(),
    reservationId = randomUUID();
  const budget = Math.min(
    27000,
    LEGISCAN_HARD_CAP,
    Number(process.env.LEGISCAN_MONTHLY_BUDGET ?? 27000),
  );
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('legiscan-research-quota',0))`;
    const used = monthToDateQueries(
      await tx.stateSyncCursor.findMany({ select: { queriesUsed: true, quotaMonth: true } }),
      month,
    );
    if (!Number.isFinite(budget) || budget <= 0 || used + 4 > budget)
      throw new StateDocumentRetrievalError(
        'EXISTING_PROVIDER_BUDGET_HOLD',
        retryAfterMs,
        publisherFailure,
      );
    const updated =
      await tx.$executeRaw`UPDATE state_sync_cursor SET queries_used=CASE WHEN quota_month=${month} THEN queries_used+4 ELSE 4 END,quota_month=${month} WHERE id=${request.cursorId}`;
    if (updated !== 1) throw new StateDocumentRetrievalError('EXISTING_PROVIDER_CURSOR_REQUIRED');
    await tx.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete)
      VALUES(${reservationId},'legiscan-research-query-reservation',${JSON.stringify({ jurisdiction: request.state, billId: request.billKey })}::jsonb,
      ${JSON.stringify({ providerId: request.stub.providerId, kind: request.stub.kind, reservedQueries: 4, quotaMonth: month })}::jsonb,false)`;
  });
  let attempts = 1;
  try {
    const retry = () => {
      attempts++;
    };
    const document = checkedDocument(
      request.stub.kind === 'text'
        ? await getBillText(request.apiKey, request.stub.providerId, retry)
        : await getSupportingDocument(
            request.apiKey,
            request.stub.kind,
            request.stub.providerId,
            retry,
          ),
      request,
    );
    return {
      document,
      apiAttempts: attempts,
      acquisition: 'legiscan-api' as const,
      publisherFailure,
    };
  } catch (error) {
    if (error instanceof StateDocumentRetrievalError) throw error;
    throw new StateDocumentRetrievalError(
      'DOCUMENT_PROVIDER_RETRIEVAL_FAILED',
      retryAfterMs,
      publisherFailure,
    );
  } finally {
    if (attempts < 4)
      await prisma.$executeRaw`UPDATE state_sync_cursor SET queries_used=greatest(0,queries_used-${4 - attempts}) WHERE id=${request.cursorId} AND quota_month=${month}`;
  }
}
