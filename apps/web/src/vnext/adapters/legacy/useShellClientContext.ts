import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useClientFilter } from '../../../state/client-filter.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

export interface ShellClientOption {
  id: string;
  name: string;
  meta: string | null;
}

export interface ShellClientContextViewModel {
  /**
   * False on surfaces the design marks `DASHBOARD · OFF` (Figma `729:2617`).
   * When disabled the control is inert and persisted client context must not
   * influence the surface's requests.
   */
  enabled: boolean;
  loading: boolean;
  unavailable: boolean;
  options: ShellClientOption[];
  selectedClientId: string | null;
  selectedClientName: string | null;
  /** SCOPE contract (`730:2589`): surfaces must state their scope explicitly. */
  scopeLabel: string;
  setSelectedClientId: (clientId: string | null) => void;
}

/**
 * Routes where the client context control is inert. Dashboard is always
 * all-client per both the written brief and Figma `729:2612`.
 */
export function isClientContextEnabledForPath(pathname: string): boolean {
  if (pathname === '/') return false;
  return true;
}

/**
 * Context bar client control (`722:2590`). Reuses the canonical `['clients']`
 * query cache and the existing `useClientFilter` store — this adapter owns no
 * client state of its own.
 */
export function useShellClientContext(): ShellClientContextViewModel {
  const api = useApi();
  const location = useLocation();
  const { selectedClientId, setSelectedClientId } = useClientFilter();

  const enabled = isClientContextEnabledForPath(location.pathname);

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
    enabled,
  });

  return useMemo(() => {
    const options = (clients.data ?? [])
      .filter((client) => client.status !== 'archived')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map<ShellClientOption>((client) => ({
        id: client.id,
        name: client.name,
        meta: client.status ?? null,
      }));

    // The Dashboard rule is scope, not just presentation: report all-client
    // regardless of any persisted selection so the surface cannot narrow.
    const effectiveClientId = enabled ? selectedClientId : null;
    const selected = options.find((option) => option.id === effectiveClientId) ?? null;

    return {
      enabled,
      loading: enabled && clients.isLoading,
      unavailable: enabled && clients.isError,
      options,
      selectedClientId: effectiveClientId,
      selectedClientName: selected?.name ?? null,
      scopeLabel: selected ? `Scoped to ${selected.name}` : 'All clients',
      setSelectedClientId,
    };
  }, [clients.data, clients.isError, clients.isLoading, enabled, selectedClientId, setSelectedClientId]);
}
