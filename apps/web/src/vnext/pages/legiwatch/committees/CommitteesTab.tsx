/**
 * Unified federal + Florida committee directory for LegiWatch.
 * Federal behavior remains intact. Florida uses the existing state directory
 * API and opens a state-aware LegiWatch room while carrying the client lens.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { LwPill, LwSkeleton } from '../lib/primitives.js';
import { LwStateEmpty, LwStateUnavailable } from '../states/SystemStates.js';
import {
  SOURCE_HEALTH_LABEL,
  SOURCE_HEALTH_TONE,
  normalizeSourceHealth,
} from '../lib/source-health.js';

interface CommitteeMemberRow {
  name: string;
  role: string | null;
}
interface FederalCommitteeRow {
  systemCode: string;
  name: string;
  chamber: string;
  isSubcommittee: boolean;
  upcomingEventCount: number;
  lastSyncedAt: string;
  sourceHealth: string;
  sourceHealthInheritedFrom: string | null;
  chair?: CommitteeMemberRow | null;
  rankingMember?: CommitteeMemberRow | null;
  following?: boolean;
  clientExposureCount?: number;
}
interface FederalDirectoryResponse {
  rows: FederalCommitteeRow[];
  total: number;
  parentCount: number;
  subcommitteeCount: number;
  asOf: string;
}
interface FloridaCommitteeRow {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  legislativeSession: string | null;
  officialSourceKey: string | null;
  sourceUrl: string | null;
  lastSyncedAt: string;
}

type Jurisdiction = 'US' | 'FL';
type FederalFilter = 'house' | 'senate' | 'joint' | 'full' | 'sub' | 'following';
type FloridaChamber = 'all' | 'house' | 'senate' | 'joint';

function ageLabel(iso: string): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 'update time unavailable';
  const hrs = Math.max(0, Math.round((Date.now() - at) / 3_600_000));
  if (hrs < 1) return 'updated just now';
  if (hrs < 24) return `updated ${hrs}h ago`;
  return `updated ${Math.round(hrs / 24)}d ago`;
}

function floridaChamber(chamber: string | null): FloridaChamber {
  const value = chamber?.toLowerCase();
  if (value === 'lower' || value === 'house') return 'house';
  if (value === 'upper' || value === 'senate') return 'senate';
  if (value === 'joint') return 'joint';
  return 'all';
}

function chamberLabel(chamber: string | null): string {
  const value = floridaChamber(chamber);
  if (value === 'house') return 'HOUSE';
  if (value === 'senate') return 'SENATE';
  if (value === 'joint') return 'JOINT';
  return 'CHAMBER UNCONFIRMED';
}

export function CommitteesTab() {
  const api = useApi();
  const apiScope = useApiScope();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const jurisdiction: Jurisdiction =
    searchParams.get('jurisdiction')?.toUpperCase() === 'FL' ? 'FL' : 'US';
  const clientId = searchParams.get('client') ?? '';
  const [q, setQ] = useState('');
  const [federalFilters, setFederalFilters] = useState<Set<FederalFilter>>(new Set());
  const [floridaChamberFilter, setFloridaChamberFilter] = useState<FloridaChamber>('all');
  const [floridaSession, setFloridaSession] = useState('all');

  const federal = useQuery<FederalDirectoryResponse, Error>({
    queryKey: ['lw-vnext', 'committees-directory', apiScope, 'US'],
    queryFn: async () =>
      (await api.get<FederalDirectoryResponse>('/api/legiwatch/live-hearings/committees')).data,
    enabled: jurisdiction === 'US',
    staleTime: 5 * 60_000,
  });
  const florida = useQuery<FloridaCommitteeRow[], Error>({
    queryKey: ['lw-vnext', 'committees-directory', apiScope, 'FL'],
    queryFn: async () =>
      (await api.get<FloridaCommitteeRow[]>('/api/legiwatch/live-hearings/state-committees')).data,
    enabled: jurisdiction === 'FL',
    retry: false,
    staleTime: 5 * 60_000,
  });

  const setJurisdiction = (next: Jurisdiction) => {
    const params = new URLSearchParams(searchParams);
    params.set('jurisdiction', next);
    setSearchParams(params, { replace: true });
    setQ('');
  };
  const toggleFederal = (key: FederalFilter) =>
    setFederalFilters((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const federalRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (federal.data?.rows ?? []).filter((committee) => {
      if (
        needle &&
        !committee.name.toLowerCase().includes(needle) &&
        !committee.systemCode.toLowerCase().includes(needle)
      )
        return false;
      if (federalFilters.size === 0) return true;
      const chamber = committee.chamber.toLowerCase();
      const chamberOk =
        (!federalFilters.has('house') &&
          !federalFilters.has('senate') &&
          !federalFilters.has('joint')) ||
        (federalFilters.has('house') && chamber === 'house') ||
        (federalFilters.has('senate') && chamber === 'senate') ||
        (federalFilters.has('joint') && chamber === 'joint');
      const levelOk =
        (!federalFilters.has('full') && !federalFilters.has('sub')) ||
        (federalFilters.has('full') && !committee.isSubcommittee) ||
        (federalFilters.has('sub') && committee.isSubcommittee);
      return (
        chamberOk && levelOk && (!federalFilters.has('following') || Boolean(committee.following))
      );
    });
  }, [federal.data, federalFilters, q]);

  const floridaSessions = useMemo(
    () =>
      [
        ...new Set(
          (florida.data ?? [])
            .map((row) => row.legislativeSession)
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort((a, b) => b.localeCompare(a)),
    [florida.data],
  );
  const floridaRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (florida.data ?? []).filter((committee) => {
      if (
        needle &&
        !committee.name.toLowerCase().includes(needle) &&
        !committee.id.toLowerCase().includes(needle)
      )
        return false;
      if (
        floridaChamberFilter !== 'all' &&
        floridaChamber(committee.chamber) !== floridaChamberFilter
      )
        return false;
      return floridaSession === 'all' || committee.legislativeSession === floridaSession;
    });
  }, [florida.data, floridaChamberFilter, floridaSession, q]);

  const query = jurisdiction === 'US' ? federal : florida;
  if (query.isLoading) {
    return (
      <div className="lw-body">
        <JurisdictionControl value={jurisdiction} onChange={setJurisdiction} />
        <div
          className="lw-card"
          style={{ padding: 18 }}
          role="status"
          aria-label="Loading the committee directory"
        >
          <p className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)', marginBottom: 8 }}>
            LOADING COMMITTEE DIRECTORY…
          </p>
          <LwSkeleton height={320} />
        </div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="lw-body">
        <JurisdictionControl value={jurisdiction} onChange={setJurisdiction} />
        <LwStateUnavailable
          source={
            jurisdiction === 'US'
              ? 'The federal committee directory'
              : 'The Florida committee directory'
          }
          reason={
            jurisdiction === 'US'
              ? 'The federal committee directory did not respond. This is not zero committees.'
              : 'Florida committee records could not be loaded. This is not evidence that Florida has no committees.'
          }
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  const federalFiltersOn = q.trim() !== '' || federalFilters.size > 0;
  const floridaFiltersOn =
    q.trim() !== '' || floridaChamberFilter !== 'all' || floridaSession !== 'all';
  const clearFilters = () => {
    setQ('');
    setFederalFilters(new Set());
    setFloridaChamberFilter('all');
    setFloridaSession('all');
  };
  const openRoom = (path: string) => {
    const params = new URLSearchParams();
    if (clientId) params.set('client', clientId);
    navigate(`${path}${params.size ? `?${params.toString()}` : ''}`);
  };

  return (
    <div className="lw-body">
      <JurisdictionControl value={jurisdiction} onChange={setJurisdiction} />
      <div className="lw-search" style={{ marginBottom: 12 }}>
        <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>
          ⌕
        </span>
        <input
          type="search"
          aria-label="Search committees"
          placeholder={
            jurisdiction === 'US'
              ? 'Search committees — try Armed Services'
              : 'Search Florida committees'
          }
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
      </div>
      {jurisdiction === 'US' ? (
        <FederalFilters
          active={federalFilters}
          onToggle={toggleFederal}
          onClear={clearFilters}
          showClear={federalFiltersOn}
        />
      ) : (
        <FloridaFilters
          chamber={floridaChamberFilter}
          session={floridaSession}
          sessions={floridaSessions}
          onChamber={setFloridaChamberFilter}
          onSession={setFloridaSession}
          onClear={clearFilters}
          showClear={floridaFiltersOn}
        />
      )}
      {jurisdiction === 'US' ? (
        <FederalDirectory
          response={federal.data!}
          rows={federalRows}
          filtersOn={federalFiltersOn}
          followingFilter={federalFilters.has('following')}
          onClear={clearFilters}
          onOpen={(code) => openRoom(`/legiwatch/committees/${encodeURIComponent(code)}`)}
        />
      ) : (
        <FloridaDirectory
          allCount={florida.data?.length ?? 0}
          rows={floridaRows}
          filtersOn={floridaFiltersOn}
          onClear={clearFilters}
          onOpen={(id) => openRoom(`/legiwatch/committees/FL/${encodeURIComponent(id)}`)}
        />
      )}
    </div>
  );
}

function JurisdictionControl({
  value,
  onChange,
}: {
  value: Jurisdiction;
  onChange: (value: Jurisdiction) => void;
}) {
  return (
    <div
      style={{
        marginBottom: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div role="group" aria-label="Committee jurisdiction" style={{ display: 'flex', gap: 8 }}>
        {(['US', 'FL'] as const).map((jurisdiction) => (
          <button
            key={jurisdiction}
            type="button"
            className={`lw-btn lw-filter-pill${value === jurisdiction ? ' is-active' : ''}`}
            aria-pressed={value === jurisdiction}
            onClick={() => onChange(jurisdiction)}
          >
            {jurisdiction === 'US' ? 'Federal' : 'Florida'}
          </button>
        ))}
      </div>
      {value === 'FL' ? (
        <Link to="/directory/state-committees" style={{ fontWeight: 700 }}>
          Open full State Directory →
        </Link>
      ) : null}
    </div>
  );
}

function FederalFilters({
  active,
  onToggle,
  onClear,
  showClear,
}: {
  active: Set<FederalFilter>;
  onToggle: (key: FederalFilter) => void;
  onClear: () => void;
  showClear: boolean;
}) {
  const filters: Array<{ key: FederalFilter; label: string }> = [
    { key: 'house', label: 'House' },
    { key: 'senate', label: 'Senate' },
    { key: 'joint', label: 'Joint' },
    { key: 'full', label: 'Full committees' },
    { key: 'sub', label: 'Subcommittees' },
    { key: 'following', label: 'Committees I follow' },
  ];
  return (
    <div
      role="group"
      aria-label="Committee filters"
      style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}
    >
      {filters.map((filter) => (
        <button
          key={filter.key}
          type="button"
          className={`lw-btn lw-filter-pill${active.has(filter.key) ? ' is-active' : ''}`}
          aria-pressed={active.has(filter.key)}
          onClick={() => onToggle(filter.key)}
        >
          {filter.label}
        </button>
      ))}
      {showClear ? (
        <button type="button" className="lw-btn" onClick={onClear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function FloridaFilters({
  chamber,
  session,
  sessions,
  onChamber,
  onSession,
  onClear,
  showClear,
}: {
  chamber: FloridaChamber;
  session: string;
  sessions: string[];
  onChamber: (value: FloridaChamber) => void;
  onSession: (value: string) => void;
  onClear: () => void;
  showClear: boolean;
}) {
  return (
    <div
      aria-label="Florida committee filters"
      style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}
    >
      {(['all', 'house', 'senate', 'joint'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className={`lw-btn lw-filter-pill${chamber === value ? ' is-active' : ''}`}
          aria-pressed={chamber === value}
          onClick={() => onChamber(value)}
        >
          {value === 'all' ? 'All chambers' : value[0]!.toUpperCase() + value.slice(1)}
        </button>
      ))}
      <label
        className="lw-mono"
        style={{
          fontSize: 11,
          color: 'var(--lw-meta)',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        SESSION
        <select
          aria-label="Florida legislative session"
          value={session}
          onChange={(event) => onSession(event.target.value)}
          className="lw-btn"
        >
          <option value="all">All sessions</option>
          {sessions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      {showClear ? (
        <button type="button" className="lw-btn" onClick={onClear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function FederalDirectory({
  response,
  rows,
  filtersOn,
  followingFilter,
  onClear,
  onOpen,
}: {
  response: FederalDirectoryResponse;
  rows: FederalCommitteeRow[];
  filtersOn: boolean;
  followingFilter: boolean;
  onClear: () => void;
  onOpen: (systemCode: string) => void;
}) {
  return (
    <>
      <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)', marginBottom: 12 }}>
        {filtersOn
          ? `SHOWING ${rows.length} OF ${response.total} FEDERAL COMMITTEES`
          : `${response.total} FEDERAL COMMITTEES`}{' '}
        · {response.parentCount} FULL COMMITTEES · {response.subcommitteeCount} SUBCOMMITTEES
        {response.asOf ? ` · DIRECTORY ${ageLabel(response.asOf).toUpperCase()}` : ''}
      </div>
      {rows.length === 0 ? (
        <>
          <LwStateEmpty
            title="No committees match these filters"
            onReset={filtersOn ? onClear : undefined}
          />
          <p className="lw-state__body" style={{ marginTop: -4 }}>
            {followingFilter
              ? 'Nothing here means no followed committee matches the other filters — follow state is managed inside each Committee Room.'
              : 'This empty result reflects the filters only. Source health is unchanged for the federal directory.'}
          </p>
        </>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 12,
          }}
        >
          {rows.map((committee) => {
            const health = normalizeSourceHealth(committee.sourceHealth);
            return (
              <div
                key={committee.systemCode}
                className="lw-card"
                style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span
                    className="lw-mono"
                    style={{ fontSize: 11, fontWeight: 600, color: 'var(--lw-meta)' }}
                  >
                    {committee.systemCode.toUpperCase()}
                  </span>
                  <LwPill tone="gray" size="22">
                    {committee.chamber.toUpperCase()} ·{' '}
                    {committee.isSubcommittee ? 'SUBCOMMITTEE' : 'FULL COMMITTEE'}
                  </LwPill>
                  {committee.following ? (
                    <LwPill tone="brand" size="22">
                      FOLLOWING
                    </LwPill>
                  ) : null}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{committee.name}</div>
                {committee.chair ? (
                  <div style={{ fontSize: 12, color: 'var(--lw-body)' }}>
                    Chair · {committee.chair.name}
                  </div>
                ) : null}
                {committee.rankingMember ? (
                  <div style={{ fontSize: 12, color: 'var(--lw-body)' }}>
                    Ranking · {committee.rankingMember.name}
                  </div>
                ) : null}
                <div style={{ fontSize: 12, color: 'var(--lw-body)' }}>
                  {committee.upcomingEventCount > 0
                    ? `${committee.upcomingEventCount} upcoming proceeding${committee.upcomingEventCount === 1 ? '' : 's'}`
                    : 'No upcoming proceedings'}
                </div>
                <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-faint)' }}>
                  Last official {ageLabel(committee.lastSyncedAt)}
                  {health === 'unknown'
                    ? ' · official-source status unknown — not zero activity'
                    : ''}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <LwPill tone={SOURCE_HEALTH_TONE[health]} size="22">
                    {SOURCE_HEALTH_LABEL[health]}
                  </LwPill>
                  {(committee.clientExposureCount ?? 0) > 0 ? (
                    <LwPill tone="brand" size="22">
                      {committee.clientExposureCount} client
                      {committee.clientExposureCount === 1 ? '' : 's'} exposed
                    </LwPill>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="lw-btn lw-btn--primary"
                  style={{ marginTop: 4 }}
                  onClick={() => onOpen(committee.systemCode)}
                >
                  Enter Committee Room →
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function FloridaDirectory({
  allCount,
  rows,
  filtersOn,
  onClear,
  onOpen,
}: {
  allCount: number;
  rows: FloridaCommitteeRow[];
  filtersOn: boolean;
  onClear: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)', marginBottom: 12 }}>
        {filtersOn
          ? `SHOWING ${rows.length} OF ${allCount} FLORIDA COMMITTEES`
          : `${allCount} FLORIDA COMMITTEES`}{' '}
        · PUBLISHED COMMITTEE IDENTITIES
      </div>
      {rows.length === 0 ? (
        <LwStateEmpty
          title="No Florida committees match these filters"
          onReset={filtersOn ? onClear : undefined}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 12,
          }}
        >
          {rows.map((committee) => (
            <div
              key={committee.id}
              className="lw-card"
              style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span
                  className="lw-mono"
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--lw-meta)' }}
                >
                  FL
                </span>
                <LwPill tone="gray" size="22">
                  {chamberLabel(committee.chamber)}
                </LwPill>
                {committee.legislativeSession ? (
                  <LwPill tone="gray" size="22">
                    {committee.legislativeSession}
                  </LwPill>
                ) : null}
              </div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{committee.name}</div>
              <div style={{ fontSize: 12, color: 'var(--lw-body)' }}>
                {committee.officialSourceKey
                  ? 'Official Florida identity verified'
                  : 'Published identity · official verification unavailable'}
              </div>
              <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-faint)' }}>
                {ageLabel(committee.lastSyncedAt)} · source health opens in room
              </div>
              <div style={{ fontSize: 12, color: 'var(--lw-meta)' }}>
                Committee follow and committee-level alerts are not available for Florida yet.
              </div>
              <button
                type="button"
                className="lw-btn lw-btn--primary"
                style={{ marginTop: 4 }}
                onClick={() => onOpen(committee.id)}
              >
                Enter Florida Committee Room →
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
