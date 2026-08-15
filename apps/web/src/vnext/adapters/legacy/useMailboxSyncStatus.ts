import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';

export type MailboxSyncState = 'synced' | 'syncing' | 'needs_attention';

interface IntegrationConnection {
  id: string;
  provider: 'microsoft_365' | 'google_workspace' | 'imap_caldav' | 'manual';
  accountEmail: string | null;
  displayName: string | null;
  status: 'needs_configuration' | 'connected' | 'error' | 'disabled';
  lastSyncAt: string | null;
  lastError?: string | null;
}

export interface MailboxSyncViewModel {
  state: MailboxSyncState;
  title: string;
  detail: string;
  connectedCount: number;
}

const PROVIDER_LABELS: Record<IntegrationConnection['provider'], string> = {
  microsoft_365: 'Microsoft 365',
  google_workspace: 'Google Workspace',
  imap_caldav: 'IMAP / CalDAV',
  manual: 'Manual',
};

export function useMailboxSyncStatus(): MailboxSyncViewModel {
  const api = useApi();
  const query = useQuery<IntegrationConnection[]>({
    queryKey: ['engagement-integrations'],
    queryFn: async () =>
      (await api.get<IntegrationConnection[]>('/api/engagement/integrations')).data,
    staleTime: 30_000,
  });

  return useMemo(() => {
    if (query.isLoading || query.isFetching) {
      return {
        state: 'syncing',
        title: 'Mailbox syncing',
        detail: 'Checking connection state',
        connectedCount: 0,
      };
    }

    if (query.isError) {
      return {
        state: 'needs_attention',
        title: 'Mailbox needs attention',
        detail: 'Open integrations to reconnect',
        connectedCount: 0,
      };
    }

    const connections = query.data ?? [];
    const connected = connections.filter(
      (connection) =>
        connection.status === 'connected' &&
        (connection.provider === 'microsoft_365' || connection.provider === 'google_workspace'),
    );
    const unhealthy = connections.find(
      (connection) =>
        connection.provider !== 'manual' &&
        (connection.status === 'error' || connection.status === 'needs_configuration'),
    );

    if (connected.length > 0) {
      const freshest = [...connected].sort((a, b) =>
        String(b.lastSyncAt ?? '').localeCompare(String(a.lastSyncAt ?? '')),
      )[0]!;
      return {
        state: 'synced',
        title: connected.length > 1 ? `${connected.length} mailboxes synced` : 'Mailbox synced',
        detail: `${PROVIDER_LABELS[freshest.provider]} · ${relativeSyncLabel(freshest.lastSyncAt)}`,
        connectedCount: connected.length,
      };
    }

    if (unhealthy) {
      return {
        state: 'needs_attention',
        title: 'Mailbox needs attention',
        detail: `${PROVIDER_LABELS[unhealthy.provider]} · reconnect`,
        connectedCount: 0,
      };
    }

    return {
      state: 'needs_attention',
      title: 'Connect mailbox',
      detail: 'Open integrations to connect email',
      connectedCount: 0,
    };
  }, [query.data, query.isError, query.isFetching, query.isLoading]);
}

function relativeSyncLabel(value: string | null): string {
  if (!value) return 'connected';
  const elapsedMs = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(elapsedMs)) return 'connected';
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
