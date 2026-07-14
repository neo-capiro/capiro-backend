import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useSharedMeetings } from './meetings-api.js';
import { formatDateShort } from './meetings-format.js';
import { type ArtifactKind, type Meeting } from './meetings-types.js';

const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  prep: 'Prep',
  notes: 'Notes',
  debrief: 'Debrief',
};

/** Union of every contributor's approved artifacts (ungrouped = the single
 *  contributor's; Phase-2 group = the collective set). */
function recordArtifacts(m: Meeting): ArtifactKind[] {
  const kinds = new Set<ArtifactKind>(m.contributors.flatMap((c) => c.artifacts));
  return (['prep', 'notes', 'debrief'] as ArtifactKind[]).filter((k) => kinds.has(k));
}

/** Contributors beyond the primary who have their OWN prep/debrief that diverges
 *  (notes are canonical, so notes-only contributors aren't surfaced) — spec §7.2. */
function divergentContributors(m: Meeting) {
  return m.contributors
    .slice(1)
    .map((c) => ({ ...c, personal: c.artifacts.filter((a) => a !== 'notes') }))
    .filter((c) => c.personal.length > 0);
}

function SharedMeetingRow({ meeting, last }: { meeting: Meeting; last: boolean }) {
  const [open, setOpen] = useState(false);
  const arts = recordArtifacts(meeting);
  const primaryName = meeting.sharedBy?.name ?? meeting.contributors[0]?.name ?? 'A colleague';
  const others = divergentContributors(meeting);
  const notetakers = meeting.notetakers ?? [];

  return (
    <div
      style={{
        borderBottom: last ? 'none' : '1px solid var(--border-1)',
        background: open ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
      }}
    >
      <Link
        to="/engagement"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          textDecoration: 'none',
          padding: '12px 15px',
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
          {formatDateShort(meeting.startsAt)}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
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
            {meeting.subject}
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            Shared by {primaryName}
            {others.length > 0 && <span> · +{others.length} with their own prep/debrief</span>}
            {notetakers.length > 1 && <span> · {notetakers.length} notetakers</span>}
          </span>
        </span>
        <span style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          {arts.map((a) => (
            <span key={a} className="pill success" style={{ fontSize: 10 }}>
              {ARTIFACT_LABELS[a]}
            </span>
          ))}
        </span>
        <ChevronRight size={15} style={{ color: 'var(--ink-4)', flexShrink: 0 }} />
      </Link>
      {others.length > 0 && (
        <div style={{ padding: '0 15px 10px 125px' }}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'var(--font-sans)',
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--accent)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {open ? 'Hide' : 'Show'} {others.length} contributor{others.length > 1 ? 's' : ''} with
            their own prep/debrief
          </button>
          {open && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {others.map((c) => (
                <div key={c.userId} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ fontSize: 12, color: 'var(--ink-2)', minWidth: 130 }}>
                    {c.name ?? 'Contributor'}
                  </span>
                  <span style={{ display: 'flex', gap: 5 }}>
                    {c.personal.map((a) => (
                      <span key={a} className="pill success" style={{ fontSize: 10 }}>
                        {ARTIFACT_LABELS[a]}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
              <span style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 1 }}>
                Notes are one shared summary for this meeting; each person’s own prep and debrief
                are retained separately.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FILTER_LABELS: Array<['all' | ArtifactKind, string]> = [
  ['all', 'All'],
  ['prep', 'Prep'],
  ['notes', 'Notes'],
  ['debrief', 'Debrief'],
];

/** Dark-active segmented toggle — same visual pattern as MeetingLibraryView's
 *  Prep/Notes/Debrief filter, reused here for consistency. */
function ArtifactFilterToggle({
  value,
  onChange,
}: {
  value: 'all' | ArtifactKind;
  onChange: (v: 'all' | ArtifactKind) => void;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border-1)',
        borderRadius: 7,
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {FILTER_LABELS.map(([v, l], i) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
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
}

/** "Shared from meetings" — the canonical shared meeting records for a client
 *  (spec §8). One row per meeting, newest first. Renders nothing when empty. */
export function SharedMeetingsSection({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName?: string;
}) {
  const shared = useSharedMeetings(clientId);
  const [q, setQ] = useState('');
  const [type, setType] = useState<'all' | ArtifactKind>('all');
  const all = shared.data ?? [];
  if (!all.length) return null;

  const rows = all.filter((m) => {
    if (type !== 'all' && !recordArtifacts(m).includes(type)) return false;
    if (!q.trim()) return true;
    const hay = `${m.subject} ${m.sharedBy?.name ?? ''}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  return (
    <section style={{ margin: '20px 0' }}>
      <div
        style={{
          margin: '0 0 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink-1)' }}>
            Shared from meetings
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            Prep, notes &amp; debriefs your team shared to {clientName ?? 'this client'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 200,
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
              placeholder="Search…"
              style={{
                border: 'none',
                outline: 'none',
                background: 'none',
                fontSize: 13,
                fontFamily: 'var(--font-sans)',
                color: 'var(--ink-1)',
                flex: 1,
                minWidth: 0,
              }}
            />
          </div>
          <ArtifactFilterToggle value={type} onChange={setType} />
        </div>
      </div>
      {rows.length ? (
        <div className="card" style={{ borderRadius: 10, overflow: 'hidden' }}>
          {rows.map((m, i) => (
            <SharedMeetingRow key={m.id} meeting={m} last={i === rows.length - 1} />
          ))}
        </div>
      ) : (
        <div
          style={{
            padding: '20px 15px',
            textAlign: 'center',
            fontSize: 12.5,
            color: 'var(--ink-3)',
          }}
        >
          No shared meetings match this search/filter.
        </div>
      )}
    </section>
  );
}
