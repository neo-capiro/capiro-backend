import { useCallback, useEffect, useState } from 'react';
import { config } from '../../env.js';
import { readMeriJob, type MeriJobView } from '../../components/chat/meri-research-recovery.js';
import {
  isMeriDeliverableFormat,
  MERI_DELIVERABLE_LABEL,
  type MeriDeliverableFormat,
} from '../../components/chat/meri-deliverable-format.js';

type RowState = {
  busy?: 'download' | 'file';
  filedLocation?: string;
  notice?: string;
  error?: string;
};

function fileNameFrom(disposition: string | null, fallback: string): string {
  const encoded = disposition && /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // fall through to the plain name
    }
  }
  return fallback;
}

/**
 * Stage 2 deliverable job card. The Word, Excel or PowerPoint file is rendered
 * by the API from the job's authorized report on every request, and filing
 * into the client's Files happens only on this explicit confirmation (once per
 * deliverable).
 */
export function MeriJobDeliverables({
  researchId,
  authHeaders,
  refreshKey,
}: {
  researchId: string | null;
  authHeaders: () => Promise<Record<string, string>>;
  /** Changes when the run moves (e.g. its status), so a completed job is re-read. */
  refreshKey: string;
}) {
  const [job, setJob] = useState<MeriJobView | null>(null);
  const [rows, setRows] = useState<Record<number, RowState>>({});

  useEffect(() => {
    setRows({});
    if (!researchId) {
      setJob(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `${config.apiBaseUrl}/api/clio/research/${encodeURIComponent(researchId)}`,
          { headers: await authHeaders() },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { job?: unknown };
        if (!cancelled) setJob(readMeriJob(body.job));
      } catch {
        if (!cancelled) setJob(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [researchId, authHeaders, refreshKey]);

  const update = (index: number, next: RowState) =>
    setRows((previous) => ({ ...previous, [index]: { ...previous[index], ...next } }));

  const download = useCallback(
    async (index: number, title: string, format: MeriDeliverableFormat) => {
      if (!researchId) return;
      update(index, { busy: 'download', error: undefined });
      try {
        const response = await fetch(
          `${config.apiBaseUrl}/api/clio/research/${encodeURIComponent(researchId)}/deliverables/${index}/${format}`,
          { headers: await authHeaders() },
        );
        if (!response.ok)
          throw new Error(
            response.status === 409 || response.status === 400
              ? 'The document is not available while the report is held or its sources changed.'
              : `Download failed (HTTP ${response.status}).`,
          );
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileNameFrom(
          response.headers.get('Content-Disposition'),
          `${title}.${format}`,
        );
        anchor.click();
        URL.revokeObjectURL(url);
        update(index, { busy: undefined });
      } catch (error) {
        update(index, {
          busy: undefined,
          error: error instanceof Error ? error.message : 'Download failed.',
        });
      }
    },
    [researchId, authHeaders],
  );

  const file = useCallback(
    async (index: number) => {
      if (!researchId) return;
      update(index, { busy: 'file', error: undefined });
      try {
        const response = await fetch(
          `${config.apiBaseUrl}/api/clio/research/${encodeURIComponent(researchId)}/deliverables/${index}/file`,
          { method: 'POST', headers: await authHeaders() },
        );
        if (!response.ok)
          throw new Error(
            response.status === 403
              ? 'Filing is not enabled for this workspace.'
              : `Filing failed (HTTP ${response.status}).`,
          );
        const receipt = (await response.json()) as {
          status?: string;
          location?: string;
          message?: string;
        };
        update(index, {
          busy: undefined,
          ...(receipt.location ? { filedLocation: receipt.location } : {}),
          ...(receipt.status === 'failed'
            ? { error: receipt.message ?? 'The document could not be filed.' }
            : receipt.message
              ? { notice: receipt.message }
              : {}),
        });
      } catch (error) {
        update(index, {
          busy: undefined,
          error: error instanceof Error ? error.message : 'Filing failed.',
        });
      }
    },
    [researchId, authHeaders],
  );

  if (!job || job.kind !== 'deliverable' || job.status !== 'completed' || !job.deliverables.length)
    return null;

  return (
    <section className="vnext-meri__job-deliverables" aria-label="Job deliverables">
      <span className="vnext-meri__durable-kicker">DELIVERABLE</span>
      <ul>
        {job.deliverables.map((deliverable, index) => {
          // Only Office files are rendered; any other recorded format has no download.
          const format = deliverable.format;
          if (!isMeriDeliverableFormat(format)) return null;
          const row = rows[index] ?? {};
          const filed = Boolean(row.filedLocation) || Boolean(deliverable.artifactId);
          return (
            <li key={`${format}:${index}`} data-meri-deliverable={index}>
              <span className="vnext-meri__job-deliverable-title">
                {deliverable.title} <small>({MERI_DELIVERABLE_LABEL[format]})</small>
              </span>
              <div className="vnext-meri__durable-actions">
                <button
                  type="button"
                  className="vnext-meri__durable-send"
                  disabled={Boolean(row.busy)}
                  onClick={() => void download(index, deliverable.title, format)}
                >
                  {row.busy === 'download' ? 'Preparing…' : 'Download'}
                </button>
                {row.filedLocation ? (
                  <a className="vnext-meri__durable-send" href={row.filedLocation}>
                    Open in client Files
                  </a>
                ) : (
                  <button
                    type="button"
                    className="vnext-meri__durable-send"
                    disabled={Boolean(row.busy)}
                    onClick={() => void file(index)}
                  >
                    {row.busy === 'file'
                      ? 'Filing…'
                      : filed
                        ? 'Filed — open in client Files'
                        : 'File to client folder'}
                  </button>
                )}
              </div>
              {row.notice ? <p role="status">{row.notice}</p> : null}
              {row.error ? (
                <p className="vnext-meri__durable-error" role="alert">
                  {row.error}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
