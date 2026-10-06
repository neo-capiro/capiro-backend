import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useApiScope } from '../../../lib/use-api-scope.js';
import './bill-impact-draft.css';

interface Version {
  id: string;
  revision: string;
  label: string;
  sourceUrl: string;
  publishedDate: string | null;
  unavailableReason: string | null;
}
interface Lifecycle {
  title: string;
  latestAction: string | null;
  actionDate: string | null;
  sourceUrl: string | null;
}
interface Options {
  client: { id: string; name: string };
  lifecycle: Lifecycle;
  contextUnavailable: string | null;
  versions: Version[];
}
interface Draft {
  client: { id: string; name: string };
  version: Version;
  lifecycle: Lifecycle;
  coverage: string;
  limitations: string;
  impacts: Array<{
    possibleImplication: string;
    assumptions: string;
    verificationStep: string;
    evidence: Array<{ id: string; locator: string; text: string }>;
    clientBasis: Array<{ id: string; label: string; text: string }>;
  }>;
}
const errorText = (error: unknown) => {
  const value = error as { response?: { data?: { message?: unknown } } };
  return typeof value?.response?.data?.message === 'string'
    ? value.response.data.message
    : 'The impact draft is unavailable. Please retry.';
};
const sourceLink = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : undefined);
const versionLabel = (label: string) =>
  (
    ({
      ih: 'Introduced in House',
      is: 'Introduced in Senate',
      eh: 'Passed House text',
      es: 'Passed Senate text',
      enr: 'Enrolled text',
      rh: 'Reported in House',
      rs: 'Reported in Senate',
      rfs: 'Referred in Senate',
      pcs: 'Placed on Senate calendar',
      pch: 'Placed on House calendar',
    }) as Record<string, string>
  )[label.toLowerCase()] ?? (/^[a-z]{1,4}$/.test(label) ? 'Published text version' : label);
const displayDate = (value: string | null) => {
  if (!value) return 'Date not stated';
  const day = value.slice(0, 10);
  const date = new Date(`${day}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== day
  )
    return 'Date not stated';
  return Number.isNaN(date.getTime())
    ? 'Date not stated'
    : date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });
};

/** Remount on authenticated scope changes, preventing in-flight results from a previous client appearing. */
export function BillImpactDraft({
  billId,
  clientId,
}: {
  billId: string;
  clientId?: string | null;
}) {
  const scope = useApiScope();
  if (!clientId) return <p>Select a client to prepare a client-specific impact draft.</p>;
  return (
    <ScopedImpactDraft
      key={JSON.stringify([scope, billId, clientId])}
      billId={billId}
      clientId={clientId}
    />
  );
}

function ScopedImpactDraft({ billId, clientId }: { billId: string; clientId: string }) {
  const api = useApi(),
    scope = useApiScope();
  const [selection, setSelection] = useState('');
  const path = `/legiwatch/bills/${encodeURIComponent(billId)}/impact`;
  const options = useQuery({
    queryKey: ['bill-impact-options', scope, billId, clientId],
    queryFn: async () => (await api.get<Options>(path, { params: { clientId } })).data,
  });
  const generate = useMutation({
    mutationFn: async (version: Version) =>
      (
        await api.post<Draft>(
          path,
          { clientId, versionId: version.id, revision: version.revision },
          { timeout: 165_000 },
        )
      ).data,
  });
  const version = options.data?.versions.find((v) => v.id === selection);
  const data = generate.data;
  return (
    <section aria-label="Client impact draft" className="b360-impact-draft">
      <h3>Client impact draft</h3>
      <p>
        Review possible implications for the selected client against one complete retained bill-text
        version. Nothing is saved or sent automatically.
      </p>
      {options.isLoading && <p role="status">Checking source text and client context…</p>}
      {options.isError && <p role="alert">{errorText(options.error)}</p>}
      {options.data && (
        <>
          <p>
            <strong>{options.data.client.name}</strong>
          </p>
          <p>
            Latest recorded action: {options.data.lifecycle.latestAction ?? 'Not available'} (
            {displayDate(options.data.lifecycle.actionDate)}).{' '}
            {sourceLink(options.data.lifecycle.sourceUrl) && (
              <a
                href={sourceLink(options.data.lifecycle.sourceUrl)}
                target="_blank"
                rel="noreferrer"
              >
                Official bill record
              </a>
            )}
          </p>
          {options.data.contextUnavailable && (
            <p role="status">{options.data.contextUnavailable}</p>
          )}
          {!options.data.versions.length ? (
            <p>
              No retained text versions are available. Published document links alone are not enough
              to generate an impact draft.
            </p>
          ) : (
            <>
              <label>
                Bill-text version
                <select
                  value={selection}
                  disabled={generate.isPending}
                  onChange={(e) => {
                    setSelection(e.target.value);
                    generate.reset();
                  }}
                >
                  <option value="">Choose an exact version</option>
                  {options.data.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {versionLabel(v.label)} · {displayDate(v.publishedDate)}
                      {v.unavailableReason ? ' · unavailable' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {version && (
                <p>
                  {sourceLink(version.sourceUrl) && (
                    <a href={sourceLink(version.sourceUrl)} target="_blank" rel="noreferrer">
                      Read selected source
                    </a>
                  )}
                  {version.unavailableReason && <> — {version.unavailableReason}</>}
                </p>
              )}
              <button
                type="button"
                className="lw-btn lw-btn--primary"
                disabled={
                  !version ||
                  Boolean(version.unavailableReason || options.data.contextUnavailable) ||
                  generate.isPending
                }
                onClick={() => version && generate.mutate(version)}
              >
                {generate.isPending ? 'Preparing impact draft…' : 'Generate impact draft'}
              </button>
            </>
          )}
        </>
      )}
      {generate.isError && <p role="alert">{errorText(generate.error)}</p>}
      {data && (
        <div aria-label="Impact draft for review">
          <h4>Draft for review — {data.client.name}</h4>
          {!data.impacts.length && (
            <p>
              No supported client-specific implication was identified in the selected text. This is
              not proof of no impact; review the source and client context.
            </p>
          )}
          <p>
            {data.coverage} Potential implications below are analysis, not verified legal or
            financial outcomes.
          </p>
          <p>
            Selected version: {versionLabel(data.version.label)} ·{' '}
            {displayDate(data.version.publishedDate)}. Revision:{' '}
            <code>{data.version.revision}</code>
          </p>
          {data.impacts.map((item, i) => (
            <article key={i}>
              <h4>Possible implication {i + 1}</h4>
              <p>{item.possibleImplication}</p>
              <p>
                <strong>Assumptions to verify:</strong> {item.assumptions}
              </p>
              <p>
                <strong>Suggested review step:</strong> {item.verificationStep}
              </p>
              <details>
                <summary>Bill evidence and client basis</summary>
                {item.evidence.map((e) => (
                  <div key={e.id}>
                    <p>
                      {e.locator} ·{' '}
                      <a href={sourceLink(data.version.sourceUrl)} target="_blank" rel="noreferrer">
                        Selected bill text
                      </a>
                    </p>
                    <blockquote style={{ whiteSpace: 'pre-wrap' }}>{e.text}</blockquote>
                  </div>
                ))}
                {item.clientBasis.map((c) => (
                  <p key={c.id}>
                    <strong>{c.label}:</strong> {c.text}
                  </p>
                ))}
              </details>
            </article>
          ))}
          <h4>Limits of this draft</h4>
          <p>{data.limitations}</p>
        </div>
      )}
    </section>
  );
}
