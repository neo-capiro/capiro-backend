import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { ownMailThreadWhere } from './engagement-access.helpers.js';
import { activeMailMessageWhere } from './mail-message-state.js';
import { prepareMailReply, REPLY_UNAVAILABLE } from './single-mail-reply.js';

/** Known owned addresses only. A bounded result is not a claim of all provider aliases. */
export async function replySelfEmails(tx: Prisma.TransactionClient, ctx: TenantContext): Promise<string[]> {
  const mailboxes = await tx.integrationConnection.findMany({
    where: { tenantId: ctx.tenantId, createdByUserId: ctx.userId }, select: { accountEmail: true }, take: 101,
  });
  const actor = await tx.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });
  if (mailboxes.length > 100 || !actor?.email) throw new BadRequestException(REPLY_UNAVAILABLE);
  return [actor.email, ...mailboxes.flatMap(box => box.accountEmail ? [box.accountEmail] : [])];
}

/** Uses the same current message/connection owners as ordinary mail admission. */
export async function resolveSingleMailReply(tx: Prisma.TransactionClient, ctx: TenantContext, input: {
  operation?: 'reply'; originalMessageId?: string; originalUpdatedAt?: string; threadId?: string;
  senderConnectionId?: string; subject: string; to: Array<{ email: string }>;
  cc?: Array<{ email: string }>; bcc?: Array<{ email: string }>;
}) {
  if (input.operation !== 'reply' || !input.originalMessageId || !input.originalUpdatedAt ||
      !input.threadId || !input.senderConnectionId || input.to.length !== 1 || input.cc?.length || input.bcc?.length)
    throw new BadRequestException(REPLY_UNAVAILABLE);
  const source = await tx.mailMessage.findFirst({
    where: { id: input.originalMessageId, tenantId: ctx.tenantId, threadId: input.threadId,
      connectionId: input.senderConnectionId, ...activeMailMessageWhere(),
      thread: { tenantId: ctx.tenantId, ...ownMailThreadWhere(ctx.userId) } },
    include: { thread: { include: { connection: true } } },
  });
  if (!source?.thread.connection || source.thread.connection.tenantId !== ctx.tenantId ||
      source.thread.connection.createdByUserId !== ctx.userId) throw new NotFoundException('Original mail message not found');
  const reply = prepareMailReply(source, source.thread, source.thread.connection, await replySelfEmails(tx, ctx));
  if (!reply || reply.context.originalUpdatedAt !== input.originalUpdatedAt ||
      reply.context.subject !== input.subject || reply.provider.toEmail !== input.to[0]?.email.trim().toLowerCase())
    throw new BadRequestException('This original or its reply recipients changed. Review the original again.');
  return reply;
}

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
  return assertSingleMailAccess(tx, ctx, input, associatedThreadWhere, ownMailThreadWhere(ctx.userId));
}

/** Durable reads require current authority and the retained original thread, not an active body. */
export async function assertSingleMailIntentReadAuthority(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  input: Pick<SingleMailAssociations, 'clientId' | 'threadId' | 'senderConnectionId'>,
  associatedThreadWhere: (clientId: string) => Promise<Prisma.MailThreadWhereInput>,
): Promise<void> {
  return assertSingleMailAccess(tx, ctx, {
    clientId: input.clientId, threadId: input.threadId,
    senderConnectionId: input.senderConnectionId, to: [],
  }, associatedThreadWhere, {
    connection: { createdByUserId: ctx.userId },
  });
}

async function assertSingleMailAccess(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  input: SingleMailAssociations,
  associatedThreadWhere: (clientId: string) => Promise<Prisma.MailThreadWhereInput>,
  threadOwnerWhere: Prisma.MailThreadWhereInput,
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
      where: { id: input.threadId, tenantId: ctx.tenantId, ...threadOwnerWhere },
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
              { id: thread.id, tenantId: ctx.tenantId, ...threadOwnerWhere },
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
