import { useRef, type ReactNode } from 'react';
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

export function CapiroBrand({ environmentLabel = 'vNext' }: { environmentLabel?: string }) {
  return (
    <>
      <span className="capiro-vnext-brand-mark" aria-hidden="true">C</span>
      <span className="capiro-vnext-brand-copy">
        <span className="capiro-vnext-brand-name">Capiro</span>
        <span className="capiro-vnext-brand-meta">{environmentLabel}</span>
      </span>
    </>
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
  tag?: string;
  destructive?: boolean;
  separated?: boolean;
}

/**
 * Figma `728:2575`. Entries without a registered canonical destination render
 * disabled rather than linking to an invented route.
 */
const PROFILE_MENU: readonly ProfileMenuEntry[] = [
  { id: 'profile', label: 'Profile', path: '/settings/personal' },
  { id: 'preferences', label: 'Preferences', path: null },
  { id: 'settings', label: 'Settings', path: '/settings' },
  { id: 'integrations', label: 'Integrations', path: '/settings/integrations' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', path: null, tag: 'CTRL /' },
  { id: 'help', label: 'Help & support', path: '/help' },
  { id: 'sign-out', label: 'Sign out', path: null, destructive: true, separated: true },
];

export function ProfileMenu({
  identity,
  onNavigate,
  onSignOut,
}: {
  identity: ShellIdentityViewModel;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
}) {
  const { isOpen, containerRef, toggle, close } = useShellOverlay('profile');
  const triggerRef = useRef<HTMLButtonElement | null>(null);

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
          {identity.initials ?? '—'}
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
            const disabled = entry.path === null && entry.id !== 'sign-out';
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
                  if (entry.id === 'sign-out') {
                    onSignOut();
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
