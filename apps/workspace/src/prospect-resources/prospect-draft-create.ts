import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { prospectResourceScope } from '@capiro/shared';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CreateDraftDto } from '../drafts/dto/draft.dto.js';

export async function createProspectDraft<T extends { id: string }>(
  prisma: PrismaService,
  tenantId: string,
  ownerId: string,
  dto: CreateDraftDto,
  create: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  if (
    !dto.prospectId ||
    !dto.requestId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      dto.requestId,
    )
  )
    throw new BadRequestException('Prospect drafts require a request UUID');
  const prospectId = dto.prospectId.toLowerCase();
  const requestId = dto.requestId.toLowerCase();
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        prospectId,
        industry: dto.industry ?? null,
        product: dto.product ?? null,
        client: dto.client ?? null,
        docTitle: dto.docTitle ?? null,
      }),
    )
    .digest('hex');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
    if (!(await prospectResourceScope(tx, tenantId, { clerkUserId: ownerId }, prospectId, 'read')))
      throw new NotFoundException('Prospect resource not found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + ownerId + ':' + requestId},0))`;
    const receipt = await tx.wsProspectDraftReceipt.findFirst({
      where: { tenantId, ownerId, requestId },
    });
    if (receipt) {
      if (receipt.inputHash !== inputHash || receipt.prospectId !== prospectId)
        throw new ConflictException({ code: 'prospect_draft_request_conflict' });
      const replay = await tx.wsDraft.findFirst({
        where: { id: receipt.draftId, tenantId, ownerId, prospectId },
        include: { documents: { orderBy: { ordinal: 'asc' } } },
      });
      if (!replay) throw new ConflictException({ code: 'prospect_draft_consumed' });
      return replay;
    }
    if (!(await prospectResourceScope(tx, tenantId, { clerkUserId: ownerId }, prospectId, 'write')))
      throw new NotFoundException('Prospect resource not found');
    const draft = await create(tx);
    await tx.wsProspectDraftReceipt.create({
      data: {
        tenantId,
        ownerId,
        requestId,
        prospectId,
        inputHash,
        draftId: draft.id,
      },
    });
    return draft;
  });
}
