// Step 4, Context Builder.
//
// Two-pane interface:
//   • Left , browse a pool of bills, intel, past emails, past meetings,
//             plus a "Custom note" tab. Each item has a `matches` array
//             of recipient/client ids it naturally belongs to.
//   • Right, the "context plan": selected items grouped into Shared
//             (every recipient sees it) and per-target sections (each
//             individual / list / group). Each card has a free-form `note`
//             textarea that the AI uses as an extra instruction for that one
//             item, and an "Applies to" dropdown to re-route it.
//
// Scope values (SelectedContextItem.scope):
//   'all' | '<recipientKey>' | 'list:<targetKey>' | 'group:<targetKey>'
// List/group scopes are expanded to per-member recipient keys before they're
// sent to the backend (see expandContextItemScopes in targets.ts).
//
// Smart routing: when an item is added, we look at recipients matching
// item.matches. One match that is an INDIVIDUAL target → scope = that key.
// Zero / multi / list-or-group member → scope = 'all'.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BankOutlined,
  BulbOutlined,
  CloseOutlined,
  DollarOutlined,
  DownOutlined,
  FileTextOutlined,
  GlobalOutlined,
  MailOutlined,
  PaperClipOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined,
  SolutionOutlined,
  TeamOutlined,
  UnorderedListOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useApi } from '../../../../lib/use-api.js';
import type { ProgramElementListItem } from '../../../program-element/types.js';
import type { OutreachRecipient } from '../../OutreachView.js';
import type { OutreachTarget } from './targets.js';
import { peToPoolItem } from './pe-context.js';
import {
  recipientKey,
  type ContextKind,
  type ContextPoolItem,
  type SelectedContextItem,
} from './types.js';

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
  /** Structured targets — drives the grouped "Applies to" scopes + sections. */
  targets: OutreachTarget[];
  selected: SelectedContextItem[];
  onChange: (next: SelectedContextItem[]) => void;
  pool: Record<ContextKind, ContextPoolItem[]>;
  loading?: boolean;
}

/** One option in the "Applies to" dropdown (individual / list / group). */
interface ScopeOpt {
  value: string;
  label: string;
  sub?: string;
}

interface ScopeOptions {
  individuals: ScopeOpt[];
  lists: ScopeOpt[];
  groups: ScopeOpt[];
}

// Bills / emails / meeting preps / debriefs / docs / custom note. (Past
// meetings was replaced by Meeting preps; Intel tab was removed earlier.)
const TABS: Array<{ id: ContextKind; label: string; Icon: typeof FileTextOutlined }> = [
  { id: 'bill', label: 'Bills', Icon: FileTextOutlined },
  { id: 'stateBill', label: 'State Bills', Icon: BankOutlined },
  { id: 'programElement', label: 'Program Elements', Icon: DollarOutlined },
  { id: 'email', label: 'Past emails', Icon: MailOutlined },
  { id: 'prep', label: 'Meeting preps', Icon: BulbOutlined },
  { id: 'debrief', label: 'Debriefs', Icon: SolutionOutlined },
  { id: 'document', label: 'Docs & Notes', Icon: PaperClipOutlined },
  { id: 'note', label: 'Custom note', Icon: PlusOutlined },
];

// These tabs draw from the tenant-wide library and group their pool by client
// (a client sub-tab row inside the tab). Debriefs/preps also sort newest-first.
const CLIENT_GROUPED_KINDS: ContextKind[] = ['document', 'debrief', 'prep'];

const KIND_LABEL: Record<ContextKind, string> = {
  bill: 'Bill',
  stateBill: 'State bill',
  intel: 'Intel',
  email: 'Past email',
  // `meeting` kept for back-compat with saved drafts (Past meetings retired).
  meeting: 'Meeting',
  debrief: 'Debrief',
  note: 'Note',
  document: 'Doc/Note',
  prep: 'Prep',
  programElement: 'Program Element',
};

/** Compact secondary line for an individual recipient option/section. */
function individualSub(r: OutreachRecipient): string {
  if (r.state && r.district) return `${r.state}-${r.district}`;
  return r.office || r.state || r.title || r.email || '';
}

export function StepContext({ recipients, targets, selected, onChange, pool, loading }: Props) {
  const api = useApi();
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

  const isOn = (id: string) => selected.some((c) => c.id === id);

  // ---- Scope options + sections derived from the structured targets ----
  const scopeOptions = useMemo<ScopeOptions>(() => {
    const individuals: ScopeOpt[] = [];
    const lists: ScopeOpt[] = [];
    const groups: ScopeOpt[] = [];
    for (const t of targets) {
      if (t.type === 'individual') {
        const r = t.recipients[0];
        if (!r) continue;
        individuals.push({
          value: recipientKey(r),
          label: r.name || r.email || 'Recipient',
          sub: individualSub(r),
        });
      } else if (t.type === 'list') {
        lists.push({
          value: `list:${t.key}`,
          label: t.name || 'Untitled list',
          sub: `${t.recipients.length} ${t.recipients.length === 1 ? 'contact' : 'contacts'} · applied to each member individually`,
        });
      } else {
        groups.push({
          value: `group:${t.key}`,
          label: t.name || 'Untitled group',
          sub: `${t.recipients.length} ${t.recipients.length === 1 ? 'contact' : 'contacts'} · applied to group email`,
        });
      }
    }
    return { individuals, lists, groups };
  }, [targets]);

  // recipientKeys that are their OWN individual target — the only keys smart
  // routing may auto-scope to (a list/group member has no per-member section).
  const individualKeys = useMemo(
    () => new Set(scopeOptions.individuals.map((o) => o.value)),
    [scopeOptions],
  );

  // Smart routing: derive the initial scope for a newly-selected item.
  const deriveScope = (item: ContextPoolItem): 'all' | string => {
    const matches = item.matches;
    if (!matches?.length || recipients.length === 0) return 'all';
    const matched = recipients.filter((r) => {
      const key = recipientKey(r);
      return (
        matches.includes(key) ||
        (r.id && matches.includes(r.id)) ||
        (r.clientId && matches.includes(r.clientId)) ||
        (r.directoryContactId && matches.includes(r.directoryContactId))
      );
    });
    const sole = matched[0];
    if (matched.length === 1 && sole) {
      const key = recipientKey(sole);
      return individualKeys.has(key) ? key : 'all';
    }
    return 'all';
  };

  const matchHint = (item: ContextPoolItem): string | null => {
    const matches = item.matches;
    if (!matches?.length || recipients.length === 0) return null;
    const matched = recipients.filter((r) => {
      const key = recipientKey(r);
      return (
        matches.includes(key) ||
        (r.id && matches.includes(r.id)) ||
        (r.clientId && matches.includes(r.clientId)) ||
        (r.directoryContactId && matches.includes(r.directoryContactId))
      );
    });
    if (matched.length === 0) return null;
    const sole = matched[0];
    if (matched.length === 1 && sole) return sole.name || sole.email || 'matched recipient';
    return `${matched.length} recipients`;
  };

  // Latest `selected` for async callbacks (document text extraction resolves
  // after the user may have toggled other items).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Client documents have no body until selected; pull the extracted text on
  // demand (txt/csv/pdf/docx/xlsx supported server-side).
  const extractDoc = async (attachmentId: string, itemId: string) => {
    let body: string;
    try {
      const res = await api.post<{ text?: string }>(
        `/api/engagement/attachments/${attachmentId}/extract-text`,
      );
      const text = (res.data?.text ?? '').trim();
      body = text ? text.slice(0, 8000) : '(no extractable text in this document)';
    } catch {
      body = '(could not extract text — supported: .txt, .csv, .pdf, .docx, .xlsx)';
    }
    onChange(selectedRef.current.map((c) => (c.id === itemId ? { ...c, body } : c)));
  };

  const toggle = (item: ContextPoolItem) => {
    if (isOn(item.id)) {
      onChange(selected.filter((c) => c.id !== item.id));
      return;
    }
    const needsExtract = item.kind === 'document' && item.id.startsWith('doc-') && !item.body;
    onChange([
      ...selected,
      {
        ...item,
        scope: deriveScope(item),
        note: '',
        body: needsExtract ? 'Extracting document text…' : item.body,
      },
    ]);
    if (needsExtract) void extractDoc(item.id.slice('doc-'.length), item.id);
  };

  const setNote = (id: string, note: string) =>
    onChange(selected.map((c) => (c.id === id ? { ...c, note } : c)));

  const setScope = (id: string, scope: 'all' | string) =>
    onChange(selected.map((c) => (c.id === id ? { ...c, scope } : c)));

  const remove = (id: string) => onChange(selected.filter((c) => c.id !== id));

  const addNoteForScope = (scope: 'all' | string) => {
    const id = `ctx-note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    onChange([
      ...selected,
      {
        id,
        kind: 'note',
        title: scope === 'all' ? 'Shared note' : 'Personalized note',
        body: '',
        note: '',
        scope,
      },
    ]);
  };

  const sharedItems = selected.filter((c) => c.scope === 'all');

  // One plan section per target: individuals, then lists, then groups.
  interface PlanSection {
    targetKey: string;
    scope: string;
    name: string;
    kind: 'individual' | 'list' | 'group';
    sub?: string;
    items: SelectedContextItem[];
  }
  const planSections: PlanSection[] = [];
  for (const t of targets) {
    if (t.type === 'individual') {
      const r = t.recipients[0];
      if (!r) continue;
      const scope = recipientKey(r);
      planSections.push({
        targetKey: t.key,
        scope,
        name: r.name || r.email || 'Recipient',
        kind: 'individual',
        sub: individualSub(r),
        items: selected.filter((c) => c.scope === scope),
      });
    } else {
      const scope = `${t.type}:${t.key}`;
      planSections.push({
        targetKey: t.key,
        scope,
        name: t.name || (t.type === 'list' ? 'Untitled list' : 'Untitled group'),
        kind: t.type,
        sub: `${t.recipients.length} ${t.recipients.length === 1 ? 'contact' : 'contacts'}`,
        items: selected.filter((c) => c.scope === scope),
      });
    }
  }

  // Items scoped to something no section covers — e.g. a draft saved before the
  // grouped scopes existed (scoped to a list member), or a target removed after
  // scoping. Surface them so they're visible and re-routable instead of being
  // silently sent with an invisible scope.
  const routedScopes = new Set<string>(['all', ...planSections.map((s) => s.scope)]);
  const orphanItems = selected.filter((c) => !routedScopes.has(c.scope));

  return (
    <div>
      <h2>Build the context Meri uses</h2>
      <div className="ov2-pane-sub">
        Shared items will be used as context for all recipients. You can also add personalized
        context for each individual, list, or group.
      </div>

      <div className="ov2-ctx-builder">
        {/* ---------- LEFT: pool browser ---------- */}
        <div className="ov2-ctx-left">
          <div className="ov2-ctx-tabs">
            {TABS.map((t) => (
              <div
                key={t.id}
                className={'ov2-ctx-tab' + (tab === t.id ? ' active' : '')}
                onClick={() => setTab(t.id)}
              >
                <t.Icon style={{ fontSize: 12 }} />
                {t.label}
                {(pool[t.id]?.length || 0) > 0 && (
                  <span className="badge">{pool[t.id].length}</span>
                )}
              </div>
            ))}
          </div>

          {tab !== 'note' && (
            <>
              <div className="ov2-ctx-search">
                <SearchOutlined style={{ fontSize: 13, color: 'var(--ov2-ink-3)' }} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={
                    tab === 'bill'
                      ? 'Search all bills by title or sponsor…'
                      : tab === 'stateBill'
                        ? 'Search all state bills by title, sponsor, or number…'
                        : tab === 'programElement'
                          ? 'Search Program Elements by title or PE code…'
                          : `Search ${tab}…`
                  }
                />
              </div>
              {tab === 'bill' && (
                <div style={{ padding: '4px 12px 6px', fontSize: 11, color: 'var(--ov2-ink-3)' }}>
                  {billSearchActive
                    ? 'Searching every tracked bill in Congress.'
                    : 'Showing this client’s bills. Type to search the full bill database.'}
                </div>
              )}
              {tab === 'stateBill' && (
                <div style={{ padding: '4px 12px 6px', fontSize: 11, color: 'var(--ov2-ink-3)' }}>
                  {stateBillSearchActive
                    ? 'Searching every state bill across all states.'
                    : 'Type at least 2 characters to search state legislation by title, sponsor, or bill number.'}
                </div>
              )}
              {tab === 'programElement' && (
                <div style={{ padding: '4px 12px 6px', fontSize: 11, color: 'var(--ov2-ink-3)' }}>
                  {peSearchActive
                    ? 'Searching the full Program Element catalog.'
                    : 'Showing your watched Program Elements. Type to search the full catalog.'}
                </div>
              )}
              {isClientGrouped && clientGroups.length > 0 && (
                <div className="ov2-ctx-clienttabs" role="tablist">
                  <button
                    type="button"
                    className={'ov2-ctx-clienttab' + (clientTab === 'all' ? ' active' : '')}
                    onClick={() => setClientTab('all')}
                  >
                    All <span className="n">{visible.length}</span>
                  </button>
                  {clientGroups.map((g) => (
                    <button
                      key={g.key}
                      type="button"
                      className={'ov2-ctx-clienttab' + (clientTab === g.key ? ' active' : '')}
                      onClick={() => setClientTab(g.key)}
                    >
                      {g.name} <span className="n">{g.items.length}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="ov2-ctx-list">
                {listLoading && (
                  <div
                    style={{
                      padding: 30,
                      textAlign: 'center',
                      color: 'var(--ov2-ink-3)',
                      fontSize: 12.5,
                    }}
                  >
                    Loading…
                  </div>
                )}
                {!listLoading && groupedVisible.length === 0 && (
                  <div
                    style={{
                      padding: 30,
                      textAlign: 'center',
                      color: 'var(--ov2-ink-3)',
                      fontSize: 12.5,
                      fontStyle: 'italic',
                    }}
                  >
                    {billSearchActive
                      ? 'No bills match your search.'
                      : stateBillSearchActive
                        ? 'No state bills match your search.'
                        : isClientGrouped && clientTab !== 'all'
                          ? 'No items for this client.'
                          : 'No matches.'}
                  </div>
                )}
                {groupedVisible.map((it) => {
                  const hint = matchHint(it);
                  return (
                    <div
                      key={it.id}
                      className={'ov2-ctx-item' + (isOn(it.id) ? ' selected' : '')}
                      onClick={() => toggle(it)}
                    >
                      <span className="ov2-ctx-cb">
                        {isOn(it.id) && (
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                          >
                            <path d="m5 12 5 5L20 7" />
                          </svg>
                        )}
                      </span>
                      <div>
                        <div className="title">
                          {it.title}
                          {hint && <span className="ov2-ctx-match-hint">→ {hint}</span>}
                        </div>
                        <div className="sub">
                          {it.tag && <span className="tag">{it.tag}</span>}
                          {it.sub && <span>{it.sub}</span>}
                        </div>
                        {it.body && <div className="body">{it.body}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {tab === 'note' && (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--ov2-ink-2)',
                  lineHeight: 1.6,
                  margin: '8px 0 18px',
                }}
              >
                Add a free-form note Meri should treat as context. Notes can be shared across all
                recipients, or scoped to a single recipient, list, or group — you choose after
                adding.
              </p>
              <button
                className="ov2-ctx-add-note-btn"
                onClick={() => addNoteForScope('all')}
                style={{ width: 'auto', padding: '8px 18px' }}
              >
                <PlusOutlined /> Add shared note
              </button>
            </div>
          )}
        </div>

        {/* ---------- RIGHT: context plan ---------- */}
        <div className="ov2-ctx-right">
          <div className="ov2-ctx-right-head">
            <span className="meri">
              <RobotOutlined style={{ fontSize: 12 }} />
            </span>
            <span className="title">Context plan</span>
            <span className="count">{selected.length} items</span>
          </div>

          <div className="ov2-ctx-stack">
            {targets.length === 0 && (
              <div className="ov2-ctx-no-recipients">
                <b>Pick recipients first</b>
                Per-recipient routing needs a recipient list. Go back to step 3 to add one.
              </div>
            )}

            {/* Shared section */}
            <div className="ov2-ctx-section">
              <div className="ov2-ctx-section-head shared">
                <span className="sec-ico">
                  <GlobalOutlined style={{ fontSize: 13 }} />
                </span>
                <span className="sec-name">Shared</span>
                <span
                  style={{
                    fontWeight: 500,
                    color: 'var(--ov2-ink-3)',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}
                >
                  · every recipient sees this
                </span>
                <span className="sec-count">{sharedItems.length}</span>
              </div>
              {sharedItems.length === 0 && (
                <div className="ov2-ctx-empty-row">No shared context yet</div>
              )}
              {sharedItems.map((c) => (
                <ContextCard
                  key={c.id}
                  c={c}
                  scopeOptions={scopeOptions}
                  onNote={setNote}
                  onScope={setScope}
                  onRemove={remove}
                />
              ))}
              <button className="ov2-ctx-add-note-btn" onClick={() => addNoteForScope('all')}>
                + Add shared note
              </button>
            </div>

            {/* Per-target sections: individuals, lists, groups */}
            {planSections.map((s) => (
              <div key={s.scope} className="ov2-ctx-section">
                <div className={`ov2-ctx-section-head ${s.kind}`}>
                  <span className="sec-ico">
                    {s.kind === 'individual' ? (
                      <UserOutlined style={{ fontSize: 13 }} />
                    ) : s.kind === 'list' ? (
                      <UnorderedListOutlined style={{ fontSize: 13 }} />
                    ) : (
                      <TeamOutlined style={{ fontSize: 13 }} />
                    )}
                  </span>
                  <span className="sec-name">{s.name}</span>
                  <span className={`ov2-ctx-sec-badge ${s.kind}`}>{s.kind}</span>
                  <span className="sec-count">{s.items.length}</span>
                </div>
                {s.items.length === 0 && (
                  <div className="ov2-ctx-empty-row">
                    {s.kind === 'group'
                      ? 'No group-specific context, uses shared only.'
                      : 'No personalized context, uses shared only.'}
                  </div>
                )}
                {s.items.map((c) => (
                  <ContextCard
                    key={c.id}
                    c={c}
                    scopeOptions={scopeOptions}
                    onNote={setNote}
                    onScope={setScope}
                    onRemove={remove}
                  />
                ))}
                <button className="ov2-ctx-add-note-btn" onClick={() => addNoteForScope(s.scope)}>
                  + Add note for {s.name.split(' ').slice(0, 2).join(' ')}
                </button>
              </div>
            ))}

            {orphanItems.length > 0 && (
              <div className="ov2-ctx-section">
                <div className="ov2-ctx-section-head recipient">
                  <span className="sec-ico">
                    <UserOutlined style={{ fontSize: 13 }} />
                  </span>
                  <span className="sec-name">Other</span>
                  <span className="ov2-ctx-sec-badge individual">unrouted</span>
                  <span className="sec-count">{orphanItems.length}</span>
                </div>
                <div className="ov2-ctx-empty-row">
                  Scoped to a recipient no longer shown above — re-route with “Applies to”, or
                  remove.
                </div>
                {orphanItems.map((c) => (
                  <ContextCard
                    key={c.id}
                    c={c}
                    scopeOptions={scopeOptions}
                    onNote={setNote}
                    onScope={setScope}
                    onRemove={remove}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="ov2-ctx-stack-foot">
            <div className="stats">
              <span>
                <b>{selected.length}</b> items
              </span>
              <span>·</span>
              <span>
                <b>{sharedItems.length}</b> shared
              </span>
              <span>
                <b>{selected.length - sharedItems.length}</b> scoped
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Applies-to scope dropdown ----------------

/** Resolve a scope value to its display icon + label for the trigger. */
function resolveScope(value: string, opts: ScopeOptions): { icon: ReactNode; label: string } {
  if (value === 'all') return { icon: <GlobalOutlined />, label: 'All recipients (shared)' };
  if (value.startsWith('list:')) {
    const o = opts.lists.find((x) => x.value === value);
    return { icon: <UnorderedListOutlined />, label: o?.label ?? 'List' };
  }
  if (value.startsWith('group:')) {
    const o = opts.groups.find((x) => x.value === value);
    return { icon: <TeamOutlined />, label: o?.label ?? 'Group' };
  }
  const o = opts.individuals.find((x) => x.value === value);
  return { icon: <UserOutlined />, label: o?.label ?? 'Recipient' };
}

function ScopeSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ScopeOptions;
  onChange: (scope: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = resolveScope(value, options);
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const renderOpt = (o: ScopeOpt, kind: 'individual' | 'list' | 'group', icon: ReactNode) => (
    <button
      type="button"
      key={o.value}
      className={'ov2-ctx-scope2-opt' + (value === o.value ? ' sel' : '')}
      onClick={() => pick(o.value)}
    >
      <span className={`ico ${kind}`}>{icon}</span>
      <span className="meta">
        <span className="nm">{o.label}</span>
        {o.sub && <span className="sub">{o.sub}</span>}
      </span>
      <span className={`ov2-ctx-scope2-badge ${kind}`}>{kind}</span>
    </button>
  );

  return (
    <div className="ov2-ctx-scope2" ref={ref}>
      <button
        type="button"
        className={'ov2-ctx-scope2-trigger' + (open ? ' open' : '')}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ico">{current.icon}</span>
        <span className="lbl">{current.label}</span>
        <DownOutlined className="caret" />
      </button>
      {open && (
        <div className="ov2-ctx-scope2-pop" role="listbox">
          <button
            type="button"
            className={'ov2-ctx-scope2-opt' + (value === 'all' ? ' sel' : '')}
            onClick={() => pick('all')}
          >
            <span className="ico all">
              <GlobalOutlined />
            </span>
            <span className="meta">
              <span className="nm">All recipients (shared)</span>
            </span>
            <span className="ov2-ctx-scope2-badge shared">Shared</span>
          </button>

          {options.individuals.length > 0 && <div className="ov2-ctx-scope2-grp">Individuals</div>}
          {options.individuals.map((o) => renderOpt(o, 'individual', <UserOutlined />))}

          {options.lists.length > 0 && <div className="ov2-ctx-scope2-grp">Lists</div>}
          {options.lists.map((o) => renderOpt(o, 'list', <UnorderedListOutlined />))}

          {options.groups.length > 0 && <div className="ov2-ctx-scope2-grp">Groups</div>}
          {options.groups.map((o) => renderOpt(o, 'group', <TeamOutlined />))}
        </div>
      )}
    </div>
  );
}

// ---------------- Single card ----------------

interface CardProps {
  c: SelectedContextItem;
  scopeOptions: ScopeOptions;
  onNote: (id: string, note: string) => void;
  onScope: (id: string, scope: 'all' | string) => void;
  onRemove: (id: string) => void;
}

function ContextCard({ c, scopeOptions, onNote, onScope, onRemove }: CardProps) {
  return (
    <div className="ov2-ctx-card">
      <div className="ov2-ctx-card-head">
        <span className="ov2-ctx-card-kind" data-kind={c.kind}>
          {KIND_LABEL[c.kind]}
        </span>
        <span className="ov2-ctx-card-title">{c.title}</span>
        <button
          className="ov2-ctx-card-remove"
          onClick={() => onRemove(c.id)}
          title="Remove"
          aria-label="Remove context item"
        >
          <CloseOutlined style={{ fontSize: 12 }} />
        </button>
      </div>
      {c.body && <div className="ov2-ctx-card-body">{c.body}</div>}
      <textarea
        className="ov2-ctx-card-note"
        value={c.note}
        onChange={(e) => onNote(c.id, e.target.value)}
        placeholder={
          c.kind === 'note'
            ? 'Write your note here…'
            : "+ Add a personalized instruction (optional), e.g. 'lead with this', 'omit the deadline language'…"
        }
      />
      <div className="ov2-ctx-scope-row">
        <span className="label">Applies to</span>
        <ScopeSelect value={c.scope} options={scopeOptions} onChange={(v) => onScope(c.id, v)} />
      </div>
    </div>
  );
}
