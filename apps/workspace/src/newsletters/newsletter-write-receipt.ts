import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { NewsletterSaveRefusal, NewsletterWriteReceipt } from '@capiro/shared/newsletter';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { isUuid } from '../hillday/hillday-source.service.js';

export type NewsletterWriteIdentity = { tenantId: string; clerkUserId: string };
export type NewsletterReceiptRow = {
  request_id: string;
  operation: 'create' | 'save';
  document_id: string;
  previous_revision: number | null;
  revision: number;
  input_hash: string;
  content_hash: string;
  source_client_ids: string[];
  created_at: Date;
};

export function newsletterRequestId(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value))
    throw new BadRequestException('A valid newsletter requestId is required.');
  return value.toLowerCase();
}
/** Existing strict server JSON codec; key order is not a distinct write. */
export function newsletterWriteHash(value: unknown): string {
  try {
    return createHash('sha256').update(canonicalizeCoreRetainedJson(value)).digest('hex');
  } catch {
    throw new BadRequestException('Newsletter request must contain valid JSON.');
  }
}
export function newsletterReceiptView(row: NewsletterReceiptRow): NewsletterWriteReceipt {
  return {
    requestId: row.request_id,
    operation: row.operation,
    documentId: row.document_id,
    previousRevision: row.previous_revision,
    revision: row.revision,
    inputHash: row.input_hash,
    contentHash: row.content_hash,
    hashFormat: 'newsletter-write-jcs-v1',
    createdAt: row.created_at.toISOString(),
  };
}
export async function readNewsletterReceipt(
  tx: Prisma.TransactionClient,
  ctx: NewsletterWriteIdentity,
  requestId: string,
): Promise<NewsletterReceiptRow | null> {
  const [receipt] = await tx.$queryRaw<
    NewsletterReceiptRow[]
  >`SELECT request_id,operation,document_id,
    previous_revision,revision,input_hash,content_hash,source_client_ids,created_at
    FROM ws_newsletter_write_receipt WHERE tenant_id=${ctx.tenantId}::uuid
    AND actor_id=${ctx.clerkUserId} AND request_id=${requestId}::uuid`;
  return receipt ?? null;
}

/** Same owner-local advisory-lock + atomic receipt pattern as ordinary drafts.
 * The receipt has no document FK, so deletion cannot turn replay into creation. */
export async function commitNewsletterRequest(
  prisma: PrismaService,
  ctx: NewsletterWriteIdentity,
  request: {
    requestId: string;
    inputHash: string;
  } & ({ operation: 'create' } | { operation: 'save'; documentId: string; previousRevision: number }),
  write: (tx: Prisma.TransactionClient) => Promise<{
    id: string;
    revision: number;
    previousRevision: number | null;
    contentHash: string;
    sourceClientIds: string[];
  } | null>,
): Promise<NewsletterReceiptRow> {
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant',${ctx.tenantId},true)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['newsletter-write', ctx.tenantId, ctx.clerkUserId, request.requestId])},0))`;
      const prior = await readNewsletterReceipt(tx, ctx, request.requestId);
      if (prior) {
        if (
          prior.operation !== request.operation ||
          prior.input_hash !== request.inputHash ||
          (request.operation === 'save' && prior.document_id !== request.documentId)
        )
          throw new ConflictException(
            'This newsletter requestId is already bound to different inputs.',
          );
        return prior;
      }
      const saved = await write(tx);
      // A fresh zero-update save has no document/receipt write. Settle this transaction
      // successfully before exposing that fact; callback/commit/rollback errors stay unknown.
      if (saved === null) return null;
      const [receipt] = await tx.$queryRaw<
        NewsletterReceiptRow[]
      >`INSERT INTO ws_newsletter_write_receipt
      (tenant_id,actor_id,request_id,operation,document_id,previous_revision,revision,input_hash,content_hash,source_client_ids)
      VALUES (${ctx.tenantId}::uuid,${ctx.clerkUserId},${request.requestId}::uuid,${request.operation},
        ${saved.id}::uuid,${saved.previousRevision},${saved.revision},${request.inputHash},${saved.contentHash},${saved.sourceClientIds}::uuid[])
      RETURNING request_id,operation,document_id,previous_revision,revision,input_hash,content_hash,source_client_ids,created_at`;
      if (!receipt) throw new Error('Newsletter receipt was not persisted');
      return receipt;
    },
    { timeout: 30000 },
  );
  if (result === null) {
    if (request.operation !== 'save') throw new Error('Unexpected empty newsletter create result');
    const refusal: NewsletterSaveRefusal = {
      code: 'NEWSLETTER_SAVE_CAS_REFUSED',
      disposition: 'not_committed',
      requestId: request.requestId,
      operation: 'save',
      documentId: request.documentId,
      previousRevision: request.previousRevision,
    };
    throw new ConflictException(refusal);
  }
  return result;
}
