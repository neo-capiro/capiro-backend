import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { ownMailThreadWhere } from './engagement-access.helpers.js';

export type SingleMailAssociations = {
  clientId?: string;
  personIds?: string[];
  threadId?: string;
  senderConnectionId?: string;
  to: Array<{ email: string }>;
};

/** Current domain admission, repeated immediately before the durable send claim. */
export async function assertSingleMailAuthority(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  input: SingleMailAssociations,
  associatedThreadWhere: (clientId: string) => Promise<Prisma.MailThreadWhereInput>,
): Promise<void> {
  const member = await tx.tenantMembership.findFirst({
    where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
    select: { id: true },
  });
  if (!member) throw new ForbiddenException('Current membership required');
  if (input.senderConnectionId) {
    const mailbox = await tx.integrationConnection.findFirst({
      where: { id: input.senderConnectionId, tenantId: ctx.tenantId, createdByUserId: ctx.userId },
      select: { id: true },
    });
    if (!mailbox) throw new NotFoundException('Sending mailbox not found');
  }
  const clientReadable = async (clientId: string) => {
    const client = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
      select: { id: true },
    });
    if (!client || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId))) {
      throw new NotFoundException('Client not found');
    }
  };
  if (input.clientId) await clientReadable(input.clientId);
  const ids = [...new Set(input.personIds ?? [])];
  if (ids.length) {
    if (!input.clientId) throw new BadRequestException('Client required for selected people');
    const people = await tx.clientPerson.findMany({
      where: { id: { in: ids }, tenantId: ctx.tenantId, clientId: input.clientId },
      select: { id: true, email: true },
    });
    const recipients = new Set(input.to.map((r) => r.email.trim().toLowerCase()));
    if (
      people.length !== ids.length ||
      people.some((p) => !p.email || !recipients.has(p.email.trim().toLowerCase()))
    ) {
      throw new NotFoundException('Selected person not found');
    }
  }
  if (input.threadId) {
    const thread = await tx.mailThread.findFirst({
      where: { id: input.threadId, tenantId: ctx.tenantId, ...ownMailThreadWhere(ctx.userId) },
      select: { id: true, clientId: true, connectionId: true },
    });
    if (!thread) throw new NotFoundException('Mail thread not found');
    if (thread.clientId) await clientReadable(thread.clientId);
    if (input.senderConnectionId && thread.connectionId !== input.senderConnectionId) {
      throw new NotFoundException('Mail thread not found');
    }
    if (input.clientId && thread.clientId !== input.clientId) {
      // A direct assignment is authoritative. Recipient-derived null-client histories
      // may be used only when the existing Portfolio association query admits them.
      if (
        thread.clientId ||
        !(await tx.mailThread.findFirst({
          where: {
            AND: [
              { id: thread.id, tenantId: ctx.tenantId, ...ownMailThreadWhere(ctx.userId) },
              await associatedThreadWhere(input.clientId),
            ],
          },
          select: { id: true },
        }))
      )
        throw new NotFoundException('Mail thread not found');
    }
  }
}
