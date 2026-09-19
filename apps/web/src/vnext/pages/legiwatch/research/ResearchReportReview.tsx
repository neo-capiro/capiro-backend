import { useState, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSelect } from '../../../components/fields/index.js';
export function ResearchReportReview({
  selectionId,
  folderId,
}: {
  selectionId: string;
  folderId: string;
}) {
  const api = useApi(),
    identity = useApiScope(),
    [params] = useSearchParams(),
    [reportId, setReport] = useState(''),
    [preview, setPreview] = useState<any>(null),
    [status, setStatus] = useState(''),
    [runId, setRun] = useState(''),
    [busy, setBusy] = useState(false),
    baseRun = useRef('');
  const reports = useQuery({
    queryKey: ['research-report-choices', identity, folderId],
    queryFn: async () =>
      (
        await api.get<Array<{ id: string; name: string; version: number; folderIds: string[] }>>(
          '/intel-api/legiwatch/reports',
        )
      ).data,
    retry: false,
  });
  const route = new URLSearchParams(params);
  route.set('tab', 'digest');
  route.set('reportView', 'reports');
  route.set('reportRun', runId);
  return (
    <section aria-label="Include reviewed research in a report">
      <h3>Review for an internal client report</h3>
      <p>
        Finish editing the Workspace draft, then preview its exact current text in a saved report.
        Changed text requires a new review.
      </p>
      <CapiroSelect
        label="Saved report"
        value={reportId}
        options={[
          { value: '', label: 'Choose a report' },
          ...(reports.data ?? [])
            .filter((r) => r.folderIds.includes(folderId))
            .map((r) => ({ value: r.id, label: r.name })),
        ]}
        onChange={(e) => {
          setReport(e.target.value);
          setPreview(null);
          baseRun.current = '';
        }}
      />
      <CapiroButton
        disabled={!reportId || busy}
        onClick={async () => {
          setBusy(true);
          setStatus('');
          try {
            if (!baseRun.current) {
              const report = reports.data!.find((r) => r.id === reportId)!;
              baseRun.current = (
                await api.post<{ id: string }>(
                  '/intel-api/legiwatch/reports/' + encodeURIComponent(reportId) + '/generate',
                  {
                    audience: 'internal',
                    cutoff: new Date().toISOString().slice(0, 10),
                    expectedVersion: report.version,
                  },
                )
              ).data.id;
            }
            setPreview(
              (
                await api.post('/intel-api/legiwatch/research/reports/preview', {
                  selectionId,
                  runId: baseRun.current,
                })
              ).data,
            );
          } catch {
            setStatus(
              'Preview is held. Check source freshness, Workspace access and the report’s folder, client and session.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Preview exact research text
      </CapiroButton>
      {preview ? (
        <>
          <p>Internal review only. This selection does not send a report.</p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {preview.rendered.text}
          </pre>
          <CapiroButton
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setRun(
                  (
                    await api.post<{ runId: string }>(
                      '/intel-api/legiwatch/research/reports/approve',
                      { selectionId, runId: baseRun.current, approvalHash: preview.approvalHash },
                    )
                  ).data.runId,
                );
                setStatus('Reviewed research saved as a new immutable report version.');
              } catch {
                setStatus(
                  'Research or report changed. Preview and review the updated text before saving.',
                );
                setPreview(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            Approve this exact report version
          </CapiroButton>
        </>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {runId ? <Link to={'/legiwatch?' + route}>Open reviewed report</Link> : null}
    </section>
  );
}
