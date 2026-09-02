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

type StaffMember = DirectoryBrowseContact['staff'][number];

const PAGE_SIZE = 50;
const HONORIFIC_RE = /^(Rep\.|Del\.|Sen\.|Dr\.|Mr\.|Mrs\.|Ms\.)\s+/;

/** "Rep. Alma Adams" → "AA"; a single-word name falls back to its first two letters. */
function initials(fullName: string): string {
  const parts = fullName.replace(HONORIFIC_RE, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/** `district` is sometimes just the number ("12"), sometimes already
 *  state-prefixed ("NC-12") depending on which snapshot field populated it —
 *  compose defensively rather than risk "NC-NC-12". */
function districtLabel(c: Pick<DirectoryBrowseContact, 'state' | 'district'>): string {
  if (!c.district) return c.state || '';
  if (!c.state || c.district === c.state || c.district.startsWith(`${c.state}-`)) return c.district;
  return `${c.state}-${c.district}`;
}

function memberOfficeLines(c: DirectoryBrowseContact): { primary: string; secondary: string } {
  return {
    primary: c.office || `${c.fullName} office`,
    secondary: [c.chamber, districtLabel(c), c.partyName || c.party].filter(Boolean).join(' · '),
  };
}

function memberCommitteeLines(c: DirectoryBrowseContact): { primary: string; secondary: string } {
  return {
    primary: c.committees.length ? c.committees.slice(0, 2).join(' · ') : '—',
    secondary: `${c.staff.length} staff`,
  };
}

function staffOfficeLines(s: StaffMember, c: DirectoryBrowseContact): { primary: string; secondary: string } {
  return {
    primary: s.officeLocation || '—',
    secondary: `Staff to ${c.fullName} · ${districtLabel(c)}`,
  };
}

/** Mirrors the Directory page's own coverageLines(): issue areas headline, roles as the
 *  detail line, falling back to the same "No coverage recorded" copy when both are empty. */
function coverageLines(s: StaffMember): { primary: string; secondary: string } {
  const issues = s.issueAreas.filter(Boolean);
  const roles = s.roles.filter(Boolean);
  return {
    primary: issues.length ? issues.slice(0, 2).join(' · ') : '—',
    secondary: roles.length ? roles.slice(0, 2).join(' · ') : 'No coverage recorded',
  };
}

export function DirectoryBrowser({
  api,
  pickedMemberIds,
  pickedStafferIds,
  onPick,
  onPickStaff,
}: {
  api: HillDayClient;
  pickedMemberIds: Set<string>;
  pickedStafferIds: Set<string>;
  onPick: (contact: DirectoryBrowseContact) => void;
  onPickStaff: (staffer: StaffMember, contact: DirectoryBrowseContact) => void | Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [state, setState] = useState('');
  const [chamber, setChamber] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleExpand = (memberId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });

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
        const isExpanded = expanded.has(c.id);
        const rosterId = `hd-dir-roster-${c.id}`;
        const officeLines = memberOfficeLines(c);
        const committeeLines = memberCommitteeLines(c);
        return (
          <div key={c.id}>
            <div className={`hd-dir-row hd-dir-row--member hd-dir-hgrid${picked ? ' hd-dir-row--on' : ''}`}>
              <button
                type="button"
                className="hd-dir-caret"
                aria-expanded={isExpanded}
                aria-controls={rosterId}
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} staff for ${c.fullName}`}
                onClick={() => toggleExpand(c.id)}
              >
                <HdIcon name="ChevronDown" size={13} className={isExpanded ? '' : 'hd-rotate-270'} />
              </button>
              <button type="button" className="hd-dir-select hd-dir-rowgrid" disabled={picked} onClick={() => onPick(c)}>
                <span className="hd-dir-cell hd-dir-cell--person">
                  <span className="hd-dir-avatar" aria-hidden="true">
                    {initials(c.fullName)}
                  </span>
                  <span className="hd-dir-cell" style={{ gap: 2 }}>
                    <span className="hd-dir-cell__primary">{c.fullName}</span>
                    <span className="hd-dir-cell__secondary">Member of Congress</span>
                  </span>
                </span>
                <span className="hd-dir-cell hd-dir-cell--mono">
                  <span className="hd-dir-cell__primary">{officeLines.primary}</span>
                  <span className="hd-dir-cell__secondary">{officeLines.secondary}</span>
                </span>
                <span className="hd-dir-cell hd-dir-cell--mono">
                  <span className="hd-dir-cell__primary">{committeeLines.primary}</span>
                  <span className="hd-dir-cell__secondary">{committeeLines.secondary}</span>
                </span>
                <span className="hd-dir-cell hd-dir-cell--mono">
                  <span className="hd-dir-cell__primary">{c.email || 'No email'}</span>
                  <span className="hd-dir-cell__secondary">{c.phone || 'No phone'}</span>
                </span>
                <span className="hd-dir-cell hd-dir-cell--trailing">
                  {picked ? (
                    <HdPill tone="navy">Added</HdPill>
                  ) : (
                    <span style={{ color: 'var(--hd-gray-400)', display: 'flex' }}>
                      <HdIcon name="Plus" size={18} />
                    </span>
                  )}
                </span>
              </button>
            </div>
            <div id={rosterId} className="hd-dir-roster" hidden={!isExpanded}>
              {c.staff.length === 0 ? (
                <p className="hd-dir-roster__empty">No staffer contacts synced for this office.</p>
              ) : (
                c.staff.map((s) => {
                  const coverage = coverageLines(s);
                  const staffOffice = staffOfficeLines(s, c);
                  const staffPicked = pickedStafferIds.has(s.id);
                  return (
                    <div key={s.id} className="hd-dir-row hd-dir-row--staff hd-dir-hgrid">
                      <span className="hd-dir-branch" aria-hidden="true" />
                      <div className="hd-dir-select hd-dir-rowgrid">
                        <span className="hd-dir-cell hd-dir-cell--person">
                          <span className="hd-dir-avatar" aria-hidden="true">
                            {initials(s.fullName)}
                          </span>
                          <span className="hd-dir-cell" style={{ gap: 2 }}>
                            <span className="hd-dir-cell__primary">
                              {s.fullName}
                              {s.isCurrent ? '' : ' · Former'}
                            </span>
                            <span className="hd-dir-cell__secondary">{s.title || 'Staffer'}</span>
                          </span>
                        </span>
                        <span className="hd-dir-cell hd-dir-cell--mono">
                          <span className="hd-dir-cell__primary">{staffOffice.primary}</span>
                          <span className="hd-dir-cell__secondary">{staffOffice.secondary}</span>
                        </span>
                        <span className="hd-dir-cell hd-dir-cell--mono">
                          <span className="hd-dir-cell__primary">{coverage.primary}</span>
                          <span className="hd-dir-cell__secondary">{coverage.secondary}</span>
                        </span>
                        <span className="hd-dir-cell hd-dir-cell--mono">
                          <span className="hd-dir-cell__primary">{s.email || 'No email'}</span>
                          <span className="hd-dir-cell__secondary">{s.phone || 'No phone'}</span>
                        </span>
                        <span className="hd-dir-cell hd-dir-cell--trailing">
                          {staffPicked ? (
                            <HdPill tone="navy">Added</HdPill>
                          ) : (
                            <button
                              type="button"
                              className="hd-dir-staffpick"
                              onClick={() => void onPickStaff(s, c)}
                              aria-label={`Add ${s.fullName} to the packet`}
                            >
                              <HdIcon name="Plus" size={15} />
                            </button>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
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
