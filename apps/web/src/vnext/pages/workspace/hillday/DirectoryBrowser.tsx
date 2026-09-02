/**
 * Hill Day module — Directory browser (step 3's "Directory" tab).
 *
 * Same congressional Directory data and browsing pattern Outreach's target
 * picker uses — search, state/chamber filters, a paginated A–Z list, no
 * minimum query length — read through Hill Day's own internal bridge rather
 * than Outreach's route. Picking a member here creates a meeting with no
 * calendar event behind it (see addManualMeeting in api.ts); the date/time
 * is filled in as a placeholder and edited on the next step.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { HillDayClient } from './api.js';
import type { DirectoryBrowseContact } from './types.js';
import { HdIcon, HdPill, HdSecondary } from './ui.js';

const PAGE_SIZE = 50;

function contactSubline(c: DirectoryBrowseContact): string {
  return [[c.chamber, c.state && c.district ? `${c.state}-${c.district}` : c.state].filter(Boolean).join(' · '), c.partyName, c.committees[0]]
    .filter(Boolean)
    .join(' · ');
}

export function DirectoryBrowser({
  api,
  pickedMemberIds,
  onPick,
}: {
  api: HillDayClient;
  pickedMemberIds: Set<string>;
  onPick: (contact: DirectoryBrowseContact) => void;
}) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [state, setState] = useState('');
  const [chamber, setChamber] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, state, chamber]);

  const query = useQuery({
    queryKey: ['hd', 'directory-browse', debouncedQ, state, chamber, page],
    queryFn: () =>
      api.browseDirectory({
        q: debouncedQ || undefined,
        state: state || undefined,
        chamber: chamber || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    staleTime: 60_000,
  });

  const payload = query.data;
  const contacts = payload?.contacts ?? [];
  const totalPages = payload ? Math.max(1, Math.ceil(payload.total / payload.pageSize)) : 1;
  const unavailable = (payload?.sources ?? []).filter((s) => s.status !== 'ok');

  return (
    <div className="hd-client-list">
      <div className="hd-client-list__search">
        <HdIcon name="SearchLg" size={18} />
        <input
          type="text"
          placeholder="Search the Directory by name…"
          aria-label="Search the Directory"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="hd-eyebrow">
          {query.isPending ? 'Loading…' : query.isError ? 'Unavailable' : `${payload?.total ?? 0} members`}
        </span>
      </div>
      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 4px 8px' }}>
        <label className="hd-threads__window">
          <span>State</span>
          <select
            aria-label="Filter by state"
            value={state}
            onChange={(e) => setState(e.target.value)}
            style={{ background: 'transparent', border: 0, font: 'inherit', color: 'inherit' }}
          >
            <option value="">All</option>
            {(payload?.availableStates ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <HdIcon name="ChevronDown" size={15} />
        </label>
        <label className="hd-threads__window">
          <span>Chamber</span>
          <select
            aria-label="Filter by chamber"
            value={chamber}
            onChange={(e) => setChamber(e.target.value)}
            style={{ background: 'transparent', border: 0, font: 'inherit', color: 'inherit' }}
          >
            <option value="">All</option>
            {(payload?.availableChambers ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <HdIcon name="ChevronDown" size={15} />
        </label>
      </span>
      {unavailable.length > 0 && (
        <p className="hd-step-sub" style={{ color: 'var(--hd-amber-600)', padding: '0 4px' }}>
          Directory unavailable right now{unavailable[0]?.detail ? ` — ${unavailable[0].detail}` : ''}.
        </p>
      )}
      {contacts.map((c) => {
        const picked = pickedMemberIds.has(c.id);
        return (
          <button
            key={c.id}
            type="button"
            className={`hd-client-row${picked ? ' hd-client-row--on' : ''}`}
            disabled={picked}
            onClick={() => onPick(c)}
          >
            <span className="hd-client-row__mono">{c.state || '—'}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="hd-client-row__name">{c.fullName}</span>
              <span className="hd-client-row__meta">{contactSubline(c)}</span>
            </span>
            {picked ? (
              <HdPill tone="navy">Added</HdPill>
            ) : (
              <span style={{ color: 'var(--hd-gray-400)', display: 'flex' }}>
                <HdIcon name="Plus" size={18} />
              </span>
            )}
          </button>
        );
      })}
      {!query.isPending && contacts.length === 0 && (
        <div className="hd-client-row" style={{ cursor: 'default' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="hd-client-row__name">{query.isError ? 'Directory unavailable' : 'No members match'}</span>
            <span className="hd-client-row__meta">
              {query.isError ? 'The Directory could not be read. Retry in a moment.' : 'Try another name, state, or chamber.'}
            </span>
          </span>
        </div>
      )}
      {payload && payload.total > payload.pageSize && (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '8px 4px 0' }}>
          <span className="hd-eyebrow">
            Page {payload.page} of {totalPages}
          </span>
          <HdSecondary disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">
            <HdIcon name="ChevronDown" size={16} className="hd-rotate-90" />
          </HdSecondary>
          <HdSecondary disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} aria-label="Next page">
            <HdIcon name="ChevronDown" size={16} className="hd-rotate-270" />
          </HdSecondary>
        </span>
      )}
    </div>
  );
}
