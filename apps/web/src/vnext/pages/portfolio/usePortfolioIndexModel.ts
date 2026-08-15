import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import type { Meeting } from '../../../pages/engagement/meetings/meetings-types.js';
import type { StrategyListItem } from '../../../pages/strategy/types.js';
import type { PortfolioRoute, PortfolioStatus, PortfolioSort } from './portfolio-routing.js';

/**
 * Data model for the Portfolio index (PORTFOLIO-HANDOFF §7.1).
 *
 * Every figure is read from an endpoint the app already calls — nothing is
 * recomputed client-side that a service owns, and a missing value is never
 * rendered as `0` (§1.4). Where the design needs a portfolio-scoped aggregate
 * no single endpoint provides (cross-client program-element delta and the
 * per-row rollup), the affected figure is rendered as `—` or an explicit
 * unavailable state and the gap is logged in `GAPS.md` rather than assembled
 * with N+1 per-client calls (§7.1 "Must not").
 */

export interface PortfolioSummary {
  activeClients: number;
  needAttention: number;
  ldaSpendQtd: number;
  billsTracked: number;
  activeRegulations: number;
}

function weekBounds(now: Date): { from: string; to: string } {
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() + (day === 0 ? -6 : 1 - day));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { from: monday.toISOString(), to: sunday.toISOString() };
}

export interface PortfolioRow {
  client: Client;
  /** Display status derived from the client's real status fields. */
  status: Exclude<PortfolioStatus, 'all'>;
  name: string;
  sector: string | null;
  location: string | null;
  focusTags: string[];
  ownerName: string | null;
}

function classify(client: Client): Exclude<PortfolioStatus, 'all'> {
  const profile = (client.profileStatus ?? '').toUpperCase();
  const raw = (client.status ?? '').toLowerCase();
  // At-risk mirrors the canonical "needs attention" signal the pulse band uses.
  if (profile === 'PAUSED' || profile === 'MONITORING') return 'at-risk';
  if (raw === 'prospect' || profile === 'PROSPECT') return 'prospect';
  return 'active';
}

function locationOf(client: Client): string | null {
  const intake = client.intakeData;
  if (!intake) return null;
  const city = typeof intake.city === 'string' ? intake.city : '';
  const state = typeof intake.state === 'string' ? intake.state : '';
  const joined = [city, state].filter(Boolean).join(', ');
  return joined || null;
}

function focusTagsOf(client: Client): string[] {
  const tags = client.intakeData?.tags;
  if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === 'string').slice(0, 2);
  if (client.sectorTag) return [client.sectorTag];
  return [];
}

export function usePortfolioIndexModel(route: PortfolioRoute) {
  const api = useApi();

  const clients = useQuery<Client[]>({
    // Shared with the canonical workspace so the list is a cache hit either way.
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
  });

  const summary = useQuery<PortfolioSummary>({
    queryKey: ['intelligence', 'portfolio-summary'],
    queryFn: async () =>
      (await api.get<PortfolioSummary>('/api/intelligence/portfolio-summary')).data,
  });

  // Reuse the authoritative Strategies library and Meetings endpoint for the
  // two pulse figures that are not included in portfolio-summary. These are
  // portfolio-wide reads, not per-client fan-out.
  const strategies = useQuery<StrategyListItem[]>({
    queryKey: ['strategy', 'strategies'],
    queryFn: async () => (await api.get<StrategyListItem[]>('/strategy-api/strategies')).data,
    staleTime: 30_000,
  });

  const week = useMemo(() => weekBounds(new Date()), []);
  const meetings = useQuery<Meeting[]>({
    queryKey: ['engagement-meetings-week', week.from, week.to],
    queryFn: async () =>
      (await api.get<Meeting[]>('/api/engagement/meetings', { params: week })).data,
    staleTime: 60_000,
  });

  const rows = useMemo<PortfolioRow[]>(() => {
    const all = (clients.data ?? []).filter((c) => (c.status ?? '').toLowerCase() !== 'archived');
    return all.map((client) => ({
      client,
      status: classify(client),
      name: client.name,
      sector: client.sectorTag ?? null,
      location: locationOf(client),
      focusTags: focusTagsOf(client),
      ownerName: client.primaryContactName ?? null,
    }));
  }, [clients.data]);

  const counts = useMemo(() => {
    const by: Record<PortfolioStatus, number> = { all: rows.length, active: 0, 'at-risk': 0, prospect: 0 };
    for (const r of rows) by[r.status] += 1;
    return by;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = route.q.trim().toLowerCase();
    let out = rows;
    if (route.status !== 'all') out = out.filter((r) => r.status === route.status);
    if (needle) {
      out = out.filter((r) =>
        [r.name, r.sector ?? '', r.location ?? '', r.ownerName ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }
    const sorted = [...out];
    if (route.sort === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (route.sort === 'attention') {
      // Attention-first: at-risk rows lead, then active, then prospect; alpha within.
      const rank = (s: PortfolioRow['status']): number =>
        s === 'at-risk' ? 0 : s === 'active' ? 1 : 2;
      sorted.sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));
    } else {
      // Readiness has no portfolio-scoped source yet (G3); fall back to name so the
      // control is never a lie. Logged in GAPS.md.
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }, [rows, route]);

  return { clients, summary, strategies, meetings, rows, counts, visible };
}
