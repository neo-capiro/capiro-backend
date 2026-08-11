import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import { getClientTargets, type ClientTarget } from '../../../pages/clients/targets-api.js';
import type { StrategyListItem } from '../../../pages/strategy/types.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Relationships / Government — Figma `906:3075`, plus the Current Target drawer
 * `907:3137`.
 *
 * Two distinct concepts, per §8:
 *   CURRENT TARGETS — the existing `ClientTarget` records. No second target
 *   object is created for this profile; this reads and links the canonical one.
 *   BROADER GOVERNMENT RELATIONSHIPS — a projection over targets, facility
 *   representation and Strategy linkage. Edges are DERIVED, never hard-coded to
 *   reproduce the mock.
 */
export function ClientCrmGovernment({ client }: { client: Client }) {
  const api = useApi();
  const [selected, setSelected] = useState<ClientTarget | null>(null);

  const targets = useQuery<ClientTarget[]>({
    queryKey: ['client-targets', client.id],
    queryFn: () => getClientTargets(api, client.id),
    staleTime: 60_000,
  });

  // Strategy linkage: the Strategies service is authoritative for targeting
  // context, so it is read, not mirrored.
  const strategies = useQuery<StrategyListItem[]>({
    queryKey: ['strategy', 'strategies'],
    queryFn: async () => (await api.get<StrategyListItem[]>('/strategy-api/strategies')).data,
    staleTime: 30_000,
  });

  const clientStrategies = useMemo(
    () => (strategies.data ?? []).filter((entry) => entry.clientId === client.id),
    [strategies.data, client.id],
  );

  const rows = targets.data ?? [];

  // The relationship graph is a projection: one edge per real link that exists.
  const edges = useMemo(() => {
    const out: Array<{ id: string; from: string; to: string; via: string }> = [];
    for (const target of rows) {
      const name = target.memberName ?? target.memberId;
      if (target.committee) {
        out.push({ id: `${target.id}-cm`, from: name, to: target.committee, via: 'sits on' });
      }
      // representedFacilities === null means "not resolved", which is different
      // from an empty array meaning "resolved, represents none".
      for (const facility of target.representedFacilities ?? []) {
        out.push({
          id: `${target.id}-fac-${facility.id}`,
          from: name,
          to: facility.name,
          via: 'represents',
        });
      }
    }
    return out;
  }, [rows]);

  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__page-head">
        <div>
          <h2 className="capiro-crm__page-title">Government relationships</h2>
          <p className="capiro-crm__page-sub">
            Current targets and the wider network of offices, committees and districts this
            client already touches.
          </p>
        </div>
      </div>

      <div className="capiro-crm__grid capiro-crm__grid--history">
        <section className="capiro-crm__card capiro-elevation-widget" aria-labelledby="crm-targets">
          <div className="capiro-crm__card-head">
            <h3 className="capiro-crm__card-title" id="crm-targets">
              Current targets
            </h3>
            <span className="capiro-crm__page-head-spacer" />
            <span className="capiro-crm__meta">{rows.length} tracked</span>
          </div>

          {targets.isLoading ? (
            <div className="capiro-crm__skeleton" style={{ height: 280 }} aria-hidden />
          ) : targets.isError ? (
            <div className="capiro-crm__state capiro-crm__state--error" role="status">
              <span>
                {targets.error instanceof Error ? targets.error.message : 'Could not load targets'}
              </span>
              <CapiroButton variant="quiet" size="compact" onClick={() => void targets.refetch()}>
                Retry
              </CapiroButton>
            </div>
          ) : rows.length === 0 ? (
            <div className="capiro-crm__state" role="status">
              No government targets tracked for this client yet.
            </div>
          ) : (
            <ul className="capiro-crm__rows">
              {rows.map((target) => (
                <li key={target.id}>
                  <button
                    type="button"
                    className="capiro-crm__row"
                    onClick={() => setSelected(target)}
                  >
                    <span className="capiro-crm__row-main">
                      <span className="capiro-crm__row-title">
                        {target.memberName ?? 'Unnamed target'}
                      </span>
                      <span className="capiro-crm__meta capiro-crm__row-meta">
                        {[
                          target.chamber,
                          target.state,
                          target.party,
                          target.committee,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'No jurisdiction recorded'}
                      </span>
                    </span>
                    <span className="capiro-crm__row-side">
                      {target.tier ? <CapiroBadge tone="info">TIER {target.tier}</CapiroBadge> : null}
                      {/* null = unresolved, [] = resolved-and-none. Different facts. */}
                      {target.representedFacilities === null ? (
                        <span className="capiro-crm__meta" title="Representation could not be resolved">
                          repn. unknown
                        </span>
                      ) : target.representedFacilities.length > 0 ? (
                        <span className="capiro-crm__meta">
                          {target.representedFacilities.length} facility
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="capiro-crm__rail">
          <section className="capiro-crm__card capiro-elevation-widget">
            <div className="capiro-crm__card-head">
              <h3 className="capiro-crm__card-title">Relationship network</h3>
            </div>
            {edges.length === 0 ? (
              <p className="capiro-crm__foot">
                No committee or district links resolved yet. Links appear as targets and
                facilities resolve — they are never assumed.
              </p>
            ) : (
              <ul className="capiro-crm__rows">
                {edges.slice(0, 12).map((edge) => (
                  <li key={edge.id} className="capiro-crm__pinned">
                    <span className="capiro-crm__row-title">{edge.to}</span>
                    <span className="capiro-crm__meta capiro-crm__row-meta">
                      {edge.from} {edge.via}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="capiro-crm__card capiro-elevation-widget">
            <div className="capiro-crm__card-head">
              <h3 className="capiro-crm__card-title">Linked strategies</h3>
            </div>
            {clientStrategies.length === 0 ? (
              <p className="capiro-crm__foot">No strategies reference this client yet.</p>
            ) : (
              <ul className="capiro-crm__rows">
                {clientStrategies.map((strategy) => (
                  <li key={strategy.id} className="capiro-crm__pinned">
                    <span className="capiro-crm__row-title">{strategy.title}</span>
                    <span className="capiro-crm__meta capiro-crm__row-meta">
                      {strategy.type} · {strategy.nodeCount} steps
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {selected ? (
        <CurrentTargetDrawer
          target={selected}
          strategies={clientStrategies}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

/** Current Target drawer — Figma `907:3137`. */
function CurrentTargetDrawer({
  target,
  strategies,
  onClose,
}: {
  target: ClientTarget;
  strategies: StrategyListItem[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  return (
    <CapiroDrawer open title={target.memberName ?? 'Target'} onClose={onClose}>
      <div className="capiro-crm-form">
        <div className="capiro-crm__fields">
          <Fact label="Type" value={target.sourceDirectory} />
          <Fact label="Chamber" value={target.chamber} />
          <Fact label="Jurisdiction" value={target.state} />
          <Fact label="Party" value={target.party} />
          <Fact label="Committee" value={target.committee} />
          <Fact label="Tier" value={target.tier ? `Tier ${target.tier}` : null} />
        </div>

        <p className="capiro-crm__meta capiro-crm__setting-head">Representation evidence</p>
        {target.representedFacilities === null ? (
          <p className="capiro-crm__foot">
            {/* Missing evidence is not zero facilities. */}
            Representation could not be resolved from current district data — this is not the
            same as representing none.
          </p>
        ) : target.representedFacilities.length === 0 ? (
          <p className="capiro-crm__foot">
            Resolved against current districts: represents none of this client&apos;s facilities.
          </p>
        ) : (
          <ul className="capiro-crm__rows">
            {target.representedFacilities.map((facility) => (
              <li key={facility.id} className="capiro-crm__pinned">
                <span className="capiro-crm__row-title">{facility.name}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="capiro-crm__meta capiro-crm__setting-head">Strategy linkage</p>
        {strategies.length === 0 ? (
          <p className="capiro-crm__foot">
            No strategy references this client. The Strategy is authoritative for the current
            ask and target date.
          </p>
        ) : (
          <ul className="capiro-crm__rows">
            {strategies.map((strategy) => (
              <li key={strategy.id}>
                <button
                  type="button"
                  className="capiro-crm__row"
                  onClick={() => navigate(`/strategies/${strategy.id}`)}
                >
                  <span className="capiro-crm__row-main">
                    <span className="capiro-crm__row-title">{strategy.title}</span>
                    <span className="capiro-crm__meta capiro-crm__row-meta">
                      Open in Strategies for the current ask
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </CapiroDrawer>
  );
}

function Fact({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <p className="capiro-crm__meta">{label}</p>
      <p className={`capiro-crm__field-value${value ? '' : ' capiro-crm__field-value--empty'}`}>
        {value ?? 'Not recorded'}
      </p>
    </div>
  );
}
