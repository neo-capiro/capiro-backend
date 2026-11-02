import type { PrismaClient } from '@prisma/client';
import {
  getBillText,
  getSupportingDocument,
  type LegiscanDocument,
} from '../external/legiscan/legiscan.client.js';
import { reservedLegiscanQuery } from './legiscan-query-reservation.js';
import { withLegiscanApiAllowed } from './legiscan-provider-capacity.js';
import { LegiscanProviderCapacityError } from '../external/legiscan/legiscan-capacity.js';
import {
  fetchStatePublisherDocument,
  PublisherDocumentError,
  publisherCooldown,
} from './state-publisher-document.js';
import { validDocumentIdentity, type StateDocumentStub } from './state-document-stub.js';
import { requireQualifiedAlternateFormat } from './state-document-formats.js';

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
    readonly publisherHost?: string,
    readonly publisherHttpStatus?: number,
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
  if (request.stub.format) {
    try {
      await requireQualifiedAlternateFormat(
        prisma,
        request.billKey,
        request.providerBillId,
        request.stub,
      );
    } catch (error) {
      throw new StateDocumentRetrievalError(
        error instanceof Error &&
          ['DOCUMENT_FORMAT_PROOF_REQUIRED', 'DOCUMENT_FORMAT_INVENTORY_MISMATCH'].includes(
            error.message,
          )
          ? error.message
          : 'DOCUMENT_FORMAT_PROOF_LOOKUP_FAILED',
      );
    }
  }
  let publisherFailure = 'PUBLISHER_METADATA_UNQUALIFIED',
    retryAfterMs = 3 * 3600_000;
  try {
    const document = await fetchStatePublisherDocument(
      request.state,
      request.providerBillId,
      request.stub,
      publisherCooldown(prisma),
    );
    return { document, apiAttempts: 0, acquisition: 'publisher' as const };
  } catch (error) {
    if (error instanceof PublisherDocumentError) {
      publisherFailure = error.message;
      retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs);
      if (
        [
          'PUBLISHER_RETRY_AFTER',
          'PUBLISHER_COOLDOWN_ACTIVE',
          'PUBLISHER_COOLDOWN_STATE_FAILED',
        ].includes(publisherFailure)
      )
        throw new StateDocumentRetrievalError(
          publisherFailure,
          retryAfterMs,
          publisherFailure,
          error.host,
          error.httpStatus,
        );
    } else publisherFailure = 'PUBLISHER_TRANSPORT_FAILED';
  }
  if (request.stub.format || request.publisherOnly || !request.apiKey)
    throw new StateDocumentRetrievalError(publisherFailure, retryAfterMs, publisherFailure);
  const apiKey = request.apiKey;
  try {
    const result = await withLegiscanApiAllowed(prisma, apiKey, () =>
      reservedLegiscanQuery(
        prisma,
        {
          ...request,
          operation: request.stub.kind === 'text' ? 'getBillText' : 'getSupportingDocument',
          providerId: request.stub.providerId,
        },
        async (retry) =>
          checkedDocument(
            request.stub.kind === 'text'
              ? await getBillText(apiKey, request.stub.providerId, retry)
              : await getSupportingDocument(
                  apiKey,
                  request.stub.kind,
                  request.stub.providerId,
                  retry,
                ),
            request,
          ),
      ),
    );
    return {
      document: result.value,
      apiAttempts: result.attempts,
      acquisition: 'legiscan-api' as const,
      publisherFailure,
    };
  } catch (error) {
    if (error instanceof LegiscanProviderCapacityError)
      throw new StateDocumentRetrievalError(
        'EXISTING_PROVIDER_CAPACITY_HOLD',
        error.retryAfterMs,
        publisherFailure,
      );
    if (error instanceof StateDocumentRetrievalError) throw error;
    if (error instanceof Error && error.message.startsWith('EXISTING_PROVIDER_'))
      throw new StateDocumentRetrievalError(error.message, retryAfterMs, publisherFailure);
    throw new StateDocumentRetrievalError(
      'DOCUMENT_PROVIDER_RETRIEVAL_FAILED',
      retryAfterMs,
      publisherFailure,
    );
  }
}
