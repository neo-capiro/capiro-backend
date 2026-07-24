import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import type { DirectoryApiResponse } from '../directory/directoryData.js';
import type { StateLegislatorRow } from '../directory/StateLegislatorDirectory.js';
import { searchPeople, type PeopleResponse } from '../directory/directory-api.js';
import {
  addClientTarget,
  getClientTargets,
  getOfficeRecommendations,
  refreshOfficeRecommendations,
  removeClientTarget,
  setClientTargetTier,
  type ClientTarget,
  type OfficeRecommendationsResult,
  type TargetDirectory,
  type TargetTier,
} from './targets-api.js';
import {
  chamberCategory,
  normalizeCongress,
  normalizeStaff,
  normalizeState,
  partyShort,
  profileHref,
  type NormalizedPerson,
} from './targets-normalize.js';

/**
 * Client Targets tab. Search people from TWO directories — the congressional
 * directory (LegiStorm S3 snapshot) and state legislators (OpenStates) — add them
 * as target offices, and click through to each person's full profile. A "Suggested
 * by Meri" sidebar ranks congressional offices via the Office Recommender.
 *
 * Robustness: the two directories return DIFFERENT row shapes (fullName vs name,
 * single-char party vs full word, House/Senate vs upper/lower, no matchedStaff on
 * state). Both are normalized to one NormalizedPerson shape BEFORE render, so no
 * mixed-shape access ever reaches the JSX. Each source query fails independently
 * (one directory being down never blanks the other). Filters + scope are applied
 * client-side on the normalized list so they behave identically across both.
 */

interface MeriSuggestion {
  memberId: string;
  office: string;
  party: 'R' | 'D' | 'I' | null;
  state: string | null;
  chamber: 'House' | 'Senate' | null;
  committee: string | null;
  score: number;
  billCount: number;
}

interface Props {
  clientId: string;
  /** Whether the user can mutate targets (read-only clients hide add/remove). */
  canManage: boolean;
  /** Navigate to the Intelligence tab (Relationships section). */
  onViewIntelligence?: () => void;
}

type Scope = 'all' | 'congress' | 'staff' | 'state';

const partyColor = (p: string | null | undefined): string =>
  p === 'R' ? '#b91c1c' : p === 'D' ? '#1d4ed8' : '#374151';
const partyBg = (p: string | null | undefined): string =>
  p === 'R' ? '#fee2e2' : p === 'D' ? '#dbeafe' : '#f3f4f6';

/** Source-directory chip styling (Member / Staff / State). */
const DIR_BADGE: Record<TargetDirectory, { label: string; bg: string; color: string }> = {
  congress: { label: 'Member', bg: '#eef2ff', color: '#4338ca' },
  staff: { label: 'Staff', bg: '#f5f3ff', color: '#6d28d9' },
  state: { label: 'State', bg: '#ecfeff', color: '#0e7490' },
};
const toDir = (sd: string | null | undefined): TargetDirectory =>
  sd === 'state' ? 'state' : sd === 'staff' ? 'staff' : 'congress';

/** Tier chip color. */
const TIER_META: Record<1 | 2 | 3, { label: string; bg: string; color: string; border: string }> = {
  1: { label: 'Tier 1', bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
  2: { label: 'Tier 2', bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
  3: { label: 'Tier 3', bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
};

/** Compact "updated X ago" label for the recommendations timestamp. */
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function TargetsTab({ clientId, canManage, onViewIntelligence }: Props) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('all');
  const [fParty, setFParty] = useState<'all' | 'R' | 'D' | 'I'>('all');
  const [fChamber, setFChamber] = useState<'all' | 'House' | 'Senate'>('all');
  const [fState, setFState] = useState('');
  // Debounced search term — the directory searches fire off this, not the raw
  // input, so typing a name doesn't kick off a request on every keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const targetsQuery = useQuery<ClientTarget[]>({
    queryKey: ['client-targets', clientId],
    queryFn: async () => getClientTargets(api, clientId),
  });
  const targets = targetsQuery.data ?? [];

  const recsQuery = useQuery<OfficeRecommendationsResult>({
    queryKey: ['client-target-recommendations', clientId],
    queryFn: async () => getOfficeRecommendations(api, clientId),
    enabled: !!clientId,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => refreshOfficeRecommendations(api, clientId),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['client-target-recommendations', clientId] });
    },
    onSuccess: (data) => {
      qc.setQueryData(['client-target-recommendations', clientId], data);
    },
    onError: () => message.error('Could not refresh recommendations. Please try again.'),
  });

  const meriSuggestions = useMemo<MeriSuggestion[]>(
    () =>
      (recsQuery.data?.recommendations ?? [])
        .filter((r) => typeof r?.memberId === 'string' && r.memberId.length > 0)
        .slice(0, 6)
        .map((r) => ({
          memberId: r.memberId,
          office: String(r.office ?? ''),
          party: r.party ?? null,
          state: r.state ?? null,
          chamber: r.chamber ?? null,
          committee: r.committee ?? null,
          score: Number(r.score ?? 0),
          billCount: Number(r.billCount ?? 0),
        })),
    [recsQuery.data],
  );

  const addedIds = useMemo(() => new Set(targets.map((t) => t.memberId)), [targets]);
  const meriIds = useMemo(() => new Set(meriSuggestions.map((m) => m.memberId)), [meriSuggestions]);

  // ── Independent searches across THREE directories, normalized to one shape ──
  const wantCongress = scope === 'all' || scope === 'congress';
  const wantStaff = scope === 'all' || scope === 'staff';
  const wantState = scope === 'all' || scope === 'state';

  const congressSearch = useQuery<DirectoryApiResponse>({
    queryKey: ['targets-congress-search', debouncedQuery],
    enabled: debouncedQuery.length > 0 && wantCongress,
    queryFn: async () =>
      (
        await api.get<DirectoryApiResponse>('/api/directory/contacts', {
          params: { q: debouncedQuery, pageSize: 25, sort: 'name-asc' },
        })
      ).data,
    retry: 1,
  });

  const staffSearch = useQuery<PeopleResponse>({
    queryKey: ['targets-staff-search', debouncedQuery],
    enabled: debouncedQuery.length > 0 && wantStaff,
    queryFn: async () => searchPeople(api, { q: debouncedQuery, personType: 'staff', pageSize: 25 }),
    retry: 1,
  });

  const stateSearch = useQuery<{ rows: StateLegislatorRow[]; total: number }>({
    queryKey: ['targets-state-search', debouncedQuery],
    enabled: debouncedQuery.length > 0 && wantState,
    queryFn: async () =>
      (
        await api.get<{ rows: StateLegislatorRow[]; total: number }>(
          '/api/explorer/state-legislators',
          { params: { q: debouncedQuery, pageSize: 25 } },
        )
      ).data,
    retry: 1,
  });

  const trimmed = query.trim();
  const debouncePending = trimmed !== debouncedQuery;
  // Per-source readiness. A source is "still pending" ONLY while it's enabled,
  // fetching, and has no data yet. A source that already returned data (or errored)
  // is done — so its results (and the siblings') render immediately and one slow or
  // down directory can never blank the others. (react-query gives fresh data per
  // debouncedQuery key, so `.data` here is never a stale previous query's rows.)
  const congressPending = wantCongress && congressSearch.isFetching && !congressSearch.data;
  const staffPending = wantStaff && staffSearch.isFetching && !staffSearch.data;
  const statePending = wantState && stateSearch.isFetching && !stateSearch.data;

  // Normalize whatever each source has returned, then apply client-side filters
  // uniformly. Wrapped so a single malformed row can never throw during render. Gated
  // only on the debounce (never on in-flight fetch), so available rows show at once.
  const hits = useMemo<NormalizedPerson[]>(() => {
    if (!trimmed || !searchOpen || debouncePending) return [];
    const out: NormalizedPerson[] = [];
    try {
      if (wantCongress) {
        for (const e of congressSearch.data?.contacts ?? []) {
          if (e && typeof e.id === 'string') out.push(normalizeCongress(e));
        }
      }
      if (wantStaff) {
        for (const p of staffSearch.data?.people ?? []) {
          if (p && typeof p.id === 'string' && p.personType === 'staff') out.push(normalizeStaff(p));
        }
      }
      if (wantState) {
        for (const r of stateSearch.data?.rows ?? []) {
          if (r && typeof r.id === 'string') out.push(normalizeState(r));
        }
      }
    } catch {
      return [];
    }
    const stateNeedle = fState.trim().toUpperCase();
    return out.filter(
      (p) =>
        (fParty === 'all' || p.partyShort === fParty) &&
        (fChamber === 'all' || p.chamberLabel === fChamber) &&
        (!stateNeedle || (p.stateCode ?? '').toUpperCase().includes(stateNeedle)),
    );
  }, [
    trimmed,
    searchOpen,
    debouncePending,
    wantCongress,
    wantStaff,
    wantState,
    fParty,
    fChamber,
    fState,
    congressSearch.data,
    staffSearch.data,
    stateSearch.data,
  ]);

  // Show "Searching…" only while nothing is displayable yet AND a source is still
  // pending (or the debounce hasn't settled) — never withhold rows already in hand.
  const showSearching =
    debouncePending || ((congressPending || staffPending || statePending) && hits.length === 0);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['client-targets', clientId] });
    qc.invalidateQueries({ queryKey: ['clients'] });
  };

  const addMutation = useMutation({
    mutationFn: async (v: {
      memberId: string;
      source: 'manual' | 'meri';
      sourceDirectory: TargetDirectory;
    }) => addClientTarget(api, clientId, v.memberId, v.source, v.sourceDirectory),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['client-targets', clientId] });
      const prev = qc.getQueryData<ClientTarget[]>(['client-targets', clientId]);
      const optimistic: ClientTarget = {
        id: `optimistic-${v.memberId}`,
        clientId,
        memberId: v.memberId,
        memberName: null,
        sourceDirectory: v.sourceDirectory,
        party: null,
        state: null,
        chamber: null,
        committee: null,
        tier: null,
        source: v.source,
        addedByUserId: null,
        addedAt: new Date().toISOString(),
        // Not yet known — the server resolves this fresh on the next list
        // fetch; this optimistic row is replaced once the add settles.
        representedFacilities: null,
      };
      qc.setQueryData<ClientTarget[]>(['client-targets', clientId], [...(prev ?? []), optimistic]);
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['client-targets', clientId], ctx.prev);
      message.error('Could not add target. Please try again.');
    },
    onSettled: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: async (memberId: string) => removeClientTarget(api, clientId, memberId),
    onMutate: async (memberId) => {
      await qc.cancelQueries({ queryKey: ['client-targets', clientId] });
      const prev = qc.getQueryData<ClientTarget[]>(['client-targets', clientId]);
      qc.setQueryData<ClientTarget[]>(
        ['client-targets', clientId],
        (prev ?? []).filter((t) => t.memberId !== memberId),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['client-targets', clientId], ctx.prev);
      message.error('Could not remove target. Please try again.');
    },
    onSettled: invalidate,
  });

  const tierMutation = useMutation({
    mutationFn: async (v: { memberId: string; tier: TargetTier }) =>
      setClientTargetTier(api, clientId, v.memberId, v.tier),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['client-targets', clientId] });
      const prev = qc.getQueryData<ClientTarget[]>(['client-targets', clientId]);
      qc.setQueryData<ClientTarget[]>(
        ['client-targets', clientId],
        (prev ?? []).map((t) => (t.memberId === v.memberId ? { ...t, tier: v.tier } : t)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['client-targets', clientId], ctx.prev);
      message.error('Could not update tier. Please try again.');
    },
    onSettled: invalidate,
  });

  const add = (memberId: string, source: 'manual' | 'meri', sourceDirectory: TargetDirectory) => {
    if (!canManage || addedIds.has(memberId)) return;
    addMutation.mutate({ memberId, source, sourceDirectory });
  };
  const setTier = (memberId: string, tier: TargetTier) => {
    if (!canManage) return;
    tierMutation.mutate({ memberId, tier });
  };
  const remove = (memberId: string) => {
    if (!canManage) return;
    removeMutation.mutate(memberId);
  };
  const openProfile = (sourceDirectory: TargetDirectory, id: string) =>
    navigate(profileHref(sourceDirectory, id));

  const recsLoading = recsQuery.isLoading;
  const recsError = recsQuery.isError;
  const refreshing = refreshMutation.isPending;
  const computedAt = recsQuery.data?.computedAt ?? null;

  const selStyle: React.CSSProperties = {
    fontSize: 12,
    padding: '3px 6px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#fff',
  };

  return (
    <div className="tg-layout" onClick={() => setSearchOpen(false)}>
      {/* Main column */}
      <div className="tg-main">
        <div className="help-box">
          <span className="help-ico" aria-hidden="true">
            ⓘ
          </span>
          <span className="help-txt">
            Search congressional members and state legislators to add target offices for this
            client. Click any result or target to open their full profile.
          </span>
        </div>

        {canManage ? (
          <div className="srch-wrap" onClick={(e) => e.stopPropagation()}>
            <div className="srch-lbl">Search People</div>
            {/* Scope toggle + filters */}
            <div
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}
            >
              <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden' }}>
                {(['all', 'congress', 'staff', 'state'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setScope(s)}
                    style={{
                      fontSize: 12,
                      padding: '4px 10px',
                      border: 'none',
                      cursor: 'pointer',
                      background: scope === s ? '#1d4ed8' : '#fff',
                      color: scope === s ? '#fff' : '#374151',
                    }}
                  >
                    {s === 'all' ? 'All' : s === 'congress' ? 'Members' : s === 'staff' ? 'Staff' : 'State'}
                  </button>
                ))}
              </div>
              <select
                aria-label="Filter by party"
                style={selStyle}
                value={fParty}
                onChange={(e) => setFParty(e.target.value as typeof fParty)}
              >
                <option value="all">All parties</option>
                <option value="R">Republican</option>
                <option value="D">Democrat</option>
                <option value="I">Independent/Other</option>
              </select>
              <select
                aria-label="Filter by chamber"
                style={selStyle}
                value={fChamber}
                onChange={(e) => setFChamber(e.target.value as typeof fChamber)}
              >
                <option value="all">Both chambers</option>
                <option value="House">House / Lower</option>
                <option value="Senate">Senate / Upper</option>
              </select>
              <input
                aria-label="Filter by state"
                style={{ ...selStyle, width: 90 }}
                placeholder="State (TX)"
                value={fState}
                maxLength={2}
                onChange={(e) => setFState(e.target.value)}
              />
            </div>
            <div className="srch-row">
              <span className="srch-ico" aria-hidden="true">
                🔍
              </span>
              <input
                type="text"
                className="srch-inp"
                placeholder="Search by name, state, committee, or party…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSearchOpen(false);
                }}
              />
              {query ? (
                <button
                  className="srch-x"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery('');
                    setSearchOpen(false);
                  }}
                >
                  ✕
                </button>
              ) : null}
            </div>

            {trimmed && searchOpen ? (
              <div className="results-drop">
                <div className="res-count">
                  {showSearching
                    ? 'Searching…'
                    : hits.length === 0
                      ? `No results for "${trimmed}"`
                      : `${hits.length} result${hits.length === 1 ? '' : 's'}`}
                </div>
                {hits.map((m) => {
                  const added = addedIds.has(m.id);
                  const isMeri = meriIds.has(m.id);
                  const ps = m.partyShort;
                  return (
                    <div className="res-row" key={`${m.sourceDirectory}:${m.id}`}>
                      <div
                        className={`party-dot ${ps ?? ''}`}
                        style={{ background: partyBg(ps), color: partyColor(ps) }}
                      >
                        {ps ?? '·'}
                      </div>
                      <div className="res-info">
                        <div className="res-name">
                          <a
                            onClick={(e) => {
                              e.preventDefault();
                              openProfile(m.sourceDirectory, m.id);
                            }}
                            href={profileHref(m.sourceDirectory, m.id)}
                            style={{ color: 'inherit', textDecoration: 'none' }}
                          >
                            {m.name}
                          </a>
                        </div>
                        <div className="res-sub">
                          <span className={`res-pty ${ps ?? ''}`} style={{ color: partyColor(ps) }}>
                            [{ps ?? '·'}-{m.stateLabel ?? '—'}]
                          </span>
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: DIR_BADGE[m.sourceDirectory].bg,
                              color: DIR_BADGE[m.sourceDirectory].color,
                            }}
                          >
                            {DIR_BADGE[m.sourceDirectory].label}
                          </span>
                          {m.committee ? <span>· {m.committee}</span> : null}
                          {isMeri ? <span className="meri-chip">⊙ Meri pick</span> : null}
                        </div>
                        {m.staffMatch ? (
                          <div className="res-staff-match">
                            ↳ matched staffer: {m.staffMatch.fullName}
                            {m.staffMatch.title ? ` · ${m.staffMatch.title}` : ''}
                          </div>
                        ) : null}
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button
                          className="btn-mini"
                          style={{ background: '#f3f4f6', color: '#374151' }}
                          onClick={() => openProfile(m.sourceDirectory, m.id)}
                        >
                          View ↗
                        </button>
                        {added ? (
                          <button className="btn-mini added">✓ Added</button>
                        ) : (
                          <button
                            className="btn-mini add"
                            onClick={() => {
                              add(m.id, 'manual', m.sourceDirectory);
                              setSearchOpen(false);
                            }}
                          >
                            + Add
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        <div>
          <div className="tgh">
            <div className="tgh-title">
              My Target Offices
              <span className="cnt-bdg">{targets.length}</span>
            </div>
          </div>

          {targets.length === 0 ? (
            <div className="tgt-empty">
              <div className="te-ico" aria-hidden="true">
                🎯
              </div>
              <div className="te-title">No targets added yet</div>
              <div className="te-desc">
                Search members, staff, or state legislators above to add targets for this client,
                then assign each a tier.
              </div>
            </div>
          ) : (
            <div className="tgt-tiers">
              {/* Visually organized by engagement tier; empty tiers are hidden. */}
              {([1, 2, 3, null] as const).map((tierVal) => {
                const group = targets.filter((t) => (t.tier ?? null) === tierVal);
                if (group.length === 0) return null;
                const meta = tierVal ? TIER_META[tierVal] : null;
                return (
                  <div key={String(tierVal)} className="tgt-tier-group" style={{ marginBottom: 14 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        margin: '8px 0 6px',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      <span
                        style={{
                          padding: '2px 10px',
                          borderRadius: 999,
                          background: meta?.bg ?? '#f3f4f6',
                          color: meta?.color ?? '#6b7280',
                          border: `1px solid ${meta?.border ?? '#e5e7eb'}`,
                        }}
                      >
                        {meta ? meta.label : 'Untiered'}
                      </span>
                      <span style={{ color: '#9ca3af', fontWeight: 400 }}>{group.length}</span>
                    </div>
                    <div className="tgt-list">
                      {group.map((t) => {
                        const isMeri = meriIds.has(t.memberId);
                        const name = t.memberName ?? t.memberId;
                        const ps = partyShort(t.party);
                        const dir = toDir(t.sourceDirectory);
                        // Optimistic add rows aren't persisted yet — tiering them would
                        // 404 (no row to update); disable until the add settles.
                        const pendingAdd = t.id.startsWith('optimistic-');
                        return (
                          <div className="tgt-row" key={`${dir}:${t.memberId}`}>
                            <div
                              className={`tgt-badge ${ps ?? ''}`}
                              style={{ background: partyBg(ps), color: partyColor(ps) }}
                            >
                              {ps ?? '·'}
                            </div>
                            <div className="tgt-info">
                              <div className="tgt-name">
                                <a
                                  onClick={(e) => {
                                    e.preventDefault();
                                    openProfile(dir, t.memberId);
                                  }}
                                  href={profileHref(dir, t.memberId)}
                                  style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
                                >
                                  {name}
                                </a>{' '}
                                {t.party || t.state ? (
                                  <span
                                    style={{ fontSize: 12, fontWeight: 400, color: partyColor(ps) }}
                                  >
                                    [{ps ?? '·'}-{t.state ?? '—'}]
                                  </span>
                                ) : null}
                                <span
                                  style={{
                                    marginLeft: 6,
                                    fontSize: 10,
                                    padding: '1px 5px',
                                    borderRadius: 4,
                                    background: DIR_BADGE[dir].bg,
                                    color: DIR_BADGE[dir].color,
                                  }}
                                >
                                  {DIR_BADGE[dir].label}
                                </span>
                              </div>
                              <div className="tgt-meta">
                                <span className="tgt-cmte">
                                  {[t.chamber, t.committee].filter(Boolean).join(' · ') || '—'}
                                </span>
                                {isMeri ? <span className="tgt-meri">⊙ Meri pick</span> : null}
                              </div>
                              {/* WS-E, LegiStorm gaps/enrichment plan — resolved fresh
                                  server-side from the member's CURRENT district, never
                                  from this row's own (possibly stale) `state` text. */}
                              {t.representedFacilities && t.representedFacilities.length > 0 ? (
                                <div className="tgt-meta" style={{ marginTop: 2 }}>
                                  <span style={{ fontSize: 11, color: '#059669' }}>
                                    📍 Represents{' '}
                                    {t.representedFacilities.length === 1
                                      ? t.representedFacilities[0]!.name
                                      : `${t.representedFacilities.length} client facilities`}
                                  </span>
                                </div>
                              ) : null}
                            </div>
                            {canManage ? (
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <div
                                  style={{
                                    display: 'inline-flex',
                                    border: '1px solid #e5e7eb',
                                    borderRadius: 6,
                                    overflow: 'hidden',
                                  }}
                                >
                                  {([1, 2, 3] as const).map((tv) => {
                                    const active = t.tier === tv;
                                    return (
                                      <button
                                        key={tv}
                                        disabled={pendingAdd}
                                        title={
                                          pendingAdd
                                            ? 'Saving…'
                                            : active
                                              ? `Clear Tier ${tv}`
                                              : `Assign Tier ${tv}`
                                        }
                                        onClick={() => {
                                          if (pendingAdd) return;
                                          setTier(t.memberId, active ? null : tv);
                                        }}
                                        style={{
                                          fontSize: 11,
                                          padding: '2px 7px',
                                          border: 'none',
                                          cursor: pendingAdd ? 'default' : 'pointer',
                                          opacity: pendingAdd ? 0.5 : 1,
                                          background: active ? TIER_META[tv].color : '#fff',
                                          color: active ? '#fff' : '#6b7280',
                                        }}
                                      >
                                        T{tv}
                                      </button>
                                    );
                                  })}
                                </div>
                                <button className="tgt-rm" onClick={() => remove(t.memberId)}>
                                  Remove
                                </button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Meri sidebar */}
      <div className="tg-side">
        <div className="meri-panel">
          <div className="mp-hd">
            <div className="mp-title">
              <div className="mp-m">M</div> Suggested by Meri
            </div>
            {canManage ? (
              <button
                className="mp-refresh"
                onClick={() => refreshMutation.mutate()}
                disabled={refreshing || recsLoading}
                title="Recompute recommendations from the latest tracked bills and facilities"
              >
                {refreshing ? '↻ Refreshing…' : '↻ Refresh'}
              </button>
            ) : (
              <span className="mp-sub">top 6 · weighted score</span>
            )}
          </div>
          <div className="mp-desc">
            Ranked by committee jurisdiction over tracked bills, with issue overlap and
            facility-district nexus layered in when available.
          </div>
          {computedAt && !recsLoading ? (
            <div className="mp-updated">Updated {relativeTime(computedAt)}</div>
          ) : null}

          {recsLoading ? (
            <div className="mp-empty" style={{ padding: '16px', fontSize: 12, color: '#9ca3af' }}>
              Computing recommendations… this runs once, then it&apos;s saved for instant loads.
            </div>
          ) : recsError ? (
            <div className="mp-empty" style={{ padding: '16px', fontSize: 12, color: '#9ca3af' }}>
              Couldn&apos;t load recommendations.{' '}
              {canManage ? (
                <button className="mp-inline-link" onClick={() => refreshMutation.mutate()}>
                  Try again
                </button>
              ) : null}
            </div>
          ) : meriSuggestions.length === 0 ? (
            <div className="mp-empty" style={{ padding: '16px', fontSize: 12, color: '#9ca3af' }}>
              No Meri suggestions yet. Confirm this client&apos;s LDA match and add tracked bills in
              the Intelligence tab, then Refresh to get recommendations.
            </div>
          ) : (
            meriSuggestions.map((m, idx) => {
              const added = addedIds.has(m.memberId);
              return (
                <div className="mp-row" key={m.memberId}>
                  <div className="mp-rank">{idx + 1}</div>
                  <div className="mp-info">
                    <div className="mp-name">
                      <a
                        onClick={(e) => {
                          e.preventDefault();
                          openProfile('congress', m.memberId);
                        }}
                        href={profileHref('congress', m.memberId)}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                      >
                        {m.office}
                      </a>
                    </div>
                    <div className="mp-pty">
                      <span style={{ color: partyColor(m.party), fontWeight: 600 }}>
                        [{m.party}-{m.state}]
                      </span>
                    </div>
                    <div className="mp-bills">
                      {m.billCount} tracked bill{m.billCount === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="mp-right">
                    <span className="mp-score">{m.score.toFixed(2)}</span>
                    {added ? (
                      <button className="btn-mini added" style={{ fontSize: 11, padding: '3px 7px' }}>
                        ✓ Added
                      </button>
                    ) : canManage ? (
                      <button
                        className="btn-mini add"
                        style={{ fontSize: 11, padding: '3px 7px' }}
                        onClick={() => add(m.memberId, 'meri', 'congress')}
                      >
                        + Add
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}

          <div className="mp-foot">
            <a
              onClick={(e) => {
                e.preventDefault();
                onViewIntelligence?.();
              }}
              href="#intelligence"
            >
              View all in Intelligence →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
