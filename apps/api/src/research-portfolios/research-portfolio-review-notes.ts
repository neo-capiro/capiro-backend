import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { loadAuthorizedResearchPortfolio } from './research-portfolio-access.js';

/** One transactional note owner for the native route and management adapter. */
export async function addResearchPortfolioReviewNote(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  portfolioId: string,
  reviewId: string,
  input: { body: string; idempotencyKey: string; expectedRevision?: number },
) {
  const body = input.body?.trim();
  const key = input.idempotencyKey?.trim();
  if (!body || body.length > 5000)
    throw new BadRequestException('Note must be between 1 and 5000 characters');
  if (!key || key.length > 128)
    throw new BadRequestException('idempotencyKey must be between 1 and 128 characters');
  if (
    input.expectedRevision !== undefined &&
    (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
  )
    throw new BadRequestException('expectedRevision must be a positive integer');
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        portfolioId,
        reviewId,
        body,
        expectedRevision: input.expectedRevision ?? null,
      }),
    )
    .digest('hex');
  // $executeRaw: pg_advisory_xact_lock returns void; $queryRaw fails to deserialize void
  // (Prisma P2010), the same defect confirmed on the snapshot lock.
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':portfolio-event:' + key}, 0))`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM research_portfolios WHERE id = ${portfolioId}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`,
  );
  const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
  const replay = await tx.researchPortfolioEvent.findFirst({
    where: { tenantId: ctx.tenantId, idempotencyKey: key },
  });
  if (replay) {
    if (
      replay.portfolioId !== portfolioId ||
      replay.actorUserId !== ctx.userId ||
      replay.eventKind !== 'review_note_added' ||
      replay.payloadFingerprint !== requestHash
    )
      throw new ConflictException('Idempotency key was already used for different content');
    const payload = replay.payload as { noteId?: string; reviewRevision?: number };
    const note = payload.noteId
      ? await tx.researchPortfolioReviewNote.findFirst({
          where: {
            id: payload.noteId,
            tenantId: ctx.tenantId,
            portfolioId,
            reviewId,
            authorUserId: ctx.userId,
          },
        })
      : null;
    if (!note) throw new ConflictException('Review note receipt is unavailable');
    return { note, event: replay, reviewRevision: payload.reviewRevision ?? null };
  }
  if (portfolio.lifecycle === 'archived')
    throw new ConflictException('Archived portfolios are read-only');
  const review = await tx.researchPortfolioReview.findFirst({
    where: { id: reviewId, tenantId: ctx.tenantId, portfolioId },
  });
  if (!review) throw new NotFoundException('Review not found');
  if (input.expectedRevision !== undefined && review.revision !== input.expectedRevision)
    throw new ConflictException('Review revision mismatch');
  const note = await tx.researchPortfolioReviewNote.create({
    data: { tenantId: ctx.tenantId, portfolioId, reviewId, authorUserId: ctx.userId, body },
  });
  await tx.researchPortfolio.update({
    where: { id: portfolioId, tenantId: ctx.tenantId },
    data: { revision: { increment: 1 } },
  });
  const event = await tx.researchPortfolioEvent.create({
    data: {
      tenantId: ctx.tenantId,
      portfolioId,
      eventKind: 'review_note_added',
      aggregateRevision: portfolio.revision + 1,
      actorUserId: ctx.userId,
      idempotencyKey: key,
      payloadFingerprint: requestHash,
      payload: { noteId: note.id, reviewId, reviewRevision: review.revision },
    },
  });
  return { note, event, reviewRevision: review.revision };
}
