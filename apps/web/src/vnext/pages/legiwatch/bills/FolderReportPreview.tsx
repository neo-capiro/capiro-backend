import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput } from '../../../components/fields/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { IMPORT_BASE, folderKey, folderError } from './folder-api.js';
type Report = {
  name: string;
  asOf: string;
  fromDate: string;
  dateSemantics: string;
  expectedAssignments: number;
  complete: boolean;
  exceptions: Array<{ sourceId: string; reason: string }>;
  rows: Array<{
    id: string;
    number: string;
    title: string;
    sponsor: string | null;
    currentPublicStatus: string | null;
    folderName: string;
    sourceUrl: string | null;
    summary: string | null;
    lastActionAt: string | null;
    actions: Array<{ date: string; text: string }>;
    reportCommentObservation: string | null;
  }>;
};
export function FolderReportPreview({
  runId,
  reportId,
  onClose,
}: {
  runId: string;
  reportId: string;
  onClose: () => void;
}) {
  const api = useApi(),
    identity = useApiScope();
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const preview = useQuery({
    queryKey: [...folderKey(identity), 'report', runId, reportId, asOf],
    queryFn: async () =>
      (await api.get<Report>(`${IMPORT_BASE}/${runId}/report/${reportId}`, { params: { asOf } }))
        .data,
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(asOf),
    retry: false,
  });
  return (
    <CapiroModal open title="Saved report preview" onClose={onClose} width={960}>
      <CapiroInput
        type="date"
        label="Historical action cutoff"
        value={asOf}
        onChange={(e) => setAsOf(e.target.value)}
        helpText="Actions are shown for the cutoff date and the four preceding calendar days. The cutoff defaults to today; choose an earlier date to review a past action window."
      />
      {preview.isPending && <p role="status">Preparing preview…</p>}
      {preview.isError && (
        <div role="alert">
          <p>{folderError(preview.error)}</p>
          <CapiroButton onClick={() => void preview.refetch()}>Retry preview</CapiroButton>
        </div>
      )}
      {preview.data && (
        <article className="lw-folder-report">
          <h2>{preview.data.name}</h2>
          <p>
            Actions: {preview.data.fromDate}–{preview.data.asOf}. Current public status is shown
            separately.
          </p>
          <p>{preview.data.dateSemantics}</p>
          <p>
            {preview.data.rows.length} of {preview.data.expectedAssignments} assignments resolved.{' '}
            {preview.data.complete
              ? 'Complete selection'
              : 'Incomplete preview — unresolved source records remain'}
            .
          </p>
          <p>
            Summary included · committees and related bills off · last-action order · authenticated
            preview. Internal comments excluded.
          </p>
          <CapiroButton
            disabled={!preview.data.complete}
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(preview.data, null, 2)], { type: 'application/json' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = `legiwatch-report-${reportId}-${asOf}.json`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download preview
          </CapiroButton>
          {preview.data.exceptions.map((e) => (
            <p role="alert" key={e.sourceId}>
              {e.sourceId}: {e.reason}
            </p>
          ))}
          {preview.data.rows.map((r, index) => (
            <section key={`${r.id}-${index}`}>
              <h3>
                {r.number} · {r.title}
              </h3>
              <p>
                {r.folderName} · {r.sponsor ?? 'Sponsor unavailable'} · Current status:{' '}
                {r.currentPublicStatus ?? 'Unavailable'}
              </p>
              <p>{r.summary ?? 'Source summary unavailable'}</p>
              <p>Last action through cutoff: {r.lastActionAt ?? 'History unavailable'}</p>
              <ul>
                {r.actions.map((a, i) => (
                  <li key={i}>
                    {a.date} · {a.text}
                  </li>
                ))}
              </ul>
              {!r.actions.length && <p>No recorded actions in this five-day window.</p>}
              {r.reportCommentObservation && (
                <p>Captured report Bill Comments: {r.reportCommentObservation}</p>
              )}
              {r.sourceUrl && /^https?:\/\//.test(r.sourceUrl) && (
                <a href={r.sourceUrl} target="_blank" rel="noreferrer">
                  Original source
                </a>
              )}
            </section>
          ))}
        </article>
      )}
    </CapiroModal>
  );
}
