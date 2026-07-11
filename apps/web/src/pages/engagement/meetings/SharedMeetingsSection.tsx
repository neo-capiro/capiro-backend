import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircleFilled, RobotOutlined } from '@ant-design/icons';
import { useSharedMeetings } from './meetings-api.js';
import { formatDateShort } from './meetings-format.js';
import { type ArtifactKind, type Meeting } from './meetings-types.js';

const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  prep: 'Prep',
  notes: 'Notes',
  debrief: 'Debrief',
};

/** Material pills for a (possibly grouped) shared record: the UNION of every
 *  contributor's approved artifacts. For an ungrouped record this equals the
 *  single contributor's artifacts (identical to Phase 1); for a Phase-2 group it
 *  is the collective materials across all contributors. */
function recordArtifacts(m: Meeting): Record<ArtifactKind, boolean> {
  const kinds = new Set<ArtifactKind>(m.contributors.flatMap((c) => c.artifacts));
  return { prep: kinds.has('prep'), notes: kinds.has('notes'), debrief: kinds.has('debrief') };
}

/** Contributors (beyond the primary) who have their OWN prep/debrief that
 *  diverges — the only ones surfaced (spec §7.2). Notes are canonical/dedup'd,
 *  so a contributor whose only material is notes is not surfaced. Always empty
 *  in Phase 1 (single contributor) but computed per spec. */
function divergentContributors(m: Meeting) {
  return m.contributors
    .slice(1)
    .map((c) => ({ ...c, personal: c.artifacts.filter((a) => a !== 'notes') }))
    .filter((c) => c.personal.length > 0);
}

function SharedMeetingRow({ meeting }: { meeting: Meeting }) {
  const [expanded, setExpanded] = useState(false);
  const status = recordArtifacts(meeting);
  const primaryName = meeting.sharedBy?.name ?? meeting.contributors[0]?.name ?? 'A colleague';
  const others = divergentContributors(meeting);
  const notetakers = meeting.notetakers ?? [];

  return (
    <div>
      <Link to="/engagement" className="mtg-shared-row" style={{ textDecoration: 'none' }}>
        <div className="mtg-shared-main">
          <div className="mtg-shared-title">{meeting.subject}</div>
          <div className="mtg-shared-sub">
            {formatDateShort(meeting.startsAt)} · Shared by {primaryName}
            {others.length > 0 ? ` · +${others.length} with their own prep/debrief` : ''}
          </div>
          {notetakers.length > 1 ? (
            <div className="mtg-shared-sub">
              <RobotOutlined /> Auto-captured by {notetakers.length} notetakers:{' '}
              {notetakers.join(', ')}
            </div>
          ) : null}
        </div>
        <div className="mtg-artifacts">
          {(Object.keys(ARTIFACT_LABELS) as ArtifactKind[]).map((k) => (
            <span key={k} className={`mtg-artifact-pill${status[k] ? ' is-complete' : ''}`}>
              {status[k] ? <CheckCircleFilled /> : null}
              {ARTIFACT_LABELS[k]}
            </span>
          ))}
        </div>
      </Link>
      {others.length > 0 ? (
        <>
          <button
            type="button"
            className="mtg-contrib-expander"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide' : 'Show'} {others.length} contributor
            {others.length > 1 ? 's' : ''} with their own prep/debrief
          </button>
          {expanded ? (
            <div style={{ paddingLeft: 12 }}>
              {others.map((c) => (
                <div key={c.userId} className="mtg-shared-sub">
                  {c.name ?? 'Contributor'} — {c.personal.join(', ')}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** "Shared from meetings" — the canonical shared meeting records for a client
 *  (spec §8). One row per meeting, newest first. Renders nothing when empty. */
export function SharedMeetingsSection({ clientId }: { clientId: string }) {
  const shared = useSharedMeetings(clientId);
  const rows = shared.data ?? [];
  if (!rows.length) return null;

  return (
    <section className="mtg-shared-section">
      <h3 className="cp-tab-h3">Shared from meetings</h3>
      <div>
        {rows.map((m) => (
          <SharedMeetingRow key={m.id} meeting={m} />
        ))}
      </div>
    </section>
  );
}
