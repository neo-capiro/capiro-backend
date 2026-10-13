import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Client list for the vNext surface.
 *
 * ⚠️ ENGINEERING-DERIVED, NOT DESIGNER-AUTHORED. Figma page `906:2502` contains
 * eighteen screens for the client *profile* and no client *list* screen, so this
 * is built from the canonical vNext system (tokens, cards, rows) rather than
 * from a frame. Labelled per ruling 7.
 *
 * Why it exists at all: the canonical `ClientWorkspacePage` selects a client
 * with local React state (`setSelectedId`) and never writes `clientId` into the
 * URL, so there is no URL for the vNext router to intercept when a user clicks
 * a client. Rather than edit that canonical file — ruling 8 keeps
 * app.capiro.ai untouched — the vNext surface owns `/clients` outright and
 * navigates to `/clients?clientId=<id>`, which is the URL the CRM already reads
 * and the same one every existing deep link uses.
 */
export function VNextClientPicker() {
  const api = useApi();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  const clients = useQuery<Client[]>({
    // Same key the canonical workspace uses, so this is a cache hit either way.
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
  });

  const rows = useMemo(() => {
    const all = (clients.data ?? []).filter((client) => client.status !== 'archived');
    const needle = search.trim().toLowerCase();
    const matched = needle
      ? all.filter(
          (client) =>
            client.name.toLowerCase().includes(needle) ||
            (client.website ?? '').toLowerCase().includes(needle),
        )
      : all;
    return [...matched].sort((a, b) => a.name.localeCompare(b.name));
  }, [clients.data, search]);

  return (
    <div className="capiro-crm">
      <div className="capiro-crm__body">
        <div className="capiro-crm__page-head">
          <div>
            <h2 className="capiro-crm__page-title">Clients</h2>
            <p className="capiro-crm__page-sub">
              Open a client to see its overview, relationships, work, intelligence and files.
            </p>
          </div>
          <span className="capiro-crm__page-head-spacer" />
          <input
            className="capiro-crm-form__input capiro-crm__search"
            placeholder="Search clients"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search clients"
          />
        </div>

        <div className="capiro-crm__grid">
          <section className="capiro-crm__card capiro-elevation-widget">
            <div className="capiro-crm__card-head">
              <h3 className="capiro-crm__card-title">Portfolio</h3>
              <span className="capiro-crm__page-head-spacer" />
              <span className="capiro-crm__meta">{rows.length}</span>
            </div>

            {clients.isLoading ? (
              <div className="capiro-crm__skeleton" style={{ height: 280 }} aria-hidden />
            ) : clients.isError ? (
              <div className="capiro-crm__state capiro-crm__state--error" role="status">
                <span>
                  {clients.error instanceof Error
                    ? clients.error.message
                    : 'Could not load clients'}
                </span>
                <CapiroButton variant="quiet" size="compact" onClick={() => void clients.refetch()}>
                  Retry
                </CapiroButton>
              </div>
            ) : rows.length === 0 ? (
              <div className="capiro-crm__state" role="status">
                {(clients.data ?? []).length === 0
                  ? 'No clients yet.'
                  : 'No clients match that search.'}
              </div>
            ) : (
              <ul className="capiro-crm__rows">
                {rows.map((client) => (
                  <li key={client.id}>
                    <button
                      type="button"
                      className="capiro-crm__row"
                      onClick={() => navigate(`/clients?clientId=${encodeURIComponent(client.id)}`)}
                    >
                      <span className="capiro-crm__person-avatar" aria-hidden>
                        {initialsFor(client.name)}
                      </span>
                      <span className="capiro-crm__row-main">
                        <span className="capiro-crm__row-title">{client.name}</span>
                        <span className="capiro-crm__meta capiro-crm__row-meta">
                          {[client.sectorTag, client.website].filter(Boolean).join(' · ') ||
                            'No sector recorded'}
                        </span>
                      </span>
                      <span className="capiro-crm__row-side">
                        {(client.status ?? '').toLowerCase() === 'active' ? (
                          <CapiroBadge tone="success">ACTIVE</CapiroBadge>
                        ) : (
                          <CapiroBadge>{(client.status ?? 'unknown').toUpperCase()}</CapiroBadge>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
