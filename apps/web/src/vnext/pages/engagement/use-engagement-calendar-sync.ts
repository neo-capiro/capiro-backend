import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { meetingsListKey } from '../../../pages/engagement/meetings/meetings-api.js';

/**
 * "Sync calendar" for the vNext Engagement surfaces.
 *
 * ── Why this hook exists ──────────────────────────────────────────────────
 * The vNext Meetings workspace used to sync by dispatching a bare
 * `window.dispatchEvent(new Event('capiro:sync-inbox'))`. The only listener for
 * that event is in `components/AppShell.tsx`, and `App.tsx` renders
 * `<AppShell />` ONLY on the non-vNext surface — on the vNext surface it
 * renders `<VNextApp />` instead and returns before ever reaching AppShell:
 *
 *     if (isVNextSurface) { return (... <VNextApp /> ...); }
 *     return <AppShell />;
 *
 * So on os.capiro.ai the button dispatched an event nothing was listening for.
 * It showed no error, logged nothing, and left the calendar untouched — a
 * control that looked functional and was not. This hook calls the real
 * endpoints from inside the vNext tree, where the listener problem cannot
 * recur.
 *
 * ── What it calls ─────────────────────────────────────────────────────────
 * Per connected mailbox, in order:
 *   - Microsoft: POST /integrations/microsoft/:id/calendar-window?from&to
 *                POST /integrations/microsoft/:id/sync?calendar=true&mail=true
 *   - Google:    POST /integrations/google/:id/sync?calendar=true&mail=true
 *
 * `calendar=true` is the difference from AppShell's inbox sync, which passes
 * `calendar=false&mail=true`. This is the Meetings surface; the calendar is the
 * point. Mail stays on because meeting association keys off synced mail.
 *
 * ── Honesty contract ──────────────────────────────────────────────────────
 * With no connected mailbox there is nothing to sync and no endpoint to call.
 * `canSync` is false and `disabledReason` carries the sentence to show. The
 * caller must render the control disabled with that reason — it must not call
 * `sync()` and report success, and it must not hide the failure.
 */

const CALENDAR_SYNC_WINDOW_DAYS = 14;

/** Matches AppShell's window: local midnight today, forward two weeks. */
function calendarSyncWindow(): { from: string; to: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + CALENDAR_SYNC_WINDOW_DAYS);
  return { from: from.toISOString(), to: to.toISOString() };
}

export interface EngagementIntegrationConnection {
  id: string;
  provider: string;
  status: string;
  accountEmail?: string | null;
  displayName?: string | null;
}

/** The two providers whose sync endpoints exist. Anything else is ignored. */
function syncableProvider(provider: string): 'microsoft' | 'google' | null {
  if (provider === 'microsoft_365') return 'microsoft';
  if (provider === 'google') return 'google';
  return null;
}

export interface EngagementCalendarSync {
  /** True only when at least one connected, syncable mailbox exists. */
  canSync: boolean;
  /** Present exactly when `canSync` is false. Show this, do not invent copy. */
  disabledReason: string | null;
  connectionCount: number;
  isPending: boolean;
  /** Server message from the last failed attempt, or null. */
  error: string | null;
  /** No-ops when `canSync` is false, so a mis-wired caller cannot fake a sync. */
  sync: () => void;
}

function errorText(error: unknown): string {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data
    ?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  return error instanceof Error ? error.message : 'Calendar sync failed.';
}

export function useEngagementCalendarSync(
  options: { onSynced?: (connectionCount: number) => void } = {},
): EngagementCalendarSync {
  const api = useApi();
  const qc = useQueryClient();
  const { onSynced } = options;

  // Same query key AppShell and VNextEngagementRoutes already use, so this
  // shares their cache rather than firing a third request for the same list.
  const connections = useQuery<EngagementIntegrationConnection[]>({
    queryKey: ['engagement-integrations'],
    queryFn: async () =>
      (await api.get<EngagementIntegrationConnection[]>('/api/engagement/integrations')).data,
    staleTime: 30_000,
  });

  const syncable = useMemo(
    () =>
      (connections.data ?? []).filter(
        (connection) =>
          connection.status === 'connected' && syncableProvider(connection.provider) !== null,
      ),
    [connections.data],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const targets = syncable;
      if (!targets.length) {
        // Unreachable through `sync()` below, which gates on canSync. Kept so a
        // direct mutate() cannot silently resolve as a successful no-op.
        throw new Error('Connect a mailbox before syncing the calendar.');
      }
      const window = calendarSyncWindow();
      for (const connection of targets) {
        const kind = syncableProvider(connection.provider);
        if (kind === 'microsoft') {
          await api.post(
            `/api/engagement/integrations/microsoft/${encodeURIComponent(connection.id)}/calendar-window`,
            undefined,
            { params: { from: window.from, to: window.to } },
          );
          await api.post(
            `/api/engagement/integrations/microsoft/${encodeURIComponent(connection.id)}/sync`,
            undefined,
            { params: { calendar: 'true', mail: 'true' } },
          );
        } else if (kind === 'google') {
          // Google's sync takes no from/to — it has no calendar-window route.
          await api.post(
            `/api/engagement/integrations/google/${encodeURIComponent(connection.id)}/sync`,
            undefined,
            { params: { calendar: 'true', mail: 'true' } },
          );
        }
      }
      return targets.length;
    },
    onSuccess: (count) => {
      // Only the keys the vNext Engagement surfaces actually read. AppShell
      // invalidates a much wider set because it also serves the v2 pages; a
      // sync from here should not force-refetch surfaces this shell never
      // renders.
      void qc.invalidateQueries({ queryKey: [meetingsListKey] });
      void qc.invalidateQueries({ queryKey: ['engagement-integrations'] });
      void qc.invalidateQueries({ queryKey: ['engagement-report'] });
      onSynced?.(count);
    },
  });

  const canSync = syncable.length > 0 && !mutation.isPending;
  const sync = useCallback(() => {
    if (syncable.length === 0) return;
    mutation.mutate();
  }, [mutation, syncable.length]);

  return {
    canSync,
    disabledReason:
      syncable.length === 0
        ? connections.isLoading
          ? 'Checking your connected mailboxes…'
          : 'No mailbox is connected, so there is no calendar to sync. Connect one in Settings → Integrations.'
        : null,
    connectionCount: syncable.length,
    isPending: mutation.isPending,
    error: mutation.isError ? errorText(mutation.error) : null,
    sync,
  };
}
