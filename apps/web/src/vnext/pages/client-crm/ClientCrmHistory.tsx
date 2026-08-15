import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Relationships / Relationship history — Figma `906:3360`.
 *
 * The timeline is served by `/api/clients/:id/activity`, which unions recorded
 * CRM activity with meetings, attachments and outreach. Nothing here is
 * fabricated in frontend state, and every row keeps enough source identity to
 * open the record it describes.
 */

const KINDS = [
  'email',
  'call',
  'note',
  'meeting',
  'outreach',
  'document',
  'request',
  'decision',
  'commitment',
] as const;
export type Kind = (typeof KINDS)[number];

/** Kinds a user can log by hand; the rest are written by their own feature. */
const RECORDABLE: Kind[] = ['note', 'call', 'email', 'request', 'decision', 'commitment'];

export interface ActivityItem {
  id: string;
  kind: Kind;
  occurredAt: string;
  title: string;
  body: string | null;
  personId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  pinned: boolean;
  dueAt: string | null;
  settledAt: string | null;
  origin: 'recorded' | 'derived';
}

const KIND_TONE: Record<Kind, 'neutral' | 'info' | 'warning' | 'success'> = {
  email: 'neutral',
  call: 'neutral',
  note: 'neutral',
  meeting: 'info',
  outreach: 'info',
  document: 'neutral',
  request: 'warning',
  decision: 'success',
  commitment: 'warning',
};

export function ClientCrmHistory({ client }: { client: Client }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Set<Kind>>(new Set());
  const [adding, setAdding] = useState(false);

  const activity = useQuery<ActivityItem[]>({
    queryKey: ['client-activity', client.id],
    queryFn: async () =>
      (await api.get<ActivityItem[]>(`/api/clients/${client.id}/activity`, { params: { limit: 200 } }))
        .data,
  });

  const mutate = useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      (await api.patch(`/api/clients/${client.id}/activity/${id}`, body)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['client-activity', client.id] }),
  });

  const create = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await api.post(`/api/clients/${client.id}/activity`, body)).data,
    onSuccess: () => {
      setAdding(false);
      void qc.invalidateQueries({ queryKey: ['client-activity', client.id] });
    },
  });

  const all = activity.data ?? [];
  const shown = useMemo(
    () => (filters.size === 0 ? all : all.filter((item) => filters.has(item.kind))),
    [all, filters],
  );
  const pinned = useMemo(() => all.filter((item) => item.pinned), [all]);
  const openCommitments = useMemo(
    () => all.filter((item) => item.dueAt && !item.settledAt),
    [all],
  );

  const toggleFilter = (kind: Kind) =>
    setFilters((previous) => {
      const next = new Set(previous);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const open = (item: ActivityItem) => {
    // Every derived row can reach its source record.
    if (item.sourceType === 'meeting') navigate(`/engagement/meetings/${item.sourceId}`);
    else if (item.sourceType === 'attachment') {
      navigate(`/clients?clientId=${client.id}&tab=files`);
    } else if (item.sourceType === 'outreach') navigate(`/outreach/${item.sourceId}`);
  };

  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__page-head">
        <div>
          <h2 className="capiro-crm__page-title">Relationship history</h2>
          <p className="capiro-crm__page-sub">
            Every interaction with this client, newest first — meetings, mail, documents and
            outreach alongside what your team logged by hand.
          </p>
        </div>
        <span className="capiro-crm__page-head-spacer" />
        <CapiroButton variant="primary" size="compact" onClick={() => setAdding(true)}>
          Log activity
        </CapiroButton>
      </div>

      <div className="capiro-crm__grid capiro-crm__grid--history">
        <section className="capiro-crm__card capiro-elevation-widget" aria-labelledby="crm-hist">
          <div className="capiro-crm__card-head">
            <h3 className="capiro-crm__card-title" id="crm-hist">
              Timeline
            </h3>
            <span className="capiro-crm__page-head-spacer" />
            <span className="capiro-crm__meta">
              {shown.length} of {all.length}
            </span>
          </div>

          <div className="capiro-crm__filters" role="group" aria-label="Filter by kind">
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`capiro-crm__pill capiro-crm__pill--action${filters.has(kind) ? ' capiro-crm__pill--filled' : ''}`}
                aria-pressed={filters.has(kind)}
                onClick={() => toggleFilter(kind)}
              >
                {kind}
              </button>
            ))}
            {filters.size > 0 ? (
              <CapiroButton variant="quiet" size="compact" onClick={() => setFilters(new Set())}>
                Clear
              </CapiroButton>
            ) : null}
          </div>

          {activity.isLoading ? (
            <div className="capiro-crm__skeleton" style={{ height: 320 }} aria-hidden />
          ) : activity.isError ? (
            <div className="capiro-crm__state capiro-crm__state--error" role="status">
              <span>
                {activity.error instanceof Error ? activity.error.message : 'Could not load history'}
              </span>
              <CapiroButton variant="quiet" size="compact" onClick={() => void activity.refetch()}>
                Retry
              </CapiroButton>
            </div>
          ) : shown.length === 0 ? (
            <div className="capiro-crm__state" role="status">
              {/* Filtered-empty and truly-empty are different facts. */}
              {all.length === 0
                ? 'No activity recorded for this client yet.'
                : 'No activity matches these filters.'}
            </div>
          ) : (
            <ol className="capiro-crm__timeline">
              {shown.map((item) => (
                <li key={item.id} className="capiro-crm__event">
                  <span className={`capiro-crm__event-rail capiro-crm__event-rail--${item.kind}`} aria-hidden />
                  <div className="capiro-crm__event-body">
                    <div className="capiro-crm__event-head">
                      <CapiroBadge tone={KIND_TONE[item.kind]}>{item.kind.toUpperCase()}</CapiroBadge>
                      <span className="capiro-crm__meta">{formatWhen(item.occurredAt)}</span>
                      {item.dueAt ? (
                        <span className="capiro-crm__meta">
                          {item.settledAt ? 'settled' : `due ${formatWhen(item.dueAt)}`}
                        </span>
                      ) : null}
                      <span className="capiro-crm__page-head-spacer" />
                      {item.origin === 'recorded' ? (
                        <button
                          type="button"
                          className="capiro-crm__card-action"
                          aria-pressed={item.pinned}
                          onClick={() => mutate.mutate({ id: item.id, pinned: !item.pinned })}
                        >
                          {item.pinned ? 'Unpin' : 'Pin'}
                        </button>
                      ) : null}
                      {item.dueAt && !item.settledAt ? (
                        <button
                          type="button"
                          className="capiro-crm__card-action"
                          onClick={() => mutate.mutate({ id: item.id, settled: true })}
                        >
                          Settle
                        </button>
                      ) : null}
                      {item.sourceId ? (
                        <button
                          type="button"
                          className="capiro-crm__card-action"
                          onClick={() => open(item)}
                        >
                          Open
                        </button>
                      ) : null}
                    </div>
                    <p className="capiro-crm__event-title">{item.title}</p>
                    {item.body ? <p className="capiro-crm__foot">{item.body}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className="capiro-crm__rail">
          <section className="capiro-crm__card capiro-elevation-widget">
            <div className="capiro-crm__card-head">
              <h3 className="capiro-crm__card-title">Pinned</h3>
            </div>
            {pinned.length === 0 ? (
              <p className="capiro-crm__foot">Pin a note to keep it here across reloads.</p>
            ) : (
              <ul className="capiro-crm__rows">
                {pinned.map((item) => (
                  <li key={item.id} className="capiro-crm__pinned">
                    <span className="capiro-crm__row-title">{item.title}</span>
                    <span className="capiro-crm__meta capiro-crm__row-meta">
                      {item.kind} · {formatWhen(item.occurredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="capiro-crm__card capiro-elevation-widget">
            <div className="capiro-crm__card-head">
              <h3 className="capiro-crm__card-title">Open commitments</h3>
            </div>
            {openCommitments.length === 0 ? (
              <p className="capiro-crm__foot">Nothing outstanding.</p>
            ) : (
              <ul className="capiro-crm__rows">
                {openCommitments.map((item) => (
                  <li key={item.id} className="capiro-crm__pinned">
                    <span className="capiro-crm__row-title">{item.title}</span>
                    <span className="capiro-crm__meta capiro-crm__row-meta">
                      due {item.dueAt ? formatWhen(item.dueAt) : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {adding ? (
        <LogActivityModal
          onClose={() => setAdding(false)}
          onSubmit={(values) => create.mutate(values)}
          pending={create.isPending}
          error={create.error}
        />
      ) : null}
    </div>
  );
}

export function LogActivityModal({
  onClose,
  onSubmit,
  pending,
  error,
  initialKind,
}: {
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
  pending: boolean;
  error: unknown;
  /** Preselected kind — the prototype quick-add rows open the modal pre-set. */
  initialKind?: Kind;
}) {
  const [kind, setKind] = useState<Kind>(initialKind ?? 'note');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueAt, setDueAt] = useState('');

  const carriesDue = kind === 'commitment' || kind === 'request';

  return (
    <CapiroModal open title="Log activity" onClose={onClose}>
      <div className="capiro-crm-form">
        <label className="capiro-crm-form__field">
          <span className="capiro-crm__meta">Kind</span>
          <select
            className="capiro-crm-form__input"
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
          >
            {RECORDABLE.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="capiro-crm-form__field">
          <span className="capiro-crm__meta">Summary *</span>
          <input
            className="capiro-crm-form__input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="capiro-crm-form__field">
          <span className="capiro-crm__meta">Detail</span>
          <textarea
            className="capiro-crm-form__input"
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        {carriesDue ? (
          <label className="capiro-crm-form__field">
            <span className="capiro-crm__meta">Due</span>
            <input
              type="date"
              className="capiro-crm-form__input"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </label>
        ) : null}

        {error ? (
          <p className="capiro-crm__foot capiro-crm__state--error">
            {error instanceof Error ? error.message : 'Could not log that activity'}
          </p>
        ) : null}

        <div className="capiro-crm-fill__actions">
          <CapiroButton
            variant="primary"
            size="compact"
            loading={pending}
            disabled={!title.trim()}
            onClick={() =>
              onSubmit({
                kind,
                title: title.trim(),
                ...(body.trim() ? { body: body.trim() } : {}),
                ...(carriesDue && dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
              })
            }
          >
            Log it
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={onClose}>
            Cancel
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}
