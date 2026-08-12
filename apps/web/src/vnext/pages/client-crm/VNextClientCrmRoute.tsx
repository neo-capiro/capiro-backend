import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { CapiroButton } from '../../components/actions/index.js';
import { ClientCrmPage } from './ClientCrmPage.js';
import { PortfolioIndexPage } from '../portfolio/PortfolioIndexPage.js';
import './client-crm.css';

/**
 * Route entry for the vNext Client CRM.
 *
 * The client profile has no `/clients/:id` route — `/clients?clientId=<id>` is
 * the canonical URL and `ClientWorkspacePage` renders the profile inline. This
 * component substitutes the vNext presentation at that same URL, which is why
 * cold loads, refresh and browser Back/Forward all keep working unchanged.
 *
 * With no `clientId` this renders the vNext client picker. It cannot fall
 * through to the canonical list: that page tracks the selected client in local
 * state and never writes `clientId` to the URL, so a click there would silently
 * render the canonical profile on the vNext surface.
 */
export function VNextClientCrmRoute() {
  const [searchParams] = useSearchParams();
  const api = useApi();
  const clientId = searchParams.get('clientId');

  // Same query key as ClientWorkspacePage, so switching between the canonical
  // and vNext surfaces is a cache hit and an edit invalidates both.
  const client = useQuery<Client>({
    queryKey: ['client', clientId],
    queryFn: async () => (await api.get<Client>(`/api/clients/${clientId}`)).data,
    enabled: Boolean(clientId),
  });

  // No client chosen yet — the Portfolio index (PORTFOLIO-HANDOFF §7.1). It
  // replaces the engineering-derived picker with the design-grounded all-clients
  // surface. Placed after the hooks above so hook order never changes between
  // the index and the profile.
  if (!clientId) return <PortfolioIndexPage />;

  if (client.isLoading) {
    return (
      <div className="capiro-crm" aria-busy="true">
        {/* Skeleton mirrors the 120px header + first card row so the real
            content lands in the same place (§7). */}
        <div className="capiro-crm__skeleton" style={{ height: 120, borderRadius: 0 }} />
        <div className="capiro-crm__body">
          <div className="capiro-crm__grid capiro-crm__grid--profile">
            <div className="capiro-crm__skeleton" style={{ height: 166, borderRadius: 12 }} />
            <div className="capiro-crm__skeleton" style={{ height: 166, borderRadius: 12 }} />
          </div>
        </div>
      </div>
    );
  }

  if (client.isError || !client.data) {
    return (
      <div className="capiro-crm">
        <div className="capiro-crm__body">
          <div className="capiro-crm__card">
            <div className="capiro-crm__card-head">
              <h2 className="capiro-crm__card-title">This client could not be loaded</h2>
            </div>
            <p className="capiro-crm__foot">
              {client.error instanceof Error ? client.error.message : 'The request failed.'}
            </p>
            <div style={{ marginTop: 12 }}>
              <CapiroButton variant="secondary" size="compact" onClick={() => void client.refetch()}>
                Retry
              </CapiroButton>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // `key` remounts the CRM on a client switch so no per-client state leaks
  // across, matching the canonical page's behaviour.
  return <ClientCrmPage key={client.data.id} client={client.data} />;
}
