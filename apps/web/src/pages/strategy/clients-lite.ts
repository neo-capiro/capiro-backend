/*
 * Lightweight tenant client list for the Strategy Planner (picker + name/color
 * resolution). Reuses the main API's /api/clients (the same source AppShell,
 * HomePage, workspace, radar all use). api-strategy owns only sp_* tables and
 * references clients by id, so the web resolves the display name here.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';

export interface ClientLite {
  id: string;
  name: string;
}

export function useClientsLite() {
  const api = useApi();
  return useQuery<ClientLite[]>({
    queryKey: ['strategy', 'clients-lite'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
  });
}

/** Stable per-client accent (prototype CLIENT_COLOR palette), hashed from id. */
const CLIENT_PALETTE = ['#2A57CE', '#2E6B43', '#A26913', '#7A4FB5'];
export function clientColor(clientId: string): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = (h * 31 + clientId.charCodeAt(i)) >>> 0;
  return CLIENT_PALETTE[h % CLIENT_PALETTE.length]!;
}
