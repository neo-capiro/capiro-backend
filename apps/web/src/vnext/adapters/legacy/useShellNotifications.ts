import { useMemo } from 'react';
import { useNotifications } from '../../../pages/workspace/api.js';
import { useLwNotifications } from '../../pages/legiwatch/lib/wave1-api.js';

export interface ShellNotificationsViewModel {
  loading: boolean;
  /** True only when BOTH feeds are unavailable — one failing feed degrades the
   *  badge to the surviving source rather than hiding the whole bell. */
  unavailable: boolean;
  /** Combined workspace + committee/hearing unread count. */
  unread: number;
  /** Figma `722:2522` only renders the count chip when there is something unread. */
  showBadge: boolean;
  badgeLabel: string;
}

/**
 * Top-bar notification badge (`722:2520`). The Figma interaction contract states
 * the badge is count-only and details open in a dedicated surface, so this
 * adapter deliberately exposes no item list.
 *
 * The count merges TWO real feeds that share one React Query cache with their
 * detail surfaces:
 *  - workspace notifications (`/workspace-api/notifications`) — invites etc.
 *  - committee/hearing notifications (`/api/legiwatch/live-hearings/notifications`)
 *
 * The workspace feed 403s for users without a tenant claim; that is not an
 * error state. A committee-feed failure never masks workspace unread (and
 * vice versa) — the badge shows what is KNOWN, per-source failure states stay
 * on the bell's dropdown.
 */
export function useShellNotifications(): ShellNotificationsViewModel {
  const workspace = useNotifications();
  const committee = useLwNotifications(true);

  return useMemo(() => {
    const wsFailed = workspace.isError;
    const lwFailed = committee.isError;
    const loading =
      (!wsFailed && workspace.isLoading) || (!lwFailed && committee.isLoading);
    const unavailable = wsFailed && lwFailed;

    const wsUnread =
      !wsFailed && Number.isFinite(workspace.data?.unread)
        ? Math.max(0, workspace.data!.unread)
        : 0;
    const lwUnread =
      !lwFailed && Number.isFinite(committee.data?.unread)
        ? Math.max(0, committee.data!.unread)
        : 0;
    const unread = wsUnread + lwUnread;

    return {
      loading,
      unavailable,
      unread,
      showBadge: unread > 0,
      badgeLabel: unread > 99 ? '99+' : String(unread),
    };
  }, [
    workspace.data,
    workspace.isError,
    workspace.isLoading,
    committee.data,
    committee.isError,
    committee.isLoading,
  ]);
}
