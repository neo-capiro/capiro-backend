import { useMemo } from 'react';
import { useNotifications } from '../../../pages/workspace/api.js';

export interface ShellNotificationsViewModel {
  loading: boolean;
  /** The bell 403s for users without a tenant claim; that is not an error state. */
  unavailable: boolean;
  unread: number;
  /** Figma `722:2522` only renders the count chip when there is something unread. */
  showBadge: boolean;
  badgeLabel: string;
}

/**
 * Top-bar notification badge (`722:2520`). The Figma interaction contract states
 * the badge is count-only and details open in a dedicated surface, so this
 * adapter deliberately exposes no item list.
 */
export function useShellNotifications(): ShellNotificationsViewModel {
  const query = useNotifications();

  return useMemo(() => {
    if (query.isLoading) {
      return { loading: true, unavailable: false, unread: 0, showBadge: false, badgeLabel: '' };
    }
    if (query.isError || !query.data) {
      return { loading: false, unavailable: true, unread: 0, showBadge: false, badgeLabel: '' };
    }

    const unread = Number.isFinite(query.data.unread) ? Math.max(0, query.data.unread) : 0;
    return {
      loading: false,
      unavailable: false,
      unread,
      showBadge: unread > 0,
      badgeLabel: unread > 99 ? '99+' : String(unread),
    };
  }, [query.data, query.isError, query.isLoading]);
}
