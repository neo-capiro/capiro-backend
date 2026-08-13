import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import type { ShellIdentityViewModel } from '../../adapters/legacy/useShellIdentity.js';
import type { ShellNotificationsViewModel } from '../../adapters/legacy/useShellNotifications.js';
import {
  useNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useRespondToInvite,
} from '../../../pages/workspace/api.js';
import type { WsNotification } from '../../../pages/workspace/types.js';
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

  const list = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const respond = useRespondToInvite();

  const items: WsNotification[] = list.data?.items ?? [];
  const unavailable = notifications.unavailable || list.isError;

  const label = unavailable
    ? 'Notifications unavailable'
    : `Notifications${notifications.unread > 0 ? `, ${notifications.unread} unread` : ''}`;

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
        <Bell size={18} strokeWidth={1.6} aria-hidden="true" />
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
              <button type="button" className="capiro-vnext-notif__markall" onClick={() => markAll.mutate()}>
                Mark all read
              </button>
            ) : null}
          </div>

          {list.isLoading ? (
            <p className="capiro-vnext-notif__empty">Loading…</p>
          ) : unavailable ? (
            <p className="capiro-vnext-notif__empty">Notifications are unavailable right now.</p>
          ) : items.length === 0 ? (
            <p className="capiro-vnext-notif__empty">No notifications</p>
          ) : (
            <ul className="capiro-vnext-notif__list">
              {items.map((n) => {
                const isInvite = n.kind === 'collab_invite' && n.actionable && n.draftId && n.collaboratorId;
                return (
                  <li
                    key={n.id}
                    className="capiro-vnext-notif__item"
                    data-unread={!n.read || undefined}
                    onClick={() => {
                      if (!n.read) markRead.mutate(n.id);
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
  { id: 'profile', label: 'Profile', path: null, action: 'profile' },
  { id: 'settings', label: 'Settings', path: '/settings' },
  { id: 'sign-out', label: 'Sign out', path: null, action: 'sign-out', destructive: true, separated: true },
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
                <span className="capiro-vnext-menu__label">{entry.label}</span>
                <span className="capiro-vnext-menu__tag">
                  {disabled ? 'Not available' : (entry.tag ?? '')}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
