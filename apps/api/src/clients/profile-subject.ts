import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { prospectResourceScope, type TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { requireOwnerClient } from './client-ordered-owner.access.js';

export type ProfileSubject = { kind: 'client' | 'prospect'; id: string };
export function profileSubject(kind: ProfileSubject['kind'], id: string): ProfileSubject {
  if (!isUUID(id)) throw new BadRequestException('Invalid profile identifier');
  return { kind, id: id.toLowerCase() };
}
export const subjectColumn = (subject: ProfileSubject): 'client_id' | 'prospect_id' =>
  subject.kind === 'client' ? 'client_id' : 'prospect_id';

/** Core remains the authorization owner. A prospect ID never enters client authorization. */
export async function requireProfileSubject(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  subject: ProfileSubject,
  write = false,
  research = false,
  exclusive = false,
) {
  if (subject.kind === 'client') {
    await requireOwnerClient(
      tx,
      ctx,
      subject.id,
      write,
      false,
      write || exclusive ? 'update' : 'share',
    );
    return;
  }
  const scope = await prospectResourceScope(
    tx,
    ctx.tenantId,
    { userId: ctx.userId },
    subject.id,
    write ? 'write' : 'read',
  );
  if (!scope || scope.clerkUserId !== ctx.clerkUserId)
    throw new NotFoundException('Profile not found');
  const rows = await tx.$queryRawUnsafe<Array<{ convertedAt: Date | null }>>(
    `SELECT converted_at AS "convertedAt" FROM business_development_prospects
     WHERE tenant_id=$1::uuid AND id=$2::uuid FOR ${write || exclusive ? 'UPDATE' : 'SHARE'}`,
    ctx.tenantId,
    subject.id,
  );
  if (!rows.length) throw new NotFoundException('Profile not found');
  if (research && rows[0]!.convertedAt)
    throw new ConflictException(
      'This prospect was converted; research continues on its client profile',
    );
}

export async function requireProfileEditor(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  subject: ProfileSubject,
) {
  if (subject.kind === 'client')
    return requireOwnerClient(tx, ctx, subject.id, false, false, 'update');
  return requireProfileSubject(tx, ctx, subject, true, true);
}
