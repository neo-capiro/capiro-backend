import { useQuery } from '@tanstack/react-query';
import { useMe } from '../../lib/me.js';
import { useApi } from '../../lib/use-api.js';
import {
  readMeriJob,
  type MeriJobStatus,
  type MeriJobView,
} from '../../components/chat/meri-research-recovery.js';

const LABELS: Partial<Record<MeriJobStatus, string>> = {
  planning: 'Planning',
  executing: 'Working',
  waiting_for_user: 'Waiting for you',
  finalizing: 'Finishing',
  cancel_requested: 'Stopping',
  queued: 'Paused — open to resume',
};
/** A paused job needs a signed-in client to resume; only recent ones are listed. */
const PAUSED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MeriRunningJobRow {
  id: string;
  title: string;
  conversationId: string;
  job: MeriJobView;
}

/** Jobs the user should see as running (or recently paused) in the thread rail. */
export function runningJobRows(value: unknown, now = Date.now()): MeriRunningJobRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const job = readMeriJob(row.job);
    const metadata =
      row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : {};
    const handoff =
      metadata.handoff && typeof metadata.handoff === 'object'
        ? (metadata.handoff as Record<string, unknown>)
        : {};
    const conversationId = typeof handoff.conversationId === 'string' ? handoff.conversationId : null;
    if (typeof row.id !== 'string' || !job || !conversationId || !LABELS[job.status]) return [];
    if (job.status === 'queued') {
      const updatedAt = typeof row.updatedAt === 'string' ? Date.parse(row.updatedAt) : NaN;
      if (!Number.isFinite(updatedAt) || now - updatedAt > PAUSED_WINDOW_MS) return [];
    }
    return [
      {
        id: row.id,
        title: typeof row.title === 'string' && row.title.trim() ? row.title : 'Meri job',
        conversationId,
        job,
      },
    ];
  });
}

/** Stage 2 running-jobs section (dark behind features.meriJobs). */
export function MeriRunningJobs({
  identityKey,
  onSelect,
}: {
  identityKey: string;
  onSelect: (conversationId: string) => void;
}) {
  const api = useApi();
  const jobsEnabled = useMe().data?.features?.meriJobs === true;
  const query = useQuery<MeriRunningJobRow[]>({
    queryKey: ['meri-vnext', identityKey, 'running-jobs'],
    queryFn: async () => runningJobRows((await api.get('/api/clio/research')).data),
    enabled: jobsEnabled,
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.data?.length ? 15_000 : 60_000),
  });
  const rows = jobsEnabled && Array.isArray(query.data) ? query.data : [];
  if (!rows.length) return null;
  return (
    <section data-meri-rail-section="running-jobs" aria-label="Running jobs">
      <div className="vnext-meri__section-label-row">
        <span className="vnext-meri__section-label">RUNNING JOBS</span>
      </div>
      <ul className="vnext-meri__running-jobs">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="vnext-meri__running-job"
              onClick={() => onSelect(row.conversationId)}
            >
              <span className="vnext-meri__running-job-title">{row.title}</span>
              <small>{LABELS[row.job.status]}</small>
            </button>
          </li>
        ))}
      </ul>
      <p className="vnext-meri__running-jobs-note">
        Jobs continue in the background when you close this tab.
      </p>
    </section>
  );
}
