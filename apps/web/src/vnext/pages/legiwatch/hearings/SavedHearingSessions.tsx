import { Link } from 'react-router-dom';
import { LwButton, LwPill } from '../lib/primitives.js';
import {
  savedHearingSessionPath,
  useSavedHearingSessions,
  type SavedHearingSession,
} from '../lib/saved-hearing-sessions.js';

export function SavedSessionLinks({ sessions }: { sessions: SavedHearingSession[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'grid', gap: 10 }}>
      {sessions.map((session) => (
        <li key={session.id}>
          <Link className="lw-backlink" to={savedHearingSessionPath(session.id)}>
            Open saved session: {session.title}
          </Link>
          <div className="lw-card__meta" style={{ marginTop: 4 }}>
            {session.transcriptSegmentCount} saved transcript segments ·{' '}
            {session.intelligenceMomentCount} intelligence moments ·{' '}
            {session.status.replace(/_/g, ' ')}
            {session.startedAt ? ` · ${new Date(session.startedAt).toLocaleDateString()}` : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SavedHearingSessions({ hearingId }: { hearingId: string }) {
  const saved = useSavedHearingSessions(hearingId);
  const unavailable = saved.isError || saved.data?.savedSessionsState === 'unavailable';
  return (
    <section className="lw-card" style={{ padding: 18 }} aria-label="Saved hearing sessions">
      <div className="lw-card__head">
        <h2 className="lw-card__title">Saved hearing sessions</h2>
        {saved.data?.sessions.some((session) => session.transcriptSegmentCount > 0) ? (
          <LwPill tone="brand" size="22">Saved transcript available</LwPill>
        ) : null}
      </div>
      <p className="lw-card__meta" style={{ margin: '8px 0' }}>
        Open your team's saved session to read its transcript and intelligence.
        These sessions are separate from automatic capture below.
      </p>
      {saved.isPending ? (
        <p role="status" className="lw-card__meta">Checking saved sessions…</p>
      ) : unavailable ? (
        <div role="alert">
          <p className="lw-card__meta">Saved sessions could not be checked. This does not mean no recording exists.</p>
          <LwButton onClick={() => void saved.refetch()}>Retry saved sessions</LwButton>
        </div>
      ) : saved.data?.sessions.length ? (
        <SavedSessionLinks sessions={saved.data.sessions} />
      ) : (
        <p className="lw-card__meta">
          No accessible saved session is linked to this proceeding.{' '}
          <Link className="lw-backlink" to="/legiwatch?tab=hearings&sub=sessions">Browse My Sessions</Link>
          {' '}to find recordings without a verified hearing link.
        </p>
      )}
    </section>
  );
}
