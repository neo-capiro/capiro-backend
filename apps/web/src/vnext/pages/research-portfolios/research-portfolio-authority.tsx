import { createContext, useContext, useMemo, Fragment, type ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useImpersonation } from '../../../state/impersonation.js';
const ResearchPortfolioAuthorityContext = createContext<string | null>(null);
export function useResearchPortfolioAuthorityScope(): string | null {
  const { userId, orgId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  return userId ? JSON.stringify([userId, orgId ?? null, actAsTenantSlug ?? null]) : null;
}
/** A private cache and remount boundary; never changes the app's global QueryClient. */
export function ResearchPortfolioAuthorityBoundary({ children }: { children: ReactNode }) {
  const scope = useResearchPortfolioAuthorityScope();
  const inherited = useContext(ResearchPortfolioAuthorityContext);
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
    [scope],
  );
  if (!scope) return <p className="rp-state">Loading portfolio access…</p>;
  if (inherited === scope) return <>{children}</>;
  return (
    <ResearchPortfolioAuthorityContext.Provider value={scope}>
      <QueryClientProvider client={client}>
        <Fragment key={scope}>{children}</Fragment>
      </QueryClientProvider>
    </ResearchPortfolioAuthorityContext.Provider>
  );
}
