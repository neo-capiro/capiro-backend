import { useState } from 'react';
import { ArrowLeft, Briefcase, Library, Lock, Search, Users } from 'lucide-react';
import { useClientOptions, useMeetingLibrary } from './meetings-api.js';
import { formatDateShort } from './meetings-format.js';
import { MaterialBadges } from './meetings-ui.js';
import type { ArtifactKind, Meeting } from './meetings-types.js';

const LIMIT = 100;

/** The Meeting Library (spec §3, §6) — a port of the prototype LibraryPage:
 *  approved prep/notes/debriefs, private + shared, filterable + searchable. */
export function MeetingLibraryView({
  onBack,
  onOpenMeeting,
}: {
  onBack: () => void;
  onOpenMeeting: (m: Meeting) => void;
}) {
  const [clientId, setClientId] = useState<string | undefined>(undefined);
  const [type, setType] = useState<'all' | ArtifactKind>('all');
  const [vis, setVis] = useState<'all' | 'shared' | 'private'>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const clients = useClientOptions();
  const library = useMeetingLibrary({
    clientId,
    artifactType: type === 'all' ? undefined : type,
    visibility: vis === 'all' ? undefined : vis,
    page,
    limit: LIMIT,
  });

  const rows = (library.data?.data ?? []).filter((m) => {
    if (!q.trim()) return true;
    const hay = `${m.subject} ${m.client?.name ?? ''}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  const total = library.data?.total ?? 0;

  const toggle = (options: [string, string][], value: string, onChange: (v: string) => void) => (
    <div
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border-1)',
        borderRadius: 7,
        overflow: 'hidden',
      }}
    >
      {options.map(([v, l], i) => (
        <button
          key={v}
          type="button"
          onClick={() => {
            onChange(v);
            setPage(1);
          }}
          style={{
            padding: '6px 12px',
            border: 'none',
            borderLeft: i > 0 ? '1px solid var(--border-1)' : 'none',
            fontFamily: 'var(--font-sans)',
            background: value === v ? 'var(--ink-1)' : 'var(--bg-surface)',
            color: value === v ? '#fff' : 'var(--ink-2)',
            fontSize: 12,
            fontWeight: value === v ? 600 : 400,
            cursor: 'pointer',
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Breadcrumb */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 24px',
          borderBottom: '1px solid var(--border-1)',
          flexShrink: 0,
          background: 'var(--bg-surface)',
        }}
      >
        <button
          type="button"
          onClick={onBack}
          className="btn sm btn-ghost"
          style={{ gap: 6, color: 'var(--ink-2)' }}
        >
          <ArrowLeft size={14} />
          Meetings
        </button>
        <span style={{ color: 'var(--border-strong)' }}>/</span>
        <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Library</span>
      </div>

      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '24px 28px 40px',
          background: 'var(--bg-canvas)',
        }}
      >
        <div style={{ maxWidth: 940, margin: '0 auto' }}>
          <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Library size={20} style={{ color: 'var(--accent)' }} />
            <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.015em', margin: 0 }}>
              Meeting Library
            </h1>
          </div>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '0 0 20px' }}>
            Approved prep, notes, and debriefs — private and shared. Only materials you’ve approved
            or saved appear here. Searchable by client and date.
          </p>

          {/* Filters */}
          <div
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              alignItems: 'center',
              marginBottom: 18,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flex: 1,
                minWidth: 220,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-1)',
                borderRadius: 8,
                padding: '7px 12px',
              }}
            >
              <Search size={14} style={{ color: 'var(--ink-3)' }} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search meetings, clients…"
                style={{
                  border: 'none',
                  outline: 'none',
                  background: 'none',
                  fontSize: 13,
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--ink-1)',
                  flex: 1,
                }}
              />
            </div>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--ink-1)',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-1)',
                borderRadius: 7,
                padding: '6px 10px',
              }}
            >
              <Briefcase size={13} style={{ color: 'var(--ink-3)' }} />
              <select
                value={clientId ?? 'all'}
                onChange={(e) => {
                  setClientId(e.target.value === 'all' ? undefined : e.target.value);
                  setPage(1);
                }}
                style={{
                  border: 'none',
                  background: 'none',
                  fontSize: 12,
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--ink-1)',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value="all">All clients</option>
                {(clients.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {toggle(
              [
                ['all', 'All'],
                ['prep', 'Prep'],
                ['notes', 'Notes'],
                ['debrief', 'Debrief'],
              ],
              type,
              (v) => setType(v as 'all' | ArtifactKind),
            )}
            {toggle(
              [
                ['all', 'All'],
                ['shared', 'Shared'],
                ['private', 'Private'],
              ],
              vis,
              (v) => setVis(v as 'all' | 'shared' | 'private'),
            )}
          </div>

          {/* Results */}
          <div className="card" style={{ borderRadius: 10, overflow: 'hidden' }}>
            <div
              style={{
                display: 'flex',
                padding: '9px 16px',
                borderBottom: '1px solid var(--border-1)',
                background: 'var(--bg-surface-2)',
                fontSize: 10.5,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
                color: 'var(--ink-3)',
              }}
            >
              <span style={{ width: 110, flexShrink: 0 }}>Date</span>
              <span style={{ flex: 1 }}>Meeting</span>
              <span style={{ width: 210, flexShrink: 0 }}>Materials</span>
              <span style={{ width: 104, flexShrink: 0, textAlign: 'right' }}>Visibility</span>
            </div>
            {library.isLoading ? (
              <div
                style={{
                  padding: '34px',
                  textAlign: 'center',
                  fontSize: 13,
                  color: 'var(--ink-3)',
                }}
              >
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <div
                style={{
                  padding: '34px',
                  textAlign: 'center',
                  fontSize: 13,
                  color: 'var(--ink-3)',
                }}
              >
                No materials match those filters.
              </div>
            ) : (
              rows.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onOpenMeeting(m)}
                  className="mtg-lib-row"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    width: '100%',
                    textAlign: 'left',
                    cursor: 'pointer',
                    border: 'none',
                    borderBottom: i < rows.length - 1 ? '1px solid var(--border-1)' : 'none',
                    background: 'var(--bg-surface)',
                    padding: '13px 16px',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <span
                    style={{
                      width: 110,
                      flexShrink: 0,
                      fontSize: 12,
                      color: 'var(--ink-3)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatDateShort(m.startsAt)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, paddingRight: 12 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: 'var(--ink-1)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {m.subject}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                      {m.client?.name ?? 'No client'}
                    </span>
                  </span>
                  <span
                    style={{ width: 210, flexShrink: 0, display: 'flex', gap: 5, paddingRight: 12 }}
                  >
                    <MaterialBadges m={m} />
                  </span>
                  <span
                    style={{
                      width: 104,
                      flexShrink: 0,
                      display: 'flex',
                      justifyContent: 'flex-end',
                    }}
                  >
                    {m.visibility === 'shared' ? (
                      <span
                        className="pill success"
                        style={{
                          fontSize: 10,
                          display: 'inline-flex',
                          gap: 4,
                          alignItems: 'center',
                        }}
                      >
                        <Users size={10} />
                        Shared
                      </span>
                    ) : (
                      <span
                        className="pill muted"
                        style={{
                          fontSize: 10,
                          display: 'inline-flex',
                          gap: 4,
                          alignItems: 'center',
                        }}
                      >
                        <Lock size={10} />
                        Private
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>

          {total > LIMIT && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
                paddingTop: 14,
                alignItems: 'center',
              }}
            >
              <button
                type="button"
                className="btn sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                Page {page} of {Math.ceil(total / LIMIT)}
              </span>
              <button
                type="button"
                className="btn sm"
                disabled={page >= Math.ceil(total / LIMIT)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
