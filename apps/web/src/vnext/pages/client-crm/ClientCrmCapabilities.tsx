import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapabilityDrawer, type Capability } from '../../../pages/clients/CapabilityDrawer.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Capabilities — compatibility surface (contract `1244:4222` §13).
 *
 * The five-tab IA has no primary Capabilities tab, and the contract is explicit
 * that this "does NOT mean the capability functionality may be deleted". This
 * screen keeps it reachable at `?tab=capabilities` and from the header overflow
 * menu until a vNext capability design is approved.
 *
 * It deliberately mounts the CANONICAL `CapabilityDrawer` rather than
 * re-implementing the editor. That drawer owns every field the contract lists —
 * TRL, MRL, tags, PE numbers, keywords, appropriation account, service branch,
 * target subcommittee, funding ask and label, justification, district nexus,
 * existing contracts, internal notes, advocacy/submission history and
 * capability documents. Rebuilding it here would be the fastest way to lose one
 * of them, and the drawer is not a mapped Figma component, so nothing is
 * duplicated by reusing it.
 */
export function ClientCrmCapabilities({ client }: { client: Client }) {
  const api = useApi();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Capability | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Capability | null>(null);

  const capabilities = useQuery<Capability[]>({
    // Same key the canonical profile uses, so both surfaces share one cache.
    queryKey: ['client-capabilities', client.id],
    queryFn: async () => (await api.get<Capability[]>(`/api/clients/${client.id}/capabilities`)).data,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/clients/${client.id}/capabilities/${id}`)).data,
    onSuccess: () => {
      setPendingDelete(null);
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });
    },
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });

  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__page-head">
        <div>
          <h2 className="capiro-crm__page-title">Capabilities</h2>
          <p className="capiro-crm__page-sub">
            Every capability, its readiness levels, budget and policy fields, and its advocacy
            history. Reached from the client overflow menu until a vNext design is approved.
          </p>
        </div>
        <span className="capiro-crm__page-head-spacer" />
        <CapiroButton variant="primary" size="compact" onClick={() => setCreating(true)}>
          Add capability
        </CapiroButton>
      </div>

      <div className="capiro-crm__grid">
        <section className="capiro-crm__card capiro-elevation-widget">
          {capabilities.isLoading ? (
            <div className="capiro-crm__skeleton" style={{ height: 180 }} aria-hidden />
          ) : capabilities.isError ? (
            <div className="capiro-crm__state capiro-crm__state--error" role="status">
              <span>
                {capabilities.error instanceof Error
                  ? capabilities.error.message
                  : 'Could not load capabilities'}
              </span>
              <CapiroButton
                variant="quiet"
                size="compact"
                onClick={() => void capabilities.refetch()}
              >
                Retry
              </CapiroButton>
            </div>
          ) : (capabilities.data ?? []).length === 0 ? (
            <div className="capiro-crm__state" role="status">
              No capabilities recorded for this client yet.
            </div>
          ) : (
            <ul className="capiro-crm__rows">
              {(capabilities.data ?? []).map((capability) => (
                <li key={capability.id}>
                  <button
                    type="button"
                    className="capiro-crm__row"
                    onClick={() => setEditing(capability)}
                  >
                    <span className="capiro-crm__row-main">
                      <span className="capiro-crm__row-title">{capability.name}</span>
                      <span className="capiro-crm__meta capiro-crm__row-meta">
                        {[
                          capability.type,
                          capability.serviceBranch,
                          capability.appropriationAccount,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'No classification recorded'}
                      </span>
                    </span>

                    <span className="capiro-crm__row-side">
                      {/* MISSING ≠ ZERO: an unset TRL is absent, not TRL 0. */}
                      {capability.trl != null ? <CapiroBadge>TRL {capability.trl}</CapiroBadge> : null}
                      {capability.mrl != null ? <CapiroBadge>MRL {capability.mrl}</CapiroBadge> : null}
                      {capability.peNumbers.length > 0 ? (
                        <span className="capiro-crm__meta">
                          {capability.peNumbers.length} PE
                        </span>
                      ) : null}
                      <span className="capiro-crm__meta">
                        {capability.fundingAskLabel ??
                          (capability.fundingAsk != null
                            ? `$${capability.fundingAsk.toLocaleString()}`
                            : 'No ask')}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {(editing || creating) && (
        <CapabilityDrawer
          capability={editing}
          clientId={client.id}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onUpdated={() => {
            refresh();
            setCreating(false);
          }}
          {...(editing ? { onDelete: () => setPendingDelete(editing) } : {})}
        />
      )}

      {/* §6: destructive mutations confirm, and the background cannot be
          mutated while the confirmation is open (the overlay traps focus). */}
      <CapiroModal
        open={Boolean(pendingDelete)}
        title="Delete capability"
        onClose={() => setPendingDelete(null)}
      >
        <p className="capiro-crm__foot">
          Delete <strong>{pendingDelete?.name}</strong>? Its advocacy history and linked
          documents are removed with it. This cannot be undone.
        </p>
        {remove.isError ? (
          <p className="capiro-crm__foot capiro-crm__state--error">
            {remove.error instanceof Error ? remove.error.message : 'Delete failed'}
          </p>
        ) : null}
        <div className="capiro-crm-fill__actions">
          <CapiroButton
            variant="primary"
            size="compact"
            loading={remove.isPending}
            onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
          >
            Delete
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={() => setPendingDelete(null)}>
            Cancel
          </CapiroButton>
        </div>
      </CapiroModal>
    </div>
  );
}
