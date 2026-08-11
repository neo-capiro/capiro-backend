import { useMemo } from 'react';
import { useMe } from '../../../lib/me.js';

export interface ShellIdentityViewModel {
  /** True while `/api/me` is still resolving; the shell renders a quiet skeleton. */
  loading: boolean;
  /** True when `/api/me` failed. The shell must not invent a name or role. */
  unavailable: boolean;
  name: string | null;
  role: string | null;
  email: string | null;
  initials: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

/**
 * Profile identity for the top bar (`722:2524`). Reuses the canonical `useMe()`
 * query — no second request and no duplicate cache entry.
 */
export function useShellIdentity(): ShellIdentityViewModel {
  const me = useMe();

  return useMemo(() => {
    if (me.isLoading) {
      return { loading: true, unavailable: false, name: null, role: null, email: null, initials: null };
    }
    if (me.isError || !me.data) {
      return { loading: false, unavailable: true, name: null, role: null, email: null, initials: null };
    }

    const { user, role } = me.data;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || null;

    return {
      loading: false,
      unavailable: false,
      name,
      // Figma shows a role line; the user's own title wins, tenant role is the fallback.
      role: user.title?.trim() || ROLE_LABELS[role] || role,
      email: user.email,
      initials: deriveInitials(name, user.email),
    };
  }, [me.data, me.isError, me.isLoading]);
}

function deriveInitials(name: string | null, email: string | null): string | null {
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0]![0]!}${parts[parts.length - 1]![0]!}`.toUpperCase();
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return null;
}
