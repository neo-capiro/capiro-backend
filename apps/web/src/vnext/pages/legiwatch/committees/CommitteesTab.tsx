/**
 * Committees — primary destination (LEGIWATCH-V2-HANDOFF §5.6). A browsable
 * directory of every current committee and subcommittee, including
 * zero-hearing bodies — never a coverage gap. The whole ≤230-row catalog is
 * fetched once and filtered client-side (search + six pills); this is the
 * same directory read the Committee Room and calendar links already use, so
 * there is no second endpoint and no per-card request.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { LwPill, LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
import {
  SOURCE_HEALTH_LABEL,
  SOURCE_HEALTH_TONE,
  normalizeSourceHealth,
} from '../lib/source-health.js';

interface CommitteeMemberRow { name: string; role: string | null }
interface CommitteeRow {
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
interface DirectoryResponse {
  rows: CommitteeRow[];
  total: number;
  parentCount: number;
  subcommitteeCount: number;
  asOf: string;
}

type FilterKey = 'house' | 'senate' | 'joint' | 'full' | 'sub' | 'following';

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 1) return 'updated just now';
  if (hrs < 24) return `updated ${hrs}h ago`;
  return `updated ${Math.round(hrs / 24)}d ago`;
}

export function CommitteesTab() {
  const api = useApi();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState<Set<FilterKey>>(new Set());

  const directory = useQuery<DirectoryResponse, Error>({
    queryKey: ['lw-vnext', 'committees-directory'],
    queryFn: async () => (await api.get<DirectoryResponse>('/api/legiwatch/live-hearings/committees')).data,
    staleTime: 5 * 60_000,
  });

  const toggle = (k: FilterKey) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const rows = useMemo(() => {
    const all = directory.data?.rows ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((c) => {
      if (needle && !c.name.toLowerCase().includes(needle) && !c.systemCode.toLowerCase().includes(needle)) {
        return false;
      }
      if (active.size === 0) return true;
      const chamberOk =
        (!active.has('house') && !active.has('senate') && !active.has('joint')) ||
        (active.has('house') && c.chamber.toLowerCase() === 'house') ||
        (active.has('senate') && c.chamber.toLowerCase() === 'senate') ||
        (active.has('joint') && c.chamber.toLowerCase() === 'joint');
      const levelOk =
        (!active.has('full') && !active.has('sub')) ||
        (active.has('full') && !c.isSubcommittee) ||
        (active.has('sub') && c.isSubcommittee);
      const followingOk = !active.has('following') || Boolean(c.following);
      return chamberOk && levelOk && followingOk;
    });
  }, [directory.data, q, active]);

  if (directory.isLoading) {
    return (
      <div className="lw-body">
        <div className="lw-card" style={{ padding: 18 }}><LwSkeleton height={320} /></div>
      </div>
    );
  }
  if (directory.isError) {
    return (
      <div className="lw-body">
        <LwStateUnavailable
          source="The committee directory"
          reason="Congress.gov and committee-page sources did not respond. This is not zero committees."
          onRetry={() => directory.refetch()}
        />
      </div>
    );
  }

  const total = directory.data?.total ?? 0;
  const parentCount = directory.data?.parentCount ?? 0;
  const subCount = directory.data?.subcommitteeCount ?? 0;

  const FILTERS: Array<{ key: FilterKey; label: string }> = [
    { key: 'house', label: 'House' },
    { key: 'senate', label: 'Senate' },
    { key: 'joint', label: 'Joint' },
    { key: 'full', label: 'Full committees' },
    { key: 'sub', label: 'Subcommittees' },
    { key: 'following', label: 'Committees I follow' },
  ];

  return (
    <div className="lw-body">
      <div className="lw-search" style={{ marginBottom: 12 }}>
        <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>⌕</span>
        <input
          type="search"
          aria-label="Search committees"
          placeholder="Search committees — try Armed Services"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div role="group" aria-label="Committee filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`lw-btn lw-filter-pill${active.has(f.key) ? ' is-active' : ''}`}
            aria-pressed={active.has(f.key)}
            onClick={() => toggle(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)', marginBottom: 12 }}>
        {total} CURRENT BODIES · {parentCount} FULL COMMITTEES · {subCount} SUBCOMMITTEES
      </div>

      {rows.length === 0 ? (
        <div className="lw-card" style={{ padding: 24, textAlign: 'center' }}>
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>
            No committees match these filters. Source health is unchanged.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {rows.map((c) => {
            const health = normalizeSourceHealth(c.sourceHealth);
            return (
              <div key={c.systemCode} className="lw-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="lw-mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--lw-meta)' }}>
                    {c.systemCode.toUpperCase()}
                  </span>
                  <LwPill tone="gray" size="22">{c.chamber.toUpperCase()} · {c.isSubcommittee ? 'SUBCOMMITTEE' : 'FULL COMMITTEE'}</LwPill>
                  {c.following ? <LwPill tone="brand" size="22">FOLLOWING</LwPill> : null}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</div>
                {c.chair ? (
                  <div style={{ fontSize: 12, color: 'var(--lw-body)' }}>
                    Chair · {c.chair.name}
                  </div>
                ) : null}
                {c.rankingMember ? (
                  <div style={{ fontSize: 12, color: 'var(--lw-body)' }}>
                    Ranking · {c.rankingMember.name}
                  </div>
                ) : null}
                <div style={{ fontSize: 12, color: 'var(--lw-body)' }}>
                  {c.upcomingEventCount > 0
                    ? `${c.upcomingEventCount} upcoming proceeding${c.upcomingEventCount === 1 ? '' : 's'}`
                    : 'No upcoming proceedings'}
                </div>
                <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-faint)' }}>
                  Last official {ageLabel(c.lastSyncedAt)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <LwPill tone={SOURCE_HEALTH_TONE[health]} size="22">{SOURCE_HEALTH_LABEL[health]}</LwPill>
                  {(c.clientExposureCount ?? 0) > 0 ? (
                    <LwPill tone="brand" size="22">
                      {c.clientExposureCount} client{c.clientExposureCount === 1 ? '' : 's'} exposed
                    </LwPill>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="lw-btn lw-btn--primary"
                  style={{ marginTop: 4 }}
                  onClick={() => navigate(`/legiwatch/committees/${encodeURIComponent(c.systemCode)}`)}
                >
                  Enter Committee Room →
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
