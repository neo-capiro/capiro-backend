import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSelect } from '../../../components/fields/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { IMPORT_BASE, folderKey, folderError } from './folder-api.js';
import { FolderReportPreview } from './FolderReportPreview.js';

interface ImportRun {
  status: string;
  id: string;
  tenantId: string;
  sourceAccount: string;
  captureId: string;
  mappingHash: string;
  createdAt: string;
}
interface Reconciliation {
  run: ImportRun;
  counts: Array<{ kind: string; status: string; _count: { _all: number } }>;
  items: Array<{
    id: string;
    kind: string;
    sourceId: string;
    status: string;
    reason: string | null;
  }>;
  nextOffset: number | null;
}
export function FolderImportReview({ onClose }: { onClose: () => void }) {
  const api = useApi(),
    identity = useApiScope();
  const [runId, setRunId] = useState(''),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [details, setDetails] = useState<unknown>(null),
    [reportId, setReportId] = useState('');
  const runs = useQuery({
    queryKey: [...folderKey(identity), 'imports'],
    queryFn: async () => (await api.get<ImportRun[]>(IMPORT_BASE)).data,
    retry: false,
  });
  const id = runId || runs.data?.[0]?.id;
  const review = useQuery({
    queryKey: [...folderKey(identity), 'import', id, offset],
    queryFn: async () =>
      (await api.get<Reconciliation>(`${IMPORT_BASE}/${id}`, { params: { offset } })).data,
    enabled: Boolean(id),
    retry: false,
  });
  const reportItems =
    review.data?.items.filter((i) => i.kind === 'report' && i.status !== 'excluded') ?? [];
  const singleReport = reportItems.length === 1 ? reportItems[0] : null;
  const reportCount = review.data?.counts
    .filter((c) => c.kind === 'report')
    .reduce((sum, c) => sum + c._count._all, 0);
  const activeReportCount = review.data?.counts
    .filter((c) => c.kind === 'report' && c.status !== 'excluded')
    .reduce((sum, c) => sum + c._count._all, 0);
  const runsErrorStatus = (runs.error as { response?: { status?: number } } | null)?.response
    ?.status;
  return (
    <CapiroModal open title="Import review" onClose={onClose} width={960}>
      {review.data && (
        <CapiroButton
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post(
                `${IMPORT_BASE}/${id}/${review.data.run.status === 'paused' ? 'resume' : 'pause'}`,
                {},
              );
              await review.refetch();
            } catch (e) {
              setError(folderError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {review.data.run.status === 'paused' ? 'Resume import' : 'Pause import'}
        </CapiroButton>
      )}
      <p>
        Review captured records and their mapping outcomes. Alerts, report delivery and user
        provisioning remain paused.
      </p>
      {id && (
        <div className="lw-folder-actions">
          <CapiroButton
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const items: Reconciliation['items'] = [];
                let next: number | null = 0;
                do {
                  const page: Reconciliation = (
                    await api.get<Reconciliation>(`${IMPORT_BASE}/${id}`, {
                      params: { offset: next },
                    })
                  ).data;
                  items.push(...page.items);
                  next = page.nextOffset;
                } while (next !== null);
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      JSON.stringify(
                        { run: review.data?.run, counts: review.data?.counts, items },
                        null,
                        2,
                      ),
                    ],
                    { type: 'application/json' },
                  ),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = 'legiwatch-import-reconciliation.json';
                link.click();
                URL.revokeObjectURL(url);
              } catch (e) {
                setError(folderError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Download reconciliation
          </CapiroButton>
        </div>
      )}
      {review.data && singleReport && (
        <div className="lw-folder-actions">
          <CapiroButton onClick={() => setReportId(singleReport.sourceId)}>
            Preview captured report {singleReport.sourceId}
          </CapiroButton>
        </div>
      )}
      {review.data && reportItems.length > 1 && (
        <CapiroSelect
          label="Preview captured report"
          value=""
          options={[
            { value: '', label: 'Choose a captured report' },
            ...reportItems.map((item) => ({
              value: item.sourceId,
              label: `Report ${item.sourceId}`,
            })),
          ]}
          onChange={(e) => {
            if (e.target.value) setReportId(e.target.value);
          }}
        />
      )}
      {review.data && !reportItems.length && reportCount === 0 && (
        <p>No captured report records in this import run.</p>
      )}
      {review.data && !reportItems.length && reportCount !== 0 && activeReportCount === 0 && (
        <p>Captured report records in this run are excluded and cannot be previewed.</p>
      )}
      {review.data && !reportItems.length && activeReportCount !== 0 && (
        <p>
          Captured report records are outside this page of results. Page through the items to
          reach them.
        </p>
      )}
      {runs.isPending ? (
        <p role="status">Loading import runs…</p>
      ) : runs.isError ? (
        <div role="alert">
          <p>
            {runsErrorStatus === 401
              ? 'Your session has expired. Sign in again, then retry import review.'
              : runsErrorStatus === 403
                ? 'Import review requires a verified tenant administrator. If you are an administrator, refresh your session and ask your tenant administrator to verify your current membership.'
                : 'Import runs could not be loaded. Retry to check the service again.'}
          </p>
          <CapiroButton onClick={() => void runs.refetch()}>Retry import review</CapiroButton>
        </div>
      ) : !runs.data?.length ? (
        <p>
          No import runs are available. Prepare an evidence package and explicit tenant mapping
          manifest to preview a run.
        </p>
      ) : (
        <CapiroSelect
          label="Import run"
          value={id}
          options={runs.data.map((r) => ({
            value: r.id,
            label: `${r.sourceAccount} · ${r.captureId} · ${r.createdAt.slice(0, 10)}`,
          }))}
          onChange={(e) => {
            setRunId(e.target.value);
            setOffset(0);
            setSelected([]);
            setDetails(null);
            setReportId('');
            setError('');
          }}
        />
      )}
      {review.data && (
        <>
          <div className="lw-folder-message">
            {review.data.counts.map((c) => (
              <span key={`${c.kind}-${c.status}`}>
                {c.kind}: {c._count._all} {c.status} ·{' '}
              </span>
            ))}
          </div>
          <ul className="lw-folder-resolution">
            {review.data.items.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    disabled={!['ready', 'retry'].includes(item.status)}
                    checked={selected.includes(item.id)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, item.id] : prev.filter((i) => i !== item.id),
                      )
                    }
                  />
                  {item.kind} {item.sourceId} · {item.status}
                  {item.reason ? ` · ${item.reason.replaceAll('_', ' ').toLowerCase()}` : ''}
                </label>
              </li>
            ))}
          </ul>
          <div className="lw-folder-actions">
            <CapiroButton
              disabled={!offset}
              onClick={() => {
                setOffset(Math.max(0, offset - 100));
                setSelected([]);
              }}
            >
              Previous items
            </CapiroButton>
            <CapiroButton
              disabled={review.data.nextOffset === null}
              onClick={() => {
                setOffset(review.data.nextOffset!);
                setSelected([]);
              }}
            >
              Next items
            </CapiroButton>
            <CapiroButton
              variant="primary"
              loading={busy}
              disabled={!selected.length || review.data.run.status === 'paused'}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await api.post(`${IMPORT_BASE}/${id}/apply`, {
                    targetTenantId: review.data.run.tenantId,
                    mappingHash: review.data.run.mappingHash,
                    itemIds: selected,
                  });
                  setSelected([]);
                  await review.refetch();
                } catch (e) {
                  setError(folderError(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Apply {selected.length} selected records
            </CapiroButton>
          </div>
        </>
      )}
      {review.isError && (
        <div role="alert">
          <p>Import results could not be loaded.</p>
          <CapiroButton onClick={() => void review.refetch()}>Retry import results</CapiroButton>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {review.data && (
        <details>
          <summary>Mapping and source details</summary>
          <p>
            Run target: {review.data.run.tenantId}. Unprovisioned owners remain blocked. Update the
            private mapping manifest and preview again to create a traceable review run.
          </p>
          <CapiroSelect
            label="Inspect record"
            value=""
            options={[
              { value: '', label: 'Choose a record' },
              ...review.data.items.map((i) => ({ value: i.id, label: `${i.kind} ${i.sourceId}` })),
            ]}
            onChange={async (e) => {
              if (e.target.value) {
                try {
                  setDetails((await api.get(`${IMPORT_BASE}/${id}/items/${e.target.value}`)).data);
                } catch (err) {
                  setError(folderError(err));
                }
              }
            }}
          />
          {details !== null && (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                maxHeight: 300,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(details, null, 2)}
            </pre>
          )}
        </details>
      )}
      {id && reportId && (
        <FolderReportPreview runId={id} reportId={reportId} onClose={() => setReportId('')} />
      )}
    </CapiroModal>
  );
}
