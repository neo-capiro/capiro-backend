import type { MailboxSyncViewModel } from '../../adapters/legacy/useMailboxSyncStatus.js';

export const FOUNDATION_MAILBOX_STATES: MailboxSyncViewModel[] = [
  {
    state: 'synced',
    title: 'Mailbox synced',
    detail: 'Google Workspace · 2m ago',
    connectedCount: 1,
  },
  {
    state: 'syncing',
    title: 'Mailbox syncing',
    detail: 'Checking connection state',
    connectedCount: 1,
  },
  {
    state: 'needs_attention',
    title: 'Mailbox needs attention',
    detail: 'Microsoft 365 · reconnect',
    connectedCount: 0,
  },
];

export const FOUNDATION_SELECT_OPTIONS = [
  { value: 'federal', label: 'Federal' },
  { value: 'state', label: 'State' },
];
