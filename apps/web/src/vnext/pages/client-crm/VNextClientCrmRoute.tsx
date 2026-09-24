import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Component, type ReactNode } from 'react';
import { useApi } from '../../../lib/use-api.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroErrorState } from '../../components/feedback/index.js';
import { ClientCrmPage } from './ClientCrmPage.js';
import { PortfolioIndexPage } from '../portfolio/PortfolioIndexPage.js';
import { BusinessDevelopmentPage } from '../business-development/BusinessDevelopmentPage.js';
import './client-crm.css';

/**
 * Module error boundary for the client CRM subtree.
 *
 * A render throw inside any tab (or a failed lazy chunk it pulls in) with no
 * boundary unmounts the whole route tree back to the raw Suspense fallback in
 * App.tsx — which on a fresh deep-link reads as the profile being stuck on
 * "Please wait..." with no way to recover short of a manual reload and a
 * lucky Clerk/network state. Catch it here so the user gets a styled,
 * in-module recovery state with the shell still mounted above. Same precedent
 * as StrategiesErrorBoundary in VNextStrategiesRoutes.tsx.
 */
export class ClientCrmErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override componentDidCatch(error: unknown): void {
    // Surface to the console for diagnostics; the UI shows the recovery state.
    console.error('[client-crm] render error boundary caught', error);
  }
  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="capiro-crm">
          <CapiroErrorState
            title="This client profile hit an unexpected error"
            description="The page failed to render. The client's data is intact — reload to try again."
            onRetry={() => window.location.reload()}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

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
  const queryClient = useQueryClient();
  const clientId = searchParams.get('clientId');
  const isBizDevView = searchParams.get('view') === 'business-development';

  // Same query key as ClientWorkspacePage, so switching between the canonical
  // and vNext surfaces is a cache hit and an edit invalidates both.
  //
  // `networkMode: 'always'` because react-query's default 'online' mode trusts
  // `navigator.onLine`, which reports false through VPN flips, sleep/wake and
  // captive portals while the API is perfectly reachable. In that state the
  // query sits `paused` (isPending, NOT isFetching), `refetch()` re-pauses
  // without a single network request, and the old `isLoading`/`!data` gates
  // rendered a dead-Retry error card. Attempting the fetch and failing honestly
  // is strictly better than refusing to try.
  const client = useQuery<Client>({
    queryKey: ['client', clientId],
    queryFn: async () => (await api.get<Client>(`/api/clients/${clientId}`)).data,
    enabled: Boolean(clientId),
    networkMode: 'always',
  });

  // No client chosen yet — the Portfolio index (PORTFOLIO-HANDOFF §7.1). It
  // replaces the engineering-derived picker with the design-grounded all-clients
  // surface. Placed after the hooks above so hook order never changes between
  // the index and the profile.
  if (!clientId && isBizDevView) return <BusinessDevelopmentPage />;
  if (!clientId) return <PortfolioIndexPage />;

  // `isPending` (no data yet) covers both fetching AND paused — a paused query
  // must read as loading, never as failed.
  if (client.isPending && !client.isPaused) {
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
    // `resetQueries` (not `refetch`) so Retry escapes every stuck state —
    // including a query the retryer refuses to start — by putting it back to
    // pending and issuing a fresh fetch.
    const retry = () => void queryClient.resetQueries({ queryKey: ['client', clientId], exact: true });
    const offline = client.isPaused;
    return (
      <div className="capiro-crm">
        <div className="capiro-crm__body">
          <div className="capiro-crm__card" role="alert">
            <div className="capiro-crm__card-head">
              <h2 className="capiro-crm__card-title">
                {offline ? 'You appear to be offline' : 'This client could not be loaded'}
              </h2>
            </div>
            <p className="capiro-crm__foot">
              {offline
                ? 'The browser reports no network connection. The profile will load as soon as one returns.'
                : client.error instanceof Error
                  ? client.error.message
                  : 'The request failed.'}
            </p>
            <div style={{ marginTop: 12 }}>
              <CapiroButton variant="secondary" size="compact" onClick={retry}>
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
  return (
    <ClientCrmErrorBoundary>
      <ClientCrmPage key={client.data.id} client={client.data} />
    </ClientCrmErrorBoundary>
  );
}
