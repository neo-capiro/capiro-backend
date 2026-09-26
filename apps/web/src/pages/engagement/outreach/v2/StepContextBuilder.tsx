// Step 5, Context Builder — the second half of what used to be the single
// "Build Context" step (StepContext.tsx). This is the OLD step's LEFT "pool
// browser" pane, now full-width and its own step: browse each client's profile
// context alongside bills, emails, debriefs, preps, and custom notes.
// Tick anything a draft should draw on — it lands in the context plan (step
// 4), where it's scoped and given an instruction. Presentation rebuilt onto
// Tailwind + React Aria per the real migration (handover §0, §6.8); every
// query, filter, and handler below is unchanged.
//
// The Personal Notes / "context plan" side is now step 4 — see
// StepContextPlan.tsx. Both steps call useContextPlan with the SAME
// recipients/targets/selected/onChange the wizard already passes them, so
// ticking an item here is immediately visible on step 4 and vice versa.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { ProgramElementListItem } from '../../../program-element/types.js';
import type { OutreachRecipient } from '../../OutreachView.js';
import type { Client } from '../../../clients/clientTypes.js';
import type { OutreachTarget } from './targets.js';
import { peToPoolItem } from './pe-context.js';
import type { ContextKind, ContextPoolItem, SelectedContextItem } from './types.js';
import { useContextPlan } from './useContextPlan.js';
import './ui/tailwind.css';
import { Icon } from './ui/icons.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';

interface BillSearchRow {
  id: string;
  billType: string | null;
  billNumber: string | null;
  title: string;
  latestActionText: string | null;
  latestActionDate: string | null;
  policyArea: string | null;
}

interface StateBillSearchRow {
  id: string;
  state: string;
  identifier: string;
  title: string;
  chamber: string | null;
  subjects: string[];
  sponsorName: string | null;
  sponsorParty: string | null;
  latestActionText: string | null;
  latestActionDate: string | null;
  status: string | null;
}

interface PortfolioCapabilityRow {
  id: string;
  name: string;
  type?: string | null;
  sector?: string | null;
  serviceBranch?: string | null;
  trl?: number | null;
}

interface Props {
  clients?: Client[];
  selectedClientId?: string | null;
  recipients: OutreachRecipient[];
  targets: OutreachTarget[];
  selected: SelectedContextItem[];
  onChange: (next: SelectedContextItem[]) => void;
  pool: Record<ContextKind, ContextPoolItem[]>;
  /**
   * Phase 2 §3.i — general legislative activity, kept separate from
   * `pool.bill` (the client's own tracked bills) so it can never be mistaken
   * for something relevant to the selected client. Rendered as its own
   * labeled section on the Bills tab; selection is explicit, same as any
   * other pool item.
   */
  discoveryBills?: ContextPoolItem[];
  /** Whether a client is currently selected — drives the Bills empty-state copy. */
  hasClient?: boolean;
  loading?: boolean;
}

// Sources outside the client-profile browser. Client capabilities and Docs &
// Notes live under the owning client instead of being duplicated here.
const TABS: Array<{ id: ContextKind; label: string; icon: typeof Icon.Bill }> = [
  { id: 'bill', label: 'Bills', icon: Icon.Bill },
  { id: 'stateBill', label: 'State Bills', icon: Icon.StateBill },
  { id: 'programElement', label: 'Program Elements', icon: Icon.ProgramElement },
  { id: 'email', label: 'Past emails', icon: Icon.Email },
  { id: 'prep', label: 'Meeting preps', icon: Icon.Prep },
  { id: 'debrief', label: 'Debriefs', icon: Icon.Debrief },
  { id: 'note', label: 'Custom note', icon: Icon.Plus },
];

const PROFILE_SOURCE_META: Record<ContextKind, { label: string; icon: typeof Icon.Bill }> = {
  clientOverview: { label: 'Client overview', icon: Icon.User01 },
  bill: { label: 'Bills', icon: Icon.Bill },
  stateBill: { label: 'State Bills', icon: Icon.StateBill },
  programElement: { label: 'Program Elements', icon: Icon.ProgramElement },
  capability: { label: 'Client capabilities', icon: Icon.Capability },
  intel: { label: 'Client intelligence', icon: Icon.Document },
  email: { label: 'Past emails', icon: Icon.Email },
  meeting: { label: 'Past meetings', icon: Icon.Document },
  document: { label: 'Docs & Notes', icon: Icon.Document },
  debrief: { label: 'Debriefs', icon: Icon.Debrief },
  prep: { label: 'Meeting preps', icon: Icon.Prep },
  note: { label: 'Custom note', icon: Icon.Plus },
};

// These source tabs draw from the tenant-wide library and group their pool by
// client. Docs & Notes are not listed here because they are profile-only.
const CLIENT_GROUPED_KINDS: ContextKind[] = ['debrief', 'prep'];

export function StepContextBuilder({
  clients = [],
  selectedClientId = null,
  recipients,
  targets,
  selected,
  onChange,
  pool,
  discoveryBills,
  hasClient,
  loading,
}: Props) {
  const api = useApi();
  const { isOn, matchHint, toggle, toggleMany, addNoteForScope } = useContextPlan(
    recipients,
    targets,
    selected,
    onChange,
  );

  const [tab, setTab] = useState<ContextKind | 'clientPortfolio'>('clientPortfolio');
  const [portfolioClientId, setPortfolioClientId] = useState<string | null>(selectedClientId);
  const [portfolioQuery, setPortfolioQuery] = useState('');
  const [portfolioSearch, setPortfolioSearch] = useState('');
  const [search, setSearch] = useState('');
  // Id of the note most recently added from this tab, so its editor can be
  // focused immediately on the same surface.
  const [lastAddedNoteId, setLastAddedNoteId] = useState<string | null>(null);

  // Debounce the search box so bill lookups don't fire on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Bills: searching hits the ENTIRE congress-bill corpus server-side (not just
  // the client's tracked bills shown by default). Keyword match on title/sponsor.
  const billSearchActive = tab === 'bill' && debouncedSearch.length >= 2;
  const billSearch = useQuery({
    enabled: billSearchActive,
    queryKey: ['ctx-bill-search', debouncedSearch],
    queryFn: async () => {
      const res = await api.get<{ rows: BillSearchRow[] }>('/api/explorer/congress-bills', {
        params: { q: debouncedSearch, pageSize: 30, sort: 'latestAction' },
      });
      return res.data.rows.map<ContextPoolItem>((b) => ({
        // Same id scheme as tracked bills so selection/dedupe lines up.
        id: `bill-${b.id}`,
        kind: 'bill',
        title: `${(b.billType ?? '').toUpperCase()}${b.billNumber ? ` ${b.billNumber}` : ''}${b.billType || b.billNumber ? ', ' : ''}${b.title}`,
        body: b.latestActionText ?? undefined,
        tag: b.policyArea ?? undefined,
        sub: b.latestActionDate ? new Date(b.latestActionDate).toLocaleDateString() : undefined,
      }));
    },
  });

  // State bills (OpenStates/LegiScan): searching hits the ENTIRE state-bill
  // corpus server-side, mirroring the federal Bills tab. Keyword match on
  // title / sponsor / identifier / latest action.
  const stateBillSearchActive = tab === 'stateBill' && debouncedSearch.length >= 2;
  const stateBillSearch = useQuery({
    enabled: stateBillSearchActive,
    queryKey: ['ctx-statebill-search', debouncedSearch],
    queryFn: async () => {
      const res = await api.get<{ rows: StateBillSearchRow[] }>('/api/explorer/state-bills', {
        params: { q: debouncedSearch, pageSize: 30 },
      });
      return res.data.rows.map<ContextPoolItem>((b) => ({
        // Distinct prefix from federal `bill-${id}` so the two bill corpora
        // never collide in selection/dedupe.
        id: `state-bill-${b.id}`,
        kind: 'stateBill',
        // `identifier` already encodes type+number (e.g. "HB 1234"); prefix the
        // state so a mixed context plan reads unambiguously.
        title: `${b.state ? `${b.state} ` : ''}${b.identifier}${b.identifier && b.title ? ', ' : ''}${b.title}`,
        body: b.latestActionText ?? undefined,
        tag: b.status ?? b.subjects[0] ?? undefined,
        sub: b.latestActionDate ? new Date(b.latestActionDate).toLocaleDateString() : undefined,
      }));
    },
  });

  // Program Elements: live search over the global PE catalog (reuses the finder's
  // GET /program-elements list endpoint; canonical-current funding per row).
  const peSearchActive = tab === 'programElement' && debouncedSearch.length >= 2;
  const peSearch = useQuery({
    enabled: peSearchActive,
    queryKey: ['ctx-pe-search', debouncedSearch],
    queryFn: async () => {
      const res = await api.get<{ data: ProgramElementListItem[] }>('/api/program-elements', {
        params: { q: debouncedSearch, limit: 20 },
      });
      return res.data.data.map<ContextPoolItem>(peToPoolItem);
    },
  });

  const visible = useMemo(() => {
    // Full-corpus bill / state-bill / PE search results take over their list
    // while searching.
    if (billSearchActive) return billSearch.data ?? [];
    if (stateBillSearchActive) return stateBillSearch.data ?? [];
    if (peSearchActive) return peSearch.data ?? [];
    const items = tab === 'clientPortfolio' ? [] : (pool[tab] || []);
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter(
      (it) => it.title.toLowerCase().includes(q) || (it.body && it.body.toLowerCase().includes(q)),
    );
  }, [
    pool,
    tab,
    search,
    billSearchActive,
    billSearch.data,
    stateBillSearchActive,
    stateBillSearch.data,
    peSearchActive,
    peSearch.data,
  ]);

  // ---- Client sub-tabs (Debriefs / Preps) ----
  // These tabs group their pool by client and show a sub-tab per client; the
  // pool is tenant-wide (no recipient/client gating). 'all' = every client.
  const isClientGrouped = tab !== 'clientPortfolio' && CLIENT_GROUPED_KINDS.includes(tab) && !billSearchActive;
  const [clientTab, setClientTab] = useState<string>('all');
  useEffect(() => {
    setClientTab('all');
  }, [tab]);

  const byDateDesc = (a: ContextPoolItem, b: ContextPoolItem) =>
    (b.date ?? '').localeCompare(a.date ?? '');

  const clientGroups = useMemo(() => {
    if (!isClientGrouped)
      return [] as Array<{ key: string; name: string; items: ContextPoolItem[] }>;
    const map = new Map<string, { key: string; name: string; items: ContextPoolItem[] }>();
    for (const it of visible) {
      const key = it.clientId ?? '__none__';
      if (!map.has(key)) map.set(key, { key, name: it.clientName ?? 'No client', items: [] });
      map.get(key)!.items.push(it);
    }
    const groups = [...map.values()];
    for (const g of groups) g.items.sort(byDateDesc);
    // Clients A–Z; the "No client" bucket always last.
    groups.sort((a, b) =>
      a.key === '__none__' ? 1 : b.key === '__none__' ? -1 : a.name.localeCompare(b.name),
    );
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClientGrouped, visible]);

  // The list actually rendered: for client-grouped tabs, the selected client's
  // items (or all clients newest-first on the "All" sub-tab); else the flat pool.
  const groupedVisible = useMemo(() => {
    if (!isClientGrouped) return visible;
    if (clientTab === 'all') return [...visible].sort(byDateDesc);
    return clientGroups.find((g) => g.key === clientTab)?.items ?? [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClientGrouped, visible, clientTab, clientGroups]);

  const listLoading =
    loading ||
    (billSearchActive && billSearch.isLoading) ||
    (stateBillSearchActive && stateBillSearch.isLoading) ||
    (peSearchActive && peSearch.isLoading);

  // Custom notes (kind 'note') in the wizard's `selected` state, newest last
  // (the same order the Context Plan step shows them in).
  const noteItems = useMemo(() => selected.filter((c) => c.kind === 'note'), [
    selected,
  ]);

  // The campaign client's capabilities are already in `pool`. Load other
  // clients' capability records only while their portfolio profile is open.
  const portfolioCapabilitiesQuery = useQuery<PortfolioCapabilityRow[]>({
    enabled: tab === 'clientPortfolio' && !!portfolioClientId && portfolioClientId !== selectedClientId,
    queryKey: ['outreach-portfolio-capabilities', portfolioClientId],
    queryFn: async () =>
      (await api.get<PortfolioCapabilityRow[]>(`/api/clients/${portfolioClientId}/capabilities`)).data,
    retry: false,
    staleTime: 60_000,
  });

  const portfolioItems = useMemo(() => {
    if (!portfolioClientId) return [];
    const campaignClientKinds: ContextKind[] = ['bill', 'intel'];
    const items = (Object.keys(pool) as ContextKind[]).flatMap((kind) =>
      kind === 'capability' ? [] :
      (pool[kind] ?? []).filter(
        (item) => item.clientId === portfolioClientId ||
          (campaignClientKinds.includes(kind) && selectedClientId === portfolioClientId),
      ),
    );
    const client = clients.find((candidate) => candidate.id === portfolioClientId);
    const capabilityRows = portfolioClientId === selectedClientId
      ? (pool.capability ?? []).map((item) => ({ ...item, clientId: portfolioClientId, clientName: client?.name }))
      : (portfolioCapabilitiesQuery.data ?? []).map((capability) => ({
          id: `capability-${capability.id}`,
          kind: 'capability' as const,
          title: capability.name,
          tag: capability.type ?? undefined,
          sub: [capability.sector, capability.serviceBranch, capability.trl != null ? `TRL ${capability.trl}` : null]
            .filter(Boolean)
            .join(' · ') || undefined,
          clientId: portfolioClientId,
          clientName: client?.name,
        }));
    items.push(...capabilityRows);
    if (client) {
      const summary = [client.description, client.productDescription].filter(Boolean).join('\n\n').trim();
      items.unshift({
        id: `client-overview-${client.id}`,
        kind: 'clientOverview',
        title: `${client.name} overview`,
        body: summary || undefined,
        sub: [client.sectorTag, client.profileType, client.website].filter(Boolean).join(' · ') || undefined,
        clientId: client.id,
        clientName: client.name,
      });
    }
    return items;
  }, [clients, pool, portfolioCapabilitiesQuery.data, portfolioClientId, selectedClientId]);
  const visiblePortfolioItems = useMemo(() => {
    const query = portfolioSearch.trim().toLocaleLowerCase();
    return query
      ? portfolioItems.filter((item) => `${item.title} ${item.tag ?? ''} ${item.sub ?? ''} ${item.body ?? ''}`.toLocaleLowerCase().includes(query))
      : portfolioItems;
  }, [portfolioItems, portfolioSearch]);
  const visiblePortfolioGroups = useMemo(() => {
    const portfolioKinds: ContextKind[] = [
      'clientOverview', 'bill', 'stateBill', 'programElement', 'capability', 'intel',
      'email', 'meeting', 'document', 'debrief', 'prep', 'note',
    ];
    return portfolioKinds.flatMap((kind) => {
      const items = visiblePortfolioItems.filter((item) => item.kind === kind);
      if (!items.length) return [];
      const source = { id: kind, ...PROFILE_SOURCE_META[kind] };
      return [{ source, items }];
    });
  }, [visiblePortfolioItems]);
  const portfolioClient = clients.find((client) => client.id === portfolioClientId) ?? null;
  const clientContextCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const kind of Object.keys(pool) as ContextKind[]) {
      for (const item of pool[kind] ?? []) {
        if (item.clientId) counts.set(item.clientId, (counts.get(item.clientId) ?? 0) + 1);
      }
    }
    if (selectedClientId) {
      const scopedCount = ['bill', 'intel', 'capability'].reduce((total, kind) =>
        total + (pool[kind as ContextKind] ?? []).filter((item) => !item.clientId).length, 0);
      counts.set(selectedClientId, (counts.get(selectedClientId) ?? 0) + scopedCount);
    }
    if (portfolioClientId && portfolioClientId !== selectedClientId) {
      counts.set(portfolioClientId, (counts.get(portfolioClientId) ?? 0) + (portfolioCapabilitiesQuery.data?.length ?? 0));
    }
    for (const client of clients) counts.set(client.id, (counts.get(client.id) ?? 0) + 1);
    return counts;
  }, [clients, pool, portfolioCapabilitiesQuery.data, portfolioClientId, selectedClientId]);

  const searchPlaceholder =
    tab === 'bill'
      ? 'Search all bills by title or sponsor…'
      : tab === 'stateBill'
        ? 'Search all state bills by title, sponsor, or number…'
        : tab === 'programElement'
          ? 'Search Program Elements by title or PE code…'
          : `Search ${tab}…`;

  return (
    <div className="ov2-tw-root">
      <h2 className="text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink-primary">
        Add context
      </h2>
      <div className="mt-1.5 mb-5 text-sm leading-5 text-ink-secondary">
        Pick a client to pull from their profile, or open one of your other sources. Tick as many
        items as you need. Everything you pick is listed under Selected, and Meri draws only on those.
      </div>

      <div className="grid items-start gap-3 xl:grid-cols-[220px_minmax(0,1fr)] 2xl:grid-cols-[220px_minmax(0,1fr)_270px]">
        <aside className="rounded-lg border border-line-hairline bg-surface p-3" aria-label="Context sources">
          <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">Client portfolio</div>
          <Input value={portfolioQuery} onChange={setPortfolioQuery} placeholder="Search clients…" leadingIcon={<Icon.SearchLg size={14} />} />
          <div className="mt-2 flex max-h-[260px] flex-col gap-1 overflow-y-auto">
            {clients.filter((client) => !portfolioQuery.trim() || client.name.toLocaleLowerCase().includes(portfolioQuery.trim().toLocaleLowerCase())).map((client) => {
              const active = tab === 'clientPortfolio' && client.id === portfolioClientId;
              const count = clientContextCounts.get(client.id) ?? 0;
              const picked = selected.filter((item) => (item.clientId === client.id || (selectedClientId === client.id && ['bill', 'intel', 'capability'].includes(item.kind)))).length;
              return <button key={client.id} type="button" aria-pressed={active} onClick={() => { setTab('clientPortfolio'); setPortfolioClientId(client.id); setPortfolioSearch(''); }} className={`appearance-none border-0 flex items-center gap-2 rounded-lg px-2 py-2 text-left ${active ? 'bg-neutral-bg text-ink-primary' : 'bg-transparent text-ink-secondary hover:bg-surface-subtle'}`}><span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${active ? 'btn-dark' : 'bg-neutral-bg text-neutral-ink'}`}>{client.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-semibold">{client.name}</span><span className="block text-[10px] text-ink-tertiary">{picked} selected · {count} items</span></span></button>;
            })}
            {clients.length === 0 && <p className="p-2 text-xs text-ink-tertiary">No clients in the portfolio.</p>}
          </div>
          <div className="mb-2 mt-4 border-t border-line-hairline pt-3 px-2 text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">Sources</div>
          <nav className="flex flex-col gap-0.5" aria-label="Context source types">
            {TABS.map((source) => <button key={source.id} type="button" aria-current={tab === source.id ? 'page' : undefined} onClick={() => setTab(source.id)} className={`appearance-none border-0 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium ${tab === source.id ? 'bg-neutral-bg text-ink-primary' : 'bg-transparent text-ink-secondary hover:bg-surface-subtle'}`}><source.icon size={14} className={tab === source.id ? 'text-ink-primary' : 'text-ink-tertiary'} /><span className="min-w-0 flex-1">{source.label}</span><span className="font-mono text-[10px] text-ink-tertiary">{pool[source.id]?.length ?? 0}</span></button>)}
          </nav>
        </aside>

        <div className="min-w-0 rounded-lg border border-line-hairline bg-surface">

        {tab === 'clientPortfolio' && (
          <div className="min-h-[460px] p-4 md:p-5">
            <section className="min-w-0" aria-label={portfolioClient ? `${portfolioClient.name} profile context` : 'Client profile context'}>
              {portfolioClient ? (
                <>
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-line-hairline pb-4">
                    <div className="min-w-0"><div className="text-[17px] font-semibold text-ink-primary">{portfolioClient.name}</div><div className="mt-1 text-[12px] text-ink-secondary">{[portfolioClient.sectorTag, portfolioClient.profileType, portfolioClient.website].filter(Boolean).join(' · ') || 'Client profile'}</div>{portfolioClient.description && <p className="mt-2 max-w-3xl text-[12.5px] leading-5 text-ink-secondary">{portfolioClient.description}</p>}</div>
                    <span className="rounded-full bg-neutral-bg px-2.5 py-1 text-xs font-medium text-ink-secondary">{portfolioItems.filter((item) => isOn(item.id)).length} selected</span>
                  </div>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[12px] font-semibold text-ink-secondary">Select context from this client profile</div>
                    <div className="flex items-center gap-3"><button type="button" className="appearance-none border-0 bg-transparent p-0 text-xs font-medium text-ink-secondary hover:text-ink-primary" onClick={() => toggleMany(portfolioItems, true)}>Select all</button><button type="button" className="appearance-none border-0 bg-transparent p-0 text-xs font-medium text-ink-secondary hover:text-ink-primary" onClick={() => toggleMany(portfolioItems, false)}>Clear</button></div>
                  </div>
                  <div className="mb-3"><Input value={portfolioSearch} onChange={setPortfolioSearch} placeholder={`Search ${portfolioClient.name}’s profile`} leadingIcon={<Icon.SearchLg size={14} />} /></div>
                  {visiblePortfolioGroups.length ? <div className="space-y-3">{visiblePortfolioGroups.map(({ source, items }) => {
                    const selectedCount = items.filter((item) => isOn(item.id)).length;
                    const allSelected = selectedCount === items.length;
                    return <section key={source.id} className="overflow-hidden rounded-lg border border-line-hairline" aria-label={`${source.label} context`}>
                      <div className="flex flex-wrap items-center gap-2 border-b border-line-hairline bg-surface-subtle px-3 py-2">
                        <source.icon size={13} className="text-ink-tertiary" />
                        <h3 className="min-w-0 flex-1 text-[11px] font-semibold text-ink-secondary">{source.label} <span className="font-mono font-normal text-ink-tertiary">{items.length}</span></h3>
                        <span className="text-[10px] text-ink-tertiary">{selectedCount} selected</span>
                        <button type="button" className="appearance-none border-0 bg-transparent p-0 text-[10px] font-medium text-ink-secondary hover:text-ink-primary" onClick={() => toggleMany(items, !allSelected)}>{allSelected ? 'Clear' : 'Select all'}</button>
                      </div>
                      {items.map((item) => <PoolRow key={`${item.kind}:${item.id}`} item={item} selectedOn={isOn(item.id)} hint={matchHint(item)} onToggle={() => toggle(item)} />)}
                    </section>;
                  })}</div> : <div className="rounded-lg border border-dashed border-line-control p-8 text-center text-[12.5px] text-ink-tertiary">{portfolioCapabilitiesQuery.isFetching ? 'Loading client capabilities…' : portfolioCapabilitiesQuery.isError ? 'Client capabilities could not be loaded.' : portfolioItems.length ? 'No profile context matches your search.' : 'No saved profile context is available for this client yet.'}</div>}
                </>
              ) : <div className="p-8 text-center text-sm text-ink-tertiary">Choose a client to review its profile and select context.</div>}
            </section>
          </div>
        )}

        {tab !== 'note' && tab !== 'clientPortfolio' && (
          <>
            <div className="flex items-center justify-end gap-3 px-4 pt-3"><button type="button" className="appearance-none border-0 bg-transparent p-0 text-xs font-medium text-ink-secondary hover:text-ink-primary" onClick={() => toggleMany(groupedVisible, true)}>Select all</button><button type="button" className="appearance-none border-0 bg-transparent p-0 text-xs font-medium text-ink-secondary hover:text-ink-primary" onClick={() => toggleMany(groupedVisible, false)}>Clear</button></div>
            <div className="p-3">
              <Input
                value={search}
                onChange={setSearch}
                placeholder={searchPlaceholder}
                leadingIcon={<Icon.SearchLg size={14} />}
              />
            </div>
            {tab === 'bill' && (
              <div className="px-4 pb-2 text-[11px] text-ink-tertiary">
                {billSearchActive
                  ? 'Searching every bill in Congress.'
                  : !hasClient
                    ? 'Select a client to see their tracked bills, or browse suggested public developments below. Type to search the full bill database.'
                    : (pool.bill?.length ?? 0) === 0
                      ? 'This client has no tracked bills available for outreach context.'
                      : 'Showing this client’s tracked bills. Type to search the full bill database.'}
              </div>
            )}
            {tab === 'stateBill' && (
              <div className="px-4 pb-2 text-[11px] text-ink-tertiary">
                {stateBillSearchActive
                  ? 'Searching every state bill across all states.'
                  : 'Type at least 2 characters to search state legislation by title, sponsor, or bill number.'}
              </div>
            )}
            {tab === 'programElement' && (
              <div className="px-4 pb-2 text-[11px] text-ink-tertiary">
                {peSearchActive
                  ? 'Searching the full Program Element catalog.'
                  : 'Showing your watched Program Elements. Type to search the full catalog.'}
              </div>
            )}
            {isClientGrouped && clientGroups.length > 0 && (
              <div role="tablist" className="flex flex-wrap gap-1.5 px-4 pb-3">
                <button
                  type="button"
                  role="tab"
                  aria-selected={clientTab === 'all'}
                  onClick={() => setClientTab('all')}
                  className={`appearance-none border-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                    clientTab === 'all'
                      ? 'btn-dark text-white'
                      : 'bg-surface-subtle text-ink-secondary hover:bg-neutral-bg'
                  }`}
                >
                  All <span className="ml-1 font-mono">{visible.length}</span>
                </button>
                {clientGroups.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    role="tab"
                    aria-selected={clientTab === g.key}
                    onClick={() => setClientTab(g.key)}
                    className={`appearance-none border-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                      clientTab === g.key
                        ? 'btn-dark text-white'
                        : 'bg-surface-subtle text-ink-secondary hover:bg-neutral-bg'
                    }`}
                  >
                    {g.name} <span className="ml-1 font-mono">{g.items.length}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-col">
              {listLoading && (
                <div className="p-8 text-center text-[12.5px] text-ink-tertiary">Loading…</div>
              )}
              {!listLoading && groupedVisible.length === 0 && (
                <div className="p-8 text-center text-[12.5px] text-ink-tertiary italic">
                  {billSearchActive
                    ? 'No bills match your search.'
                    : stateBillSearchActive
                      ? 'No state bills match your search.'
                      : isClientGrouped && clientTab !== 'all'
                        ? 'No items for this client.'
                        : 'No matches.'}
                </div>
              )}
              {groupedVisible.map((it) => (
                <PoolRow
                  key={it.id}
                  item={it}
                  selectedOn={isOn(it.id)}
                  hint={matchHint(it)}
                  onToggle={() => toggle(it)}
                />
              ))}

              {/* Phase 2 §3.i — general legislative activity, kept visibly
                  separate from the client's own tracked bills above so it can
                  never be mistaken for something relevant to this client.
                  Same explicit click-to-add interaction; never pre-selected. */}
              {tab === 'bill' && !billSearchActive && (discoveryBills?.length ?? 0) > 0 && (
                <>
                  <div className="border-t border-line-hairline bg-surface-subtle px-4 py-2 text-[11px] font-semibold text-ink-tertiary uppercase">
                    Suggested public developments
                  </div>
                  {discoveryBills!.map((it) => (
                    <PoolRow
                      key={it.id}
                      item={it}
                      selectedOn={isOn(it.id)}
                      hint={matchHint(it)}
                      onToggle={() => toggle(it)}
                    />
                  ))}
                </>
              )}
            </div>
          </>
        )}

        {tab === 'note' && (
          <div className="flex flex-col p-6">
            <p className="mb-4 max-w-md text-[13px] leading-[1.6] text-ink-secondary">
              Add a free-form note Meri should treat as context. Notes can be shared across all
              recipients, or scoped to a single recipient, list, or group — you choose after
              adding.
            </p>
            {/* The note's editor lives here: the add-click appends a card to
                the wizard's shared state, so the user sees and can type in it
                on the surface where they clicked. */}
            {noteItems.map((item) => (
              <BuilderNoteEditor
                key={item.id}
                item={item}
                autoFocus={item.id === lastAddedNoteId}
                onNote={(text) =>
                  onChange(
                    selected.map((c) => (c.id === item.id ? { ...c, note: text } : c)),
                  )
                }
                onRemove={() => onChange(selected.filter((c) => c.id !== item.id))}
              />
            ))}
            <div>
              <Button
                variant="secondary"
                onPress={() => {
                  const id = addNoteForScope('all');
                  setLastAddedNoteId(id);
                }}
              >
                <Icon.Plus size={14} /> Add shared note
              </Button>
            </div>
          </div>
        )}
        </div>

        <aside className="rounded-lg border border-line-hairline bg-surface p-3 xl:col-span-2 2xl:col-span-1 2xl:sticky 2xl:top-4" aria-label="Selected context">
          <div className="flex items-center justify-between border-b border-line-hairline pb-3">
            <div><div className="text-[13px] font-semibold text-ink-primary">Selected</div><div className="mt-0.5 text-[11px] text-ink-tertiary">Items drafts may draw on</div></div>
            <span className="rounded-full bg-neutral-bg px-2 py-0.5 font-mono text-[11px] text-ink-secondary">{selected.length}</span>
          </div>
          {selected.length ? <div className="mt-2 max-h-[520px] space-y-2 overflow-y-auto">{selected.map((item) => <div key={`${item.kind}:${item.id}`} className="rounded-lg border border-line-hairline bg-surface-subtle p-2.5"><div className="flex items-start gap-2"><span className="min-w-0 flex-1"><span className="block text-[11px] font-medium text-ink-tertiary">{item.clientName ?? TABS.find((source) => source.id === item.kind)?.label ?? 'Client context'}</span><span className="mt-0.5 block text-[12px] font-semibold leading-4 text-ink-primary">{item.title}</span></span><button type="button" onClick={() => onChange(selected.filter((context) => context.id !== item.id))} aria-label={`Remove ${item.title}`} className="appearance-none border-0 bg-transparent flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:bg-neutral-bg hover:text-ink-primary"><Icon.XClose size={13} /></button></div><div className="mt-1 text-[10px] text-ink-tertiary">{item.scope === 'all' ? 'All recipients' : 'Recipient scoped'}</div></div>)}</div> : <div className="py-8 text-center text-[12px] leading-5 text-ink-tertiary">No context selected yet. Choose items from a source or client profile.</div>}
          {selected.length > 0 && <button type="button" onClick={() => onChange([])} className="appearance-none mt-3 w-full rounded-lg border border-line-control bg-surface px-3 py-2 text-xs font-medium text-ink-secondary hover:bg-surface-subtle">Clear all</button>}
        </aside>
      </div>
    </div>
  );
}

// ---------------- Pool browse row ----------------

/**
 * One editable custom note on the Builder's "Custom note" tab — the same
 * wizard state (`selected`, kind 'note') as the Context Plan's note cards.
 * The just-added note gets focus so the add-click visibly lands in the
 * editor.
 */
function BuilderNoteEditor({
  item,
  autoFocus,
  onNote,
  onRemove,
}: {
  item: SelectedContextItem;
  autoFocus: boolean;
  onNote: (text: string) => void;
  onRemove: () => void;
}) {
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const noteIsEmpty = !(item.note ?? '').trim();
  useEffect(() => {
    if (autoFocus) textRef.current?.focus();
  }, [autoFocus]);
  return (
    <div className="mb-3 rounded-md border border-line-hairline bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-[5px] bg-neutral-bg px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.04em] text-neutral-ink">
          {item.scope === 'all' ? 'Shared note' : 'Personalized note'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-primary">
          {item.title}
        </span>
        <button
          type="button"
          onClick={onRemove}
          title="Remove note"
          aria-label={`Remove ${item.title}`}
          className="appearance-none border-0 bg-transparent flex-none text-ink-tertiary hover:text-warning"
        >
          <Icon.XClose size={12} />
        </button>
      </div>
      <textarea
        ref={textRef}
        rows={3}
        value={item.note ?? ''}
        onChange={(e) => onNote(e.target.value)}
        aria-label={`${item.title} text`}
        placeholder="Write your note here…"
        className="w-full resize-y rounded-md border border-line-control bg-surface p-3 text-[13.5px] leading-[21px] text-ink-primary placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
      />
      {noteIsEmpty && (
        <p className="mt-1.5 text-[12px] text-ink-tertiary" role="status">
          Empty note — write it here, or it will be ignored when generating drafts. You can also
          re-scope it to one recipient on the previous step&apos;s context plan.
        </p>
      )}
    </div>
  );
}

/** One clickable row in the pool browser (shared by the main list and the
 *  Phase 2 §3.i "Suggested public developments" section). */
function PoolRow({
  item,
  selectedOn,
  hint,
  onToggle,
}: {
  item: ContextPoolItem;
  selectedOn: boolean;
  hint: string | null;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`appearance-none border-0 bg-transparent w-full grid grid-cols-[22px_minmax(0,1fr)] items-start gap-2.5 border-t border-line-hairline p-3 text-left first:border-t-0 ${
        selectedOn ? 'bg-neutral-bg/60' : 'hover:bg-surface-subtle'
      }`}
    >
      <span
        className={`mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border ${
          selectedOn ? 'btn-dark border-transparent text-white' : 'border-line-control bg-surface'
        }`}
      >
        {selectedOn && <Icon.Check size={11} />}
      </span>
      <div className="min-w-0">
        <div className="text-[13px] leading-[18px] font-semibold text-ink-primary">
          {item.title}
          {hint && <span className="ml-2 text-xs font-normal text-ink-secondary">→ {hint}</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-tertiary">
          {item.tag && (
            <span className="rounded-[4px] bg-neutral-bg px-1.5 py-0.5 text-neutral-ink">
              {item.tag}
            </span>
          )}
          {item.sub && <span>{item.sub}</span>}
        </div>
        {item.body && (
          <div className="mt-1 text-[12px] leading-[1.45] text-ink-secondary">{item.body}</div>
        )}
      </div>
    </button>
  );
}
