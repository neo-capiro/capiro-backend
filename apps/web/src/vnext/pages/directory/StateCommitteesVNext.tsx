import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useApiScope } from '../../../lib/use-api-scope.js';
import { safeOfficialHttpUrl } from '../legiwatch/lib/canonical-hearings.js';
import {
  STATE_CALENDAR_FEATURE,
  useIntelFeatureEnabled,
} from '../../../lib/intel-feature-flags.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DIRECTORY_PROFILE_ROUTES } from './directory-routes.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
type Body = {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  legislativeSession: string | null;
  officialSourceKey: string | null;
  sourceUrl: string | null;
  sourceEvidence?: { directory?: { sourceUrl?: string | null } } | null;
  lastSyncedAt: string;
};
export function chamberLabel(chamber: string | null): string {
  if (chamber === 'lower' || chamber === 'house') return 'House';
  if (chamber === 'upper' || chamber === 'senate') return 'Senate';
  if (chamber === 'joint') return 'Joint';
  return 'Chamber unconfirmed';
}

type Detail = {
  body: Body;
  members: Array<{ id: string; name: string; role: string | null; party: string | null }>;
  relatedLegacyBodies?: Array<{ id: string; name: string; chamber: string | null }>;
  rosterStatus: string;
  events: {
    rows: Array<{ id: string; title: string; date: string; eventStatus: string }>;
    total: number;
  };
};
export function StateCommitteesVNext({ id }: { id?: string }) {
  const api = useApi(),
    actor = useApiScope(),
    enabled = useIntelFeatureEnabled(STATE_CALENDAR_FEATURE);
  const data = useQuery({
    queryKey: ['state-committees', actor, id, enabled],
    enabled,
    retry: false,
    queryFn: async () =>
      (
        await api.get<Body[] | Detail>(
          `/api/legiwatch/live-hearings/state-committees${id ? `/${encodeURIComponent(id)}` : ''}`,
        )
      ).data,
  });
  const detail = id && data.data && !Array.isArray(data.data) ? data.data : null;
  return (
    <DirectoryShell
      eyebrow="DIRECTORY · FLORIDA"
      title={detail?.body.name ?? 'State Committees'}
      subtitle="Official Florida committee directory and linked records."
    >
      {!enabled ? (
        <CapiroEmptyState title="State committee calendars are not enabled for this workspace." />
      ) : data.isPending ? (
        <p role="status">Loading committee sources…</p>
      ) : data.isError ? (
        <p role="alert">
          Committee data could not be loaded.{' '}
          <button onClick={() => void data.refetch()}>Retry</button>
        </p>
      ) : detail ? (
        <article>
          <Link to="/directory/state-committees">All state committees</Link>
          <p>
            {detail.body.state} · {chamberLabel(detail.body.chamber)} ·{' '}
            {detail.body.legislativeSession ?? 'Session unconfirmed'}
          </p>
          {!detail.body.officialSourceKey ? (
            <p>The official committee link has not been confirmed for this record.</p>
          ) : null}
          {detail.body.officialSourceKey && !detail.members.length ? (
            <p>An official roster has not been verified for this entry.</p>
          ) : null}
          {detail.relatedLegacyBodies?.length ? (
            <section aria-label="Linked legacy committee records">
              <h2>Linked records</h2>
              <p>Earlier committee records may contain membership and hearing links. Their content has not been verified by this official directory listing.</p>
              <ul>
                {detail.relatedLegacyBodies?.map((legacy) => (
                  <li key={legacy.id}>
                    <Link to={DIRECTORY_PROFILE_ROUTES.stateCommittee(legacy.id)}>{chamberLabel(legacy.chamber)} record</Link> · {legacy.name}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {safeOfficialHttpUrl(detail.body.sourceEvidence?.directory?.sourceUrl) ? (
            <p>
              <a href={detail.body.sourceEvidence?.directory?.sourceUrl ?? undefined} target="_blank" rel="noreferrer">
                Official committee page
              </a>
            </p>
          ) : null}
          {safeOfficialHttpUrl(detail.body.sourceUrl) && detail.body.sourceUrl !== detail.body.sourceEvidence?.directory?.sourceUrl ? (
            <p>
              <a href={detail.body.sourceUrl!} target="_blank" rel="noreferrer">
                Linked published source
              </a>
            </p>
          ) : null}
          <h2>Members</h2>
          {detail.members.length ? (
            <ul>
              {detail.members.map((m) => (
                <li key={m.id}>
                  <Link to={DIRECTORY_PROFILE_ROUTES.stateLegislator(m.id)}>{m.name}</Link>
                  {m.role ? ` · ${m.role}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p>Membership has not been qualified for this source identity.</p>
          )}
          <h2>Committee calendar</h2>
          {detail.events.rows.length ? (
            <ul>
              {detail.events.rows.map((e) => (
                <li key={e.id}>
                  <Link to={`/legiwatch/hearings/${encodeURIComponent(e.id)}`}>{e.title}</Link> ·{' '}
                  {e.date} · {e.eventStatus}
                </li>
              ))}
            </ul>
          ) : (
            <p>No canonical events are linked to this committee source identity.</p>
          )}
          {detail.events.total > detail.events.rows.length ? (
            <p>
              {detail.events.rows.length} of {detail.events.total} events shown.
            </p>
          ) : null}
        </article>
      ) : (
        <ul>
          {(Array.isArray(data.data) ? data.data : []).map((b) => (
            <li key={b.id} style={{ marginBottom: 14 }}>
              <Link to={DIRECTORY_PROFILE_ROUTES.stateCommittee(b.id)}>{b.name}</Link> ·{' '}
              {chamberLabel(b.chamber)} · {b.legislativeSession ?? 'Session unconfirmed'}
              {!b.officialSourceKey ? <small> · Official committee link unconfirmed</small> : null}
            </li>
          ))}
        </ul>
      )}
    </DirectoryShell>
  );
}
