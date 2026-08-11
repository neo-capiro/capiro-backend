import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import type { StrategyDetail, StrategyListItem, StrategyNode } from '../../../pages/strategy/types.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Work — Figma `906:3645`, plus the Strategy detail drawer `907:3246`.
 *
 * §10 is the hardest constraint on this screen: **Strategies is the source of
 * truth and there must be NO parallel CRM task model.** So every row here is a
 * Strategy or a Strategy node read through the SAME query keys the Strategies
 * module uses (`['strategy','strategies']`, `['strategy','strategy',id]`).
 * Nothing is copied into a CRM-shaped record, which is why an edit made in
 * Strategies shows up here and vice versa: they are one cache entry.
 */
export function ClientCrmWork({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();
  const [open, setOpen] = useState<StrategyDetail | null>(null);

  const list = useQuery<StrategyListItem[]>({
    queryKey: ['strategy', 'strategies'],
    queryFn: async () => (await api.get<StrategyListItem[]>('/strategy-api/strategies')).data,
    staleTime: 30_000,
  });

  const mine = useMemo(
    () => (list.data ?? []).filter((entry) => entry.clientId === client.id),
    [list.data, client.id],
  );

  const details = useQueries({
    queries: mine.map((entry) => ({
      queryKey: ['strategy', 'strategy', entry.id],
      queryFn: async () =>
        (await api.get<StrategyDetail>(`/strategy-api/strategies/${entry.id}`)).data,
      staleTime: 30_000,
    })),
  });

  const loaded = details
    .map((query) => query.data)
    .filter((detail): detail is StrategyDetail => Boolean(detail));

  const nodes = loaded.flatMap((detail) => detail.nodes);
  const committed = nodes.filter((node) => node.status !== 'draft' && node.status !== 'suggested');
  const next30 = committed.filter((node) => withinDays(node.endsOn ?? node.startsOn, 30));
  const risks = committed.filter((node) => node.kind === 'risk');
  const milestones = committed.filter((node) => node.kind === 'milestone');

  const loading = list.isLoading || details.some((query) => query.isLoading);
  const failed = list.isError || details.some((query) => query.isError);

  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__page-head">
        <div>
          <h2 className="capiro-crm__page-title">Work</h2>
          <p className="capiro-crm__page-sub">
            Live plan steps for this client. Strategies owns these records — changes here and in
            Strategies are the same records.
          </p>
        </div>
        <span className="capiro-crm__page-head-spacer" />
        <CapiroButton variant="secondary" size="compact" onClick={() => navigate('/strategies')}>
          Open Strategies
        </CapiroButton>
      </div>

      {loading ? (
        <div className="capiro-crm__grid">
          <div className="capiro-crm__skeleton" style={{ height: 240, borderRadius: 12 }} aria-hidden />
        </div>
      ) : failed ? (
        <div className="capiro-crm__grid">
          <section className="capiro-crm__card capiro-elevation-widget">
            <div className="capiro-crm__state capiro-crm__state--error" role="status">
              <span>The Strategies service could not be reached.</span>
              <CapiroButton variant="quiet" size="compact" onClick={() => void list.refetch()}>
                Retry
              </CapiroButton>
            </div>
          </section>
        </div>
      ) : mine.length === 0 ? (
        <div className="capiro-crm__grid">
          <section className="capiro-crm__card capiro-elevation-widget">
            <div className="capiro-crm__state" role="status">
              No strategies reference this client yet.
            </div>
            <CapiroButton variant="primary" size="compact" onClick={() => navigate('/strategies')}>
              Create one in Strategies
            </CapiroButton>
          </section>
        </div>
      ) : (
        <>
          <div className="capiro-crm__grid capiro-crm__grid--history">
            <section className="capiro-crm__card capiro-elevation-widget" aria-labelledby="crm-work">
              <div className="capiro-crm__card-head">
                <h3 className="capiro-crm__card-title" id="crm-work">
                  Current strategies
                </h3>
                <span className="capiro-crm__page-head-spacer" />
                <span className="capiro-crm__meta">{mine.length}</span>
              </div>
              <ul className="capiro-crm__rows">
                {loaded.map((detail) => (
                  <li key={detail.id}>
                    <button type="button" className="capiro-crm__row" onClick={() => setOpen(detail)}>
                      <span className="capiro-crm__row-main">
                        <span className="capiro-crm__row-title">{detail.title}</span>
                        <span className="capiro-crm__meta capiro-crm__row-meta">
                          {detail.type} · {detail.nodes.length} steps
                          {detail.targetDate ? ` · target ${formatDate(detail.targetDate)}` : ''}
                        </span>
                      </span>
                      <span className="capiro-crm__row-side">
                        {detail.archivedAt ? <CapiroBadge>ARCHIVED</CapiroBadge> : null}
                        {detail.nodes.some((node) => node.kind === 'risk') ? (
                          <CapiroBadge tone="warning">RISK</CapiroBadge>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <div className="capiro-crm__rail">
              <section className="capiro-crm__card capiro-elevation-widget capiro-crm__card--pulse">
                <div className="capiro-crm__card-head">
                  <h3 className="capiro-crm__card-title">Next 30 days</h3>
                </div>
                {next30.length === 0 ? (
                  <p className="capiro-crm__foot">Nothing scheduled in the next 30 days.</p>
                ) : (
                  <ul className="capiro-crm__rows">
                    {next30.slice(0, 6).map((node) => (
                      <li key={node.id} className="capiro-crm__pinned">
                        <span className="capiro-crm__row-title">{node.title}</span>
                        <span className="capiro-crm__meta capiro-crm__row-meta">
                          {node.kind} · {formatDate(node.endsOn ?? node.startsOn)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="capiro-crm__card capiro-elevation-widget">
                <div className="capiro-crm__card-head">
                  <h3 className="capiro-crm__card-title">Open risk</h3>
                </div>
                {risks.length === 0 ? (
                  <p className="capiro-crm__foot">No risk steps recorded.</p>
                ) : (
                  <ul className="capiro-crm__rows">
                    {risks.slice(0, 6).map((node) => (
                      <li key={node.id} className="capiro-crm__pinned">
                        <span className="capiro-crm__row-title">{node.title}</span>
                        <span className="capiro-crm__meta capiro-crm__row-meta">{node.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="capiro-crm__card capiro-elevation-widget">
                <div className="capiro-crm__card-head">
                  <h3 className="capiro-crm__card-title">Milestones</h3>
                </div>
                {milestones.length === 0 ? (
                  <p className="capiro-crm__foot">No milestones recorded.</p>
                ) : (
                  <ul className="capiro-crm__rows">
                    {milestones.slice(0, 6).map((node) => (
                      <li key={node.id} className="capiro-crm__pinned">
                        <span className="capiro-crm__row-title">{node.title}</span>
                        <span className="capiro-crm__meta capiro-crm__row-meta">
                          {formatDate(node.endsOn ?? node.startsOn)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </>
      )}

      {open ? (
        <StrategyDetailDrawer
          detail={open}
          onClose={() => setOpen(null)}
          onOpenCanonical={() => navigate(`/strategies/${open.id}`)}
        />
      ) : null}
    </div>
  );
}

/** Strategy detail drawer — Figma `907:3246`. Read-through, never a copy. */
function StrategyDetailDrawer({
  detail,
  onClose,
  onOpenCanonical,
}: {
  detail: StrategyDetail;
  onClose: () => void;
  onOpenCanonical: () => void;
}) {
  const byKind = (kind: StrategyNode['kind']) => detail.nodes.filter((node) => node.kind === kind);

  return (
    <CapiroDrawer open title={detail.title} onClose={onClose}>
      <div className="capiro-crm-form">
        {detail.goal ? <p className="capiro-crm__foot">{detail.goal}</p> : null}

        <div className="capiro-crm__fields">
          <div>
            <p className="capiro-crm__meta">Type</p>
            <p className="capiro-crm__field-value">{detail.type}</p>
          </div>
          <div>
            <p className="capiro-crm__meta">Target date</p>
            <p
              className={`capiro-crm__field-value${detail.targetDate ? '' : ' capiro-crm__field-value--empty'}`}
            >
              {detail.targetDate ? formatDate(detail.targetDate) : 'Not set'}
            </p>
          </div>
        </div>

        {(['milestone', 'action', 'decision', 'gate', 'risk'] as const).map((kind) => {
          const rows = byKind(kind);
          if (rows.length === 0) return null;
          return (
            <div key={kind}>
              <p className="capiro-crm__meta capiro-crm__setting-head">
                {kind} · {rows.length}
              </p>
              <ul className="capiro-crm__rows">
                {rows.map((node) => (
                  <li key={node.id} className="capiro-crm__pinned">
                    <span className="capiro-crm__row-title">{node.title}</span>
                    <span className="capiro-crm__meta capiro-crm__row-meta">
                      {node.status}
                      {node.endsOn ? ` · ${formatDate(node.endsOn)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

        {detail.artifacts.length > 0 ? (
          <div>
            <p className="capiro-crm__meta capiro-crm__setting-head">
              Linked artifacts · {detail.artifacts.length}
            </p>
          </div>
        ) : null}

        <div className="capiro-crm-fill__actions">
          {/* Editing happens in the canonical module so there is one editor. */}
          <CapiroButton variant="primary" size="compact" onClick={onOpenCanonical}>
            Open in Strategies
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={onClose}>
            Close
          </CapiroButton>
        </div>
      </div>
    </CapiroDrawer>
  );
}

function withinDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return false;
  const now = Date.now();
  return time >= now && time <= now + days * 86_400_000;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
