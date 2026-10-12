import { BadRequestException } from '@nestjs/common';
import { EngagementConnectionStatus, EngagementProvider, type Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';

/** Shared with the established send resolver; provider adapters retain token authority. */
export function ownedSendingMailboxWhere(
  ctx: TenantContext,
): Prisma.IntegrationConnectionWhereInput {
  return {
    tenantId: ctx.tenantId,
    provider: { in: [EngagementProvider.microsoft_365, EngagementProvider.google_workspace] },
    status: EngagementConnectionStatus.connected,
    createdByUserId: ctx.userId,
    token: { isNot: null },
  };
}

/** Deliberately excludes token material, sync state, errors, scopes and tenant/user IDs. */
export const sendingMailboxSelect = {
  id: true,
  provider: true,
  accountEmail: true,
  displayName: true,
} as const satisfies Prisma.IntegrationConnectionSelect;

export type SendingMailbox = Prisma.IntegrationConnectionGetPayload<{
  select: typeof sendingMailboxSelect;
}>;

export function mailboxSender(connection: SendingMailbox) {
  // Unknown mailbox identity must not be replaced by the actor's profile address.
  const email = connection.accountEmail?.trim();
  if (!email) {
    throw new BadRequestException('Reconnect the selected sending mailbox to confirm its address.');
  }
  return { email, name: connection.displayName?.trim() || null };
}

export function sendingMailboxProjection(connection: SendingMailbox) {
  const sender = mailboxSender(connection);
  return {
    id: connection.id,
    provider: connection.provider,
    accountEmail: sender.email,
    displayName: sender.name,
    // Eligibility is a local snapshot, not evidence that provider consent remains valid.
    availability: 'available' as const,
    signaturePolicy: 'actor' as const,
  };
}
