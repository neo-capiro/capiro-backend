import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardIcon, type DashboardIconName } from '../../components/untitledui/dashboard-icons.js';
import type { ShellIdentityViewModel } from '../../adapters/legacy/useShellIdentity.js';
import type { ShellNotificationsViewModel } from '../../adapters/legacy/useShellNotifications.js';
import {
  useNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useRespondToInvite,
} from '../../../pages/workspace/api.js';
import type { WsNotification } from '../../../pages/workspace/types.js';
import {
  useLwNotifications,
  useMarkAllLwNotificationsRead,
  useMarkLwNotificationRead,
  w1Error,
  type LwNotification,
} from '../../pages/legiwatch/lib/wave1-api.js';
import { useShellOverlay } from '../overlay-manager.js';

export function CapiroTopBar({
  brand,
  search,
  actions,
}: {
  brand: ReactNode;
  search?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="capiro-vnext-topbar">
      <div className="capiro-vnext-topbar__brand">{brand}</div>
      <div className="capiro-vnext-topbar__search">{search}</div>
      <div className="capiro-vnext-topbar__actions">{actions}</div>
    </header>
  );
}

/**
 * Brand (`722:2504`). The frame is an 86×36 wordmark and nothing else — its
 * Brand Copy child (`722:2507`, the wordmark text plus environment label) is
 * `hidden`, so the environment badge only renders when a caller explicitly
 * asks for one.
 */
export function CapiroBrand({ environmentLabel }: { environmentLabel?: string }) {
  return (
    <span className="capiro-vnext-brand">
      {/* The real wordmark the canonical shell already ships, not a drawn glyph. */}
      <img className="capiro-vnext-brand-wordmark" src="/logo.png" alt="Capiro" />
      {environmentLabel ? <span className="capiro-vnext-brand-meta">{environmentLabel}</span> : null}
    </span>
  );
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Notification bell (`722:2520`). The badge is count-only; clicking opens a
 * dropdown listing the same in-app notifications app.capiro.ai shows (the
 * shared `/workspace-api/notifications` feed), with inline Accept/Decline for
 * pending collaborator invites. Replaces the old navigate-to-/workspace stub.
 */
export function NotificationBell({
  notifications,
}: {
  notifications: ShellNotificationsViewModel;
}) {
  const navigate = useNavigate();
  const { isOpen, containerRef, toggle, close } = useShellOverlay('notifications');
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Two real feeds, one bell. IDs are namespaced at the boundary so a
  // workspace id and a durable lw notification id can never collide.
  const wsList = useNotifications();
  // Unread-only: the bell is an actionable surface. Read history stays in the
  // inbox; `unread` is the server-side count, never row math.
  const lwList = useLwNotifications(true);
  const wsMarkRead = useMarkNotificationRead();
  const wsMarkAll = useMarkAllNotificationsRead();
  const lwMarkRead = useMarkLwNotificationRead();
  const lwMarkAll = useMarkAllLwNotificationsRead();
  const respond = useRespondToInvite();

  const wsItems = wsList.data?.items ?? [];
  const lwItems = lwList.data?.rows ?? [];
  const wsFailed = wsList.isError;
  const lwFailed = lwList.isError;
  const unavailable = notifications.unavailable || (wsFailed && lwFailed);

  const label = unavailable
    ? 'Notifications unavailable'
    : `Notifications${notifications.unread > 0 ? `, ${notifications.unread} unread` : ''}`;

  const merged = useMemo<Array<
    | { source: 'workspace'; at: number; n: WsNotification }
    | { source: 'committee'; at: number; n: LwNotification }
  >>(() => {
    const out: Array<
      | { source: 'workspace'; at: number; n: WsNotification }
      | { source: 'committee'; at: number; n: LwNotification }
    > = [];
    for (const n of wsItems) out.push({ source: 'workspace', at: Date.parse(n.createdAt) || 0, n });
    for (const n of lwItems) out.push({ source: 'committee', at: Date.parse(n.createdAt) || 0, n });
    // Newest first; a committee alert must never be buried under older items.
    return out.sort((a, b) => b.at - a.at);
  }, [wsItems, lwItems]);

  const onRespond = (draftId: string, collaboratorId: string, action: 'accept' | 'decline') => {
    respond.mutate(
      { draftId, collaboratorId, action },
      {
        onSuccess: () => {
          if (action === 'accept') {
            close();
            navigate(`/workspace/draft/${draftId}`);
          }
        },
      },
    );
  };

  const [actionError, setActionError] = useState<string | null>(null);

  /** Committee/hearing row: mark read, then follow the server deep link.
   *  Navigation happens ONLY after the read persists — a failed read leaves
   *  the row unread and shows an inline error with the bell still open. */
  const openCommittee = (n: LwNotification) => {
    setActionError(null);
    if (n.read) {
      if (n.deepLink) {
        close();
        navigate(n.deepLink);
      }
      return;
    }
    lwMarkRead.mutate(n.id, {
      onSuccess: () => {
        if (n.deepLink) {
          close();
          navigate(n.deepLink);
        }
      },
      onError: (err) => setActionError(w1Error(err) || 'Could not mark this alert read.'),
    });
  };

  const markAllPending = wsMarkAll.isPending || lwMarkAll.isPending;
  const markAll = () => {
    // Both sources, both caches — the dashboard Needs Attention module reads
    // the same lw key, so it clears together with the bell.
    setActionError(null);
    const onError = (err: unknown) =>
      setActionError(w1Error(err) || 'Some notifications could not be marked read.');
    if (!wsFailed) wsMarkAll.mutate(undefined, { onError });
    if (!lwFailed) lwMarkAll.mutate(undefined, { onError });
  };

  return (
    <div className="capiro-vnext-bell-wrap" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="capiro-vnext-bell"
        aria-label={label}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        data-unavailable={unavailable || undefined}
        onClick={() => toggle(triggerRef.current)}
      >
        <DashboardIcon name="Bell01" size={20} />
        {notifications.showBadge ? (
          <span className="capiro-vnext-bell__count" aria-hidden="true">
            {notifications.badgeLabel}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="capiro-vnext-menu capiro-vnext-notif capiro-elevation-popover" role="menu" aria-label="Notifications">
          <div className="capiro-vnext-notif__head">
            <span className="capiro-vnext-notif__title">Notifications</span>
            {notifications.unread > 0 ? (
              <button
                type="button"
                className="capiro-vnext-notif__markall"
                onClick={markAll}
                disabled={markAllPending}
              >
                {markAllPending ? 'Marking…' : 'Mark all read'}
              </button>
            ) : null}
          </div>

          {wsFailed && !lwFailed ? (
            <p className="capiro-vnext-notif__empty" role="alert">
              Workspace notifications are unavailable right now — committee alerts are unaffected.
            </p>
          ) : null}
          {lwFailed && !wsFailed ? (
            <p className="capiro-vnext-notif__empty" role="alert">
              Committee alerts are unavailable right now — workspace notifications are unaffected.
            </p>
          ) : null}
          {actionError ? (
            <p className="capiro-vnext-notif__empty" role="alert">
              {actionError}
            </p>
          ) : null}

          {wsList.isLoading || lwList.isLoading ? (
            <p className="capiro-vnext-notif__empty">Loading…</p>
          ) : unavailable ? (
            <p className="capiro-vnext-notif__empty">Notifications are unavailable right now.</p>
          ) : merged.length === 0 ? (
            <p className="capiro-vnext-notif__empty">
              {notifications.unread > 0
                ? 'Unread notifications exist but could not be loaded — try Mark all read or reload.'
                : 'No notifications'}
            </p>
          ) : (
            <ul className="capiro-vnext-notif__list">
              {merged.map((entry) => {
                if (entry.source === 'committee') {
                  const n = entry.n;
                  return (
                    <li
                      key={`lw-${n.id}`}
                      className="capiro-vnext-notif__item"
                      data-unread={!n.read || undefined}
                    >
                      <button
                        type="button"
                        className="capiro-vnext-notif__open"
                        disabled={lwMarkRead.isPending}
                        onClick={() => openCommittee(n)}
                      >
                        <span className="capiro-vnext-notif__message">
                          <span className="capiro-vnext-notif__source">
                            {n.eventType === 'committee_publication' ? 'Committee publication' : 'Committee'}
                          </span>
                          {n.title}
                        </span>
                        <span className="capiro-vnext-notif__time">{relativeTime(n.createdAt)}</span>
                      </button>
                    </li>
                  );
                }
                const n = entry.n;
                const isInvite = n.kind === 'collab_invite' && n.actionable && n.draftId && n.collaboratorId;
                return (
                  <li
                    key={`ws-${n.id}`}
                    className="capiro-vnext-notif__item"
                    data-unread={!n.read || undefined}
                    onClick={() => {
                      if (!n.read) wsMarkRead.mutate(n.id);
                    }}
                  >
                    <span className="capiro-vnext-notif__message">{n.message}</span>
                    <span className="capiro-vnext-notif__time">{relativeTime(n.createdAt)}</span>
                    {isInvite ? (
                      <span className="capiro-vnext-notif__actions">
                        <button
                          type="button"
                          className="capiro-vnext-notif__accept"
                          disabled={respond.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRespond(n.draftId!, n.collaboratorId!, 'accept');
                          }}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="capiro-vnext-notif__decline"
                          disabled={respond.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRespond(n.draftId!, n.collaboratorId!, 'decline');
                          }}
                        >
                          Decline
                        </button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface ProfileMenuEntry {
  id: string;
  label: string;
  path: string | null;
  icon: DashboardIconName;
  action?: 'profile' | 'sign-out';
  tag?: string;
  destructive?: boolean;
  separated?: boolean;
}

/**
 * Figma `728:2575`, trimmed to Neo's ask: Profile / Settings / Sign out only.
 * "Profile" opens the real Clerk account portal (photo upload, name, etc.)
 * rather than navigating — Clerk owns that surface, not a vnext settings page.
 */
const PROFILE_MENU: readonly ProfileMenuEntry[] = [
  { id: 'profile', label: 'Profile', path: null, icon: 'User01', action: 'profile' },
  { id: 'settings', label: 'Settings', path: '/settings', icon: 'Settings01' },
  { id: 'sign-out', label: 'Sign out', path: null, icon: 'LogOut01', action: 'sign-out', destructive: true, separated: true },
];

export function ProfileMenu({
  identity,
  onNavigate,
  onSignOut,
  onOpenProfile,
}: {
  identity: ShellIdentityViewModel;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
  onOpenProfile: () => void;
}) {
  const { isOpen, containerRef, toggle, close } = useShellOverlay('profile');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const showAvatar = Boolean(identity.imageUrl) && !avatarFailed;

  return (
    <div className="capiro-vnext-profile" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="capiro-vnext-profile__trigger"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={() => toggle(triggerRef.current)}
      >
        <span className="capiro-vnext-avatar" aria-hidden="true">
          {showAvatar ? (
            <img
              src={identity.imageUrl ?? undefined}
              alt=""
              className="capiro-vnext-avatar__img"
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            (identity.initials ?? '—')
          )}
        </span>
        <span className="capiro-vnext-profile__copy">
          <span className="capiro-vnext-profile__name">
            {identity.name ?? (identity.loading ? 'Loading…' : 'Signed in')}
          </span>
          {identity.role ? (
            <span className="capiro-vnext-profile__role">{identity.role}</span>
          ) : null}
        </span>
        <span className="capiro-vnext-profile__chevron" aria-hidden="true">
          <DashboardIcon name="ChevronRight" size={16} />
        </span>
      </button>

      {isOpen ? (
        <div className="capiro-vnext-menu capiro-elevation-popover" role="menu" aria-label="Profile">
          <div className="capiro-vnext-menu__header">
            <p className="capiro-vnext-menu__name">{identity.name ?? 'Signed in'}</p>
            {identity.role ? <p className="capiro-vnext-menu__title">{identity.role}</p> : null}
            {identity.email ? <p className="capiro-vnext-menu__email">{identity.email}</p> : null}
          </div>

          {PROFILE_MENU.map((entry) => {
            const disabled = entry.path === null && !entry.action;
            return (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                className="capiro-vnext-menu__item"
                data-destructive={entry.destructive || undefined}
                data-separated={entry.separated || undefined}
                disabled={disabled}
                aria-disabled={disabled || undefined}
                onClick={() => {
                  if (disabled) return;
                  close();
                  if (entry.action === 'sign-out') {
                    onSignOut();
                    return;
                  }
                  if (entry.action === 'profile') {
                    onOpenProfile();
                    return;
                  }
                  if (entry.path) onNavigate(entry.path);
                }}
              >
                <span className="capiro-vnext-menu__icon" aria-hidden="true">
                  <DashboardIcon name={entry.icon} size={16} />
                </span>
                <span className="capiro-vnext-menu__label">{entry.label}</span>
                {(disabled || entry.tag) ? (
                  <span className="capiro-vnext-menu__tag">
                    {disabled ? 'Not available' : entry.tag}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
