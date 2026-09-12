import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';

/** Read-only freshness notice. A published calendar change never edits a draft. */
export function PreparationRevisionNotice({ config }: { config: unknown }) {
  const api = useApi(),
    actor = useApiScope();
  const context = (config as { legiwatch?: { snapshotId?: string; mode?: string } } | null)
    ?.legiwatch;
  const snapshotId = context?.mode === 'preparation' ? context.snapshotId : undefined;
  const status = useQuery({
    queryKey: ['lw-preparation-status', actor, snapshotId],
    enabled: Boolean(snapshotId),
    retry: false,
    staleTime: 30000,
    queryFn: async () =>
      (
        await api.get<{
          stale: boolean;
          hearingId: string;
          preparedRevision: number;
          currentRevision: number;
        }>(`/intel-api/legiwatch/calendar/preparations/${encodeURIComponent(snapshotId!)}/status`)
      ).data,
  });
  if (!snapshotId) return null;
  if (status.isError)
    return (
      <div role="status" className="ws-vnext-banner" data-variant="amber">
        The preparation source could not be checked. Your saved draft is unchanged.
      </div>
    );
  if (!status.data?.stale) return null;
  return (
    <div role="status" className="ws-vnext-banner" data-variant="amber">
      The published calendar changed after this preparation (revision {status.data.preparedRevision}{' '}
      → {status.data.currentRevision}).{' '}
      <a href={`/legiwatch/hearings/${encodeURIComponent(status.data.hearingId)}`}>
        Review the current agenda and create a new preparation
      </a>
      . Your edits are preserved.
    </div>
  );
}
