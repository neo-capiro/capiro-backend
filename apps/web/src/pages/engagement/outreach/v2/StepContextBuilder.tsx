// Step 5, Context Builder — the second half of what used to be the single
// "Build Context" step (StepContext.tsx). This is the OLD step's LEFT "pool
// browser" pane, now full-width and its own step: browse bills, intel, past
// emails/meetings, docs & notes, debriefs, preps, plus a "Custom note" tab.
// Tick anything a draft should draw on — it lands in the context plan (step
// 4), where it's scoped and given an instruction. Presentation rebuilt onto
// Tailwind + React Aria per the real migration (handover §0, §6.8); every
// query, filter, and handler below is unchanged.
//
// The Personal Notes / "context plan" side is now step 4 — see
// StepContextPlan.tsx. Both steps call useContextPlan with the SAME
// recipients/targets/selected/onChange the wizard already passes them, so
// ticking an item here is immediately visible on step 4 and vice versa.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { ProgramElementListItem } from '../../../program-element/types.js';
import type { OutreachRecipient } from '../../OutreachView.js';
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

interface Props {
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

// Bills / emails / meeting preps / debriefs / docs / custom note. (Past
// meetings was replaced by Meeting preps; Intel tab was removed earlier.)
const TABS: Array<{ id: ContextKind; label: string; icon: typeof Icon.Bill }> = [
  { id: 'bill', label: 'Bills', icon: Icon.Bill },
  { id: 'stateBill', label: 'State Bills', icon: Icon.StateBill },
  { id: 'programElement', label: 'Program Elements', icon: Icon.ProgramElement },
  { id: 'email', label: 'Past emails', icon: Icon.Email },
  { id: 'prep', label: 'Meeting preps', icon: Icon.Prep },
  { id: 'debrief', label: 'Debriefs', icon: Icon.Debrief },
  { id: 'document', label: 'Docs & Notes', icon: Icon.Document },
  { id: 'note', label: 'Custom note', icon: Icon.Plus },
];

// These tabs draw from the tenant-wide library and group their pool by client
// (a client sub-tab row inside the tab). Debriefs/preps also sort newest-first.
const CLIENT_GROUPED_KINDS: ContextKind[] = ['document', 'debrief', 'prep'];

export function StepContextBuilder({
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
  const { isOn, matchHint, toggle, addNoteForScope } = useContextPlan(
    recipients,
    targets,
    selected,
    onChange,
  );

  const [tab, setTab] = useState<ContextKind>('bill');
  const [search, setSearch] = useState('');

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
    const items = pool[tab] || [];
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

  // ---- Client sub-tabs (Docs & Notes / Debriefs / Preps) ----
  // These tabs group their pool by client and show a sub-tab per client; the
  // pool is tenant-wide (no recipient/client gating). 'all' = every client.
  const isClientGrouped = CLIENT_GROUPED_KINDS.includes(tab) && !billSearchActive;
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
        Add context from your sources
      </h2>
      <div className="mt-1.5 mb-5 text-sm leading-5 text-ink-secondary">
        Everything Capiro holds for this campaign, by source. Tick anything a draft should draw
        on — it lands in the context plan, where you scope it and tell Meri how to use it.
      </div>

      <div className="rounded-lg border border-line-hairline bg-surface">
        <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line-hairline bg-surface-subtle p-2">
          {TABS.map((t) => {
            const active = tab === t.id;
            const count = pool[t.id]?.length || 0;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`flex flex-none items-center gap-1.5 rounded-sm px-3 py-2 text-[13.5px] font-medium whitespace-nowrap ${
                  active ? 'bg-accent-tint text-accent-ink' : 'text-ink-secondary hover:bg-surface'
                }`}
              >
                <t.icon size={13} />
                {t.label}
                {count > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
                      active ? 'bg-surface text-accent-ink' : 'bg-neutral-bg text-neutral-ink'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {tab !== 'note' && (
          <>
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
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                    clientTab === 'all'
                      ? 'bg-accent-tint text-accent-ink'
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
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      clientTab === g.key
                        ? 'bg-accent-tint text-accent-ink'
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
          <div className="flex flex-col items-center p-6 text-center">
            <p className="mb-4 max-w-md text-[13px] leading-[1.6] text-ink-secondary">
              Add a free-form note Meri should treat as context. Notes can be shared across all
              recipients, or scoped to a single recipient, list, or group — you choose after
              adding.
            </p>
            <Button variant="secondary" onPress={() => addNoteForScope('all')}>
              <Icon.Plus size={14} /> Add shared note
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Pool browse row ----------------

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
      className={`grid grid-cols-[22px_minmax(0,1fr)] items-start gap-2.5 border-t border-line-hairline p-3 text-left first:border-t-0 ${
        selectedOn ? 'bg-accent-tint' : 'hover:bg-surface-subtle'
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
          {hint && <span className="ml-2 text-xs font-normal text-accent-ink">→ {hint}</span>}
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
