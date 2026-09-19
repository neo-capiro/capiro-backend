import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { TrackerSurface } from '../../../../pages/clients/tracker/TrackerTab.js';
import { LwButton } from '../lib/primitives.js';
import { watchlistSetupPath } from '../lib/watchlist-navigation.js';

/** Reuse the existing targeting, permissions, autosave and per-client alert
 * contracts. */
export function WatchlistSetup() {
  const api = useApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const scope = params.get('client') ?? '';
  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const available = (clients.data ?? []).filter((client) => client.status !== 'archived');
  const selected = available.find((client) => client.id === scope);

  return (
    <div className="lw-body" aria-label="Client watchlist setup">
      <section className="lw-card" style={{ padding: 18 }}>
        <h2 className="lw-card__title">Client watchlist and alerts</h2>
        <p>
          Choose the topics, terms and jurisdictions that matter to this client, then set your alert
          preferences.
        </p>
        <LwButton
          onClick={() =>
            navigate(
              `/legiwatch?tab=settings${scope ? `&client=${encodeURIComponent(scope)}` : ''}`,
            )
          }
        >
          Back to settings
        </LwButton>
        {clients.isLoading ? (
          <p>Loading clients…</p>
        ) : clients.isError ? (
          <div role="alert">
            <p>Clients could not be loaded. Your watchlists have not changed.</p>
            <LwButton onClick={() => void clients.refetch()}>Retry clients</LwButton>
          </div>
        ) : (
          <label style={{ display: 'block', marginTop: 16 }}>
            Client for watchlist setup{' '}
            <select
              value={selected?.id ?? ''}
              onChange={(event) => navigate(watchlistSetupPath(event.target.value))}
            >
              <option value="">Choose a client</option>
              {available.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!clients.isLoading && !clients.isError && !selected ? (
          <p>
            {scope
              ? 'This client is unavailable. Choose an active client to edit its watchlist.'
              : 'Choose a client to open its watchlist. No client is selected automatically.'}
          </p>
        ) : null}
      </section>
      {selected && !clients.isError ? (
        <div className="lw-card" style={{ padding: 18 }}>
          <TrackerSurface
            key={selected.id}
            clientId={selected.id}
            clientName={selected.name}
            variant="watchlist"
          />
        </div>
      ) : null}
    </div>
  );
}
