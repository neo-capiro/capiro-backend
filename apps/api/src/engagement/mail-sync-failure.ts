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
    permission_denied: `${provider} denied a sync request. Retry sync; if it persists, review account access in Settings.`,
  };
  // Resource 401/403 responses may concern an expired access token or a request
  // predating a successful reconnect. They do not establish a consent failure.
  const requiresReconnect = kind === 'needs_reconnect' || kind === 'mailbox_not_enabled';
  return {
    status: requiresReconnect
      ? EngagementConnectionStatus.needs_configuration
      : EngagementConnectionStatus.error,
    lastError: reasons[kind],
    nextSyncAt: requiresReconnect ? null : new Date(Date.now() + 15 * 60 * 1000),
  };
}
