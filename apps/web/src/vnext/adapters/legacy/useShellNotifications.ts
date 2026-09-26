import { useMemo } from 'react';
import { useNotifications } from '../../../pages/workspace/api.js';
import { useLwNotifications } from '../../pages/legiwatch/lib/wave1-api.js';
import { useBizDevBellAlerts } from '../../pages/business-development/bell-alerts.js';
import { useMe } from '../../../lib/me.js';

export interface ShellNotificationsViewModel {
  loading: boolean;
  /** True only when EVERY enabled feed is unavailable — one failing feed
   *  degrades the badge to the surviving sources rather than hiding the bell. */
  unavailable: boolean;
  /** Combined workspace + committee/hearing + Business Development unread count. */
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
 * The count merges THREE real feeds that share one React Query cache with their
 * detail surfaces:
 *  - workspace notifications (`/workspace-api/notifications`) — invites etc.
 *  - committee/hearing notifications (`/api/legiwatch/live-hearings/notifications`)
 *  - Business Development prospect alerts (`/api/business-development/alerts`,
 *    unread-only) — ONLY when `/api/me` reports
 *    `features.businessDevelopmentWatch === true`; otherwise zero Phase 5
 *    requests are made. Stored alerts only: no provider calls or polling here.
 *
 * The workspace feed 403s for users without a tenant claim; that is not an
 * error state. A failure in any single feed never masks the others — the
 * badge shows what is KNOWN, per-source failure states stay on the dropdown.
 */
export function useShellNotifications(): ShellNotificationsViewModel {
  const workspace = useNotifications();
  const committee = useLwNotifications(true);
  const meData = useMe().data;
  const bdWatchOn = meData?.features.businessDevelopmentWatch === true;
  const bd = useBizDevBellAlerts(meData?.tenant.id, bdWatchOn);

  return useMemo(() => {
    const wsFailed = workspace.isError;
    const lwFailed = committee.isError;
    const bdFailed = bdWatchOn && bd.isError;
    const loading =
      (!wsFailed && workspace.isLoading) ||
      (!lwFailed && committee.isLoading) ||
      (bdWatchOn && !bdFailed && bd.isLoading);
    const unavailable = wsFailed && lwFailed && (!bdWatchOn || bdFailed);

    const wsUnread =
      !wsFailed && Number.isFinite(workspace.data?.unread)
        ? Math.max(0, workspace.data!.unread)
        : 0;
    const lwUnread =
      !lwFailed && Number.isFinite(committee.data?.unread)
        ? Math.max(0, committee.data!.unread)
        : 0;
    const bdUnread = bdWatchOn && !bdFailed ? Math.max(0, bd.data?.unreadCount ?? 0) : 0;
    const unread = wsUnread + lwUnread + bdUnread;

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
    bdWatchOn,
    bd.data,
    bd.isError,
    bd.isLoading,
  ]);
}
