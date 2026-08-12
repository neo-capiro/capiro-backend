import { useRef, useState, type ReactNode } from 'react';
import { Bell } from 'lucide-react';
import type { ShellIdentityViewModel } from '../../adapters/legacy/useShellIdentity.js';
import type { ShellNotificationsViewModel } from '../../adapters/legacy/useShellNotifications.js';
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

/**
 * Notification bell (`722:2520`). Per the interaction contract the badge is
 * count-only and detail lives in a dedicated surface, so this control navigates
 * rather than opening a popover.
 */
export function NotificationBell({
  notifications,
  onOpen,
}: {
  notifications: ShellNotificationsViewModel;
  onOpen: () => void;
}) {
  const label = notifications.unavailable
    ? 'Notifications unavailable'
    : `Notifications${notifications.unread > 0 ? `, ${notifications.unread} unread` : ''}`;

  return (
    <button
      type="button"
      className="capiro-vnext-bell"
      aria-label={label}
      data-unavailable={notifications.unavailable || undefined}
      onClick={onOpen}
    >
      <Bell size={18} strokeWidth={1.6} aria-hidden="true" />
      {notifications.showBadge ? (
        <span className="capiro-vnext-bell__count" aria-hidden="true">
          {notifications.badgeLabel}
        </span>
      ) : null}
    </button>
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
            <img src={identity.imageUrl ?? undefined} alt="" onError={() => setAvatarFailed(true)} />
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
