import { useQueries } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Data health — Figma `907:3464`.
 *
 * One place to see whether each source behind this client is actually
 * answering. Every row reports one of three states, and they are deliberately
 * distinct:
 *
 *   OK          the source answered and returned records
 *   EMPTY       the source answered and has nothing — a real, trustworthy zero
 *   UNAVAILABLE the source failed, which is NOT zero and never renders as one
 *
 * That distinction is the product-wide invariant both the Program Elements and
 * LegiWatch handoff frames state independently.
 */
export function ClientDataHealthDrawer({
  client,
  onClose,
}: {
  client: Client;
  onClose: () => void;
}) {
  const api = useApi();

  const sources = [
    {
      key: 'people',
      label: 'Contacts',
      queryKey: ['client-people', client.id],
      path: `/api/clients/${client.id}/people`,
    },
    {
      key: 'capabilities',
      label: 'Capabilities',
      queryKey: ['client-capabilities', client.id],
      path: `/api/clients/${client.id}/capabilities`,
    },
    {
      key: 'facilities',
      label: 'Facilities',
      queryKey: ['client-facilities', client.id],
      path: `/api/clients/${client.id}/facilities`,
    },
    {
      key: 'files',
      label: 'Files',
      queryKey: ['client-attachments', client.id],
      path: '/api/engagement/attachments',
      params: { clientId: client.id },
    },
    {
      key: 'activity',
      label: 'Relationship history',
      queryKey: ['client-activity', client.id],
      path: `/api/clients/${client.id}/activity`,
    },
    {
      key: 'kb',
      label: 'Knowledge base index',
      queryKey: ['client-kb-status', client.id],
      path: `/api/clio/kb/${client.id}/status`,
    },
  ] as const;

  const results = useQueries({
    queries: sources.map((source) => ({
      queryKey: source.queryKey,
      queryFn: async () =>
        (
          await api.get<unknown>(source.path, {
            ...(('params' in source ? { params: source.params } : {}) as Record<string, unknown>),
          })
        ).data,
      retry: false,
      staleTime: 60_000,
    })),
  });

  const failures = results.filter((result) => result.isError).length;

  return (
    <CapiroDrawer open title={`Data health — ${client.name}`} onClose={onClose}>
      <div className="capiro-crm-form">
        <p className="capiro-crm__foot">
          {failures === 0
            ? 'Every source behind this client answered.'
            : `${failures} source${failures === 1 ? '' : 's'} could not be read. Counts elsewhere in this profile show a dash rather than a zero for those.`}
        </p>

        <ul className="capiro-crm__rows">
          {sources.map((source, index) => {
            const result = results[index];
            const state = !result || result.isLoading
              ? 'loading'
              : result.isError
                ? 'unavailable'
                : countOf(result.data) === 0
                  ? 'empty'
                  : 'ok';
            return (
              <li key={source.key} className="capiro-crm__review-row">
                <span className="capiro-crm__row-main">
                  <span className="capiro-crm__row-title">{source.label}</span>
                  <span className="capiro-crm__meta capiro-crm__row-meta">
                    {state === 'loading'
                      ? 'Checking…'
                      : state === 'unavailable'
                        ? // Names the failure instead of implying zero records.
                          (result?.error instanceof Error
                            ? result.error.message
                            : 'The source did not answer')
                        : state === 'empty'
                          ? 'Answered · no records yet'
                          : `${countOf(result?.data)} record${countOf(result?.data) === 1 ? '' : 's'}`}
                  </span>
                </span>
                <CapiroBadge
                  tone={
                    state === 'unavailable' ? 'danger' : state === 'empty' ? 'warning' : 'success'
                  }
                >
                  {state === 'loading' ? 'CHECKING' : state.toUpperCase()}
                </CapiroBadge>
              </li>
            );
          })}
        </ul>

        <div className="capiro-crm-fill__actions">
          <CapiroButton
            variant="secondary"
            size="compact"
            onClick={() => results.forEach((result) => void result.refetch())}
          >
            Re-check all
          </CapiroButton>
          <CapiroButton variant="quiet" size="compact" onClick={onClose}>
            Close
          </CapiroButton>
        </div>
      </div>
    </CapiroDrawer>
  );
}

/** Records in a payload, whatever shape the source returns. */
function countOf(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data.length;
    if (record.counts && typeof record.counts === 'object') {
      return Object.values(record.counts as Record<string, number>).reduce(
        (sum, value) => sum + (value ?? 0),
        0,
      );
    }
  }
  return 0;
}
