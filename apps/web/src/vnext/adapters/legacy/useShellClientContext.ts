import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();
  const { selectedClientId, setSelectedClientId } = useClientFilter();

  const enabled = isClientContextEnabledForPath(location.pathname);
  const isFundingRoute = location.pathname === '/intelligence/opportunities' || location.pathname.startsWith('/intelligence/opportunities/');
  // Funding v2 stores its typed scope in the canonical `client` query
  // field. On that route only, absence is meaningful: never leak the legacy
  // persisted global selection into the shell header.
  const params = new URLSearchParams(location.search);
  const linkedClientId = params.get(isFundingRoute ? 'client' : 'clientId');
  const fundingClientId = isFundingRoute ? linkedClientId : null;
  const selectClient = useCallback((clientId: string | null) => {
    setSelectedClientId(clientId);
    // A linked scope wins over the shared filter below. Change both on an
    // explicit selection so arriving from a client record does not lock it.
    if (isFundingRoute) {
      const next = new URLSearchParams(location.search);
      if (clientId) next.set('client', clientId); else next.delete('client');
      next.delete('clientId');
      next.delete('page');
      if (!clientId) next.set('mode', 'all');
      navigate({ pathname: location.pathname, search: next.toString(), hash: location.hash });
      return;
    }
    if (linkedClientId === null || linkedClientId === clientId) return;
    const next = new URLSearchParams(location.search);
    if (clientId) next.set('clientId', clientId); else next.delete('clientId');
    navigate({ pathname: location.pathname, search: next.toString(), hash: location.hash });
  }, [isFundingRoute, linkedClientId, location.pathname, location.search, location.hash, navigate, setSelectedClientId]);

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
    // A client-record route is already unambiguously scoped by its canonical
    // `client` query parameter on Funding routes. Prefer it over a stale global filter so the
    // top-bar scope badge agrees with the record on screen.
    const effectiveClientId = enabled ? (isFundingRoute ? fundingClientId : linkedClientId ?? selectedClientId) : null;
    const selected = options.find((option) => option.id === effectiveClientId) ?? null;

    return {
      enabled,
      loading: enabled && clients.isLoading,
      unavailable: enabled && clients.isError,
      options,
      selectedClientId: effectiveClientId,
      selectedClientName: selected?.name ?? null,
      scopeLabel: selected
        ? linkedClientId
          ? selected.name
          : `Scoped to ${selected.name}`
        : 'All clients',
      setSelectedClientId: selectClient,
    };
  }, [clients.data, clients.isError, clients.isLoading, enabled, fundingClientId, isFundingRoute, linkedClientId, selectedClientId, selectClient]);
}
