import { BadRequestException } from '@nestjs/common';
import { EngagementConnectionStatus } from '@prisma/client';

/** The token owner has already durably held this connection under its refresh fence. */
export class MailboxReconnectRequiredError extends BadRequestException {
  constructor(message: string) {
    super(message);
  }
}

export type MailSyncFailureKind =
  'transient' | 'needs_reconnect' | 'mailbox_not_enabled' | 'permission_denied';

/** One status/retry policy for both existing provider owners; no provider bytes are persisted. */
export function mailSyncFailureData(
  kind: MailSyncFailureKind,
  provider: 'Google Workspace' | 'Microsoft 365',
) {
  const reasons: Record<MailSyncFailureKind, string> = {
    transient: `${provider} sync could not complete. Retry sync later.`,
    needs_reconnect: `Reconnect ${provider} in Settings to continue syncing.`,
    mailbox_not_enabled:
      'This Microsoft account has no Exchange Online mailbox. Reconnect with a licensed mailbox account.',
    permission_denied: `${provider} denied the required mailbox permissions. Reconnect in Settings or ask your administrator to review access.`,
  };
  return {
    status:
      kind === 'transient'
        ? EngagementConnectionStatus.error
        : EngagementConnectionStatus.needs_configuration,
    lastError: reasons[kind],
    nextSyncAt: kind === 'transient' ? new Date(Date.now() + 15 * 60 * 1000) : null,
  };
}
