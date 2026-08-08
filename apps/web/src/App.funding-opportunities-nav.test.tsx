import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Outlet } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';

// The real AppShell pulls in the whole chrome (Clerk, the flag map, ~20 hooks);
// every existing spec in this repo mocks it away. Stubbed down to its Outlet so
// the routed child still renders and route wiring is observable.
vi.mock('./components/AppShell.js', () => ({
  AppShell: () => (
    <div data-testid="app-shell">
      <Outlet />
    </div>
  ),
}));

vi.mock('./lib/billing.js', () => ({
  useBillingState: () => ({ isLoading: false, data: { billingEnabled: false } }),
}));

// The two outcomes this spec discriminates between: the new page, and the
// /intelligence/* catch-all's redirect target.
vi.mock('./pages/intelligence/opportunities/FundingOpportunitiesPage.js', () => ({
  FundingOpportunitiesPage: () => <div data-testid="funding-opportunities-page">page</div>,
}));

vi.mock('./pages/intelligence/opportunities/FundingOpportunityDetail.js', () => ({
  FundingOpportunityDetailPage: () => <div data-testid="funding-opportunity-detail-page">detail</div>,
}));

vi.mock('./pages/explorer/DataExplorerPage.js', () => ({
  DataExplorerPage: () => <div data-testid="data-explorer-page">explorer</div>,
}));

vi.mock('@clerk/clerk-react', async () => ({
  SignIn: () => <div>sign-in</div>,
  SignUp: () => <div>sign-up</div>,
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
}));

// Anchored on the package root, not `import.meta.url`: under the jsdom
// environment these .tsx specs run in, the module URL is not a file: URL, so
// bundle-boundaries.test.ts's `fileURLToPath` trick works only in .ts specs.
const SRC = resolve(process.cwd(), 'src');
const appSource = readFileSync(resolve(SRC, 'App.tsx'), 'utf8');
const appShellSource = readFileSync(resolve(SRC, 'components/AppShell.tsx'), 'utf8');

function renderAppWithRouter(initialEntries: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Funding Opportunities route registration', () => {
  test('/intelligence/opportunities resolves to the page, not the catch-all redirect', async () => {
    renderAppWithRouter(['/intelligence/opportunities']);

    await waitFor(() =>
      expect(screen.getByTestId('funding-opportunities-page')).toBeInTheDocument(),
    );
    // The failure this guards against is silent: registered AFTER
    // `/intelligence/*`, the deep link redirects to Data Explorer rather than
    // 404ing, so the page looks "missing" instead of broken.
    expect(screen.queryByTestId('data-explorer-page')).not.toBeInTheDocument();
  });

  test('the /intelligence/* catch-all still redirects every other path', async () => {
    renderAppWithRouter(['/intelligence/not-a-real-surface']);

    await waitFor(() => expect(screen.getByTestId('data-explorer-page')).toBeInTheDocument());
    expect(screen.queryByTestId('funding-opportunities-page')).not.toBeInTheDocument();
  });

  test('/intelligence/opportunities/:source/:id resolves to the detail page (P12)', async () => {
    // The failure this guards against is the same silent one as above, and it is
    // WORSE for a detail link: pasted into a ticket, an unregistered detail route
    // redirects to Data Explorer, so the record looks like it was deleted.
    // Uses the shared helper, which supplies a QueryClientProvider. `App` began
    // REQUIRING one when PR #813 mounted `EngagementPreviewBoundary` beside the
    // route table — it calls `useQueryClient()` unconditionally. Two tests in
    // this file still rendered `<App />` bare and threw
    // "No QueryClient set, use QueryClientProvider to set one", which is what
    // kept this gate red. Nothing about the routes under test changed.
    renderAppWithRouter(['/intelligence/opportunities/sam_gov/notice-1?clientId=c1']);

    await waitFor(() =>
      expect(screen.getByTestId('funding-opportunity-detail-page')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('data-explorer-page')).not.toBeInTheDocument();
    // The list route is a literal and must not swallow the two-segment path.
    expect(screen.queryByTestId('funding-opportunities-page')).not.toBeInTheDocument();
  });

  test('a one-segment path under opportunities still falls through to the catch-all', async () => {
    // `/intelligence/opportunities/foo` matches neither the literal list route nor
    // the two-param detail route.
    renderAppWithRouter(['/intelligence/opportunities/foo']);
    await waitFor(() => expect(screen.getByTestId('data-explorer-page')).toBeInTheDocument());
  });

  test('the page is code-split, not in the eager import graph', () => {
    // Asserted at the source level: whether a chunk is split is a bundler fact,
    // and a render test cannot tell a lazy component from an eager one once the
    // module is mocked.
    expect(appSource).toMatch(
      /const FundingOpportunitiesPage = lazy\([\s\S]{0,300}?opportunities\/FundingOpportunitiesPage\.js'\)/,
    );
    expect(appSource).not.toMatch(/^import .*opportunities\/FundingOpportunitiesPage/m);
  });

  test('the detail page is its own lazy chunk, not bundled with the list', () => {
    // A detail link is reached independently of the inbox — pasted into a ticket,
    // it is the first thing the browser loads. Sharing a chunk would make either
    // page pay for the other.
    expect(appSource).toMatch(
      /const FundingOpportunityDetailPage = lazy\([\s\S]{0,300}?opportunities\/FundingOpportunityDetail\.js'\)/,
    );
    expect(appSource).not.toMatch(/^import .*opportunities\/FundingOpportunityDetail/m);
  });
});

describe('Funding Opportunities navigation item', () => {
  // NAV is module-private and AppShell is never render-tested here, so the nav
  // contract is pinned at the source level. It still fails if the entry is
  // deleted, relabelled, unhooked from its flag, or repointed.
  const peGroup = appShellSource.slice(
    appShellSource.indexOf("key: 'pe-group'"),
    appShellSource.indexOf('export function AppShell'),
  );

  test('appears in the Intelligence group, gated on funding_opportunities', () => {
    const entry = peGroup.match(/\{\s*key: 'funding-opportunities',[\s\S]*?\},/)?.[0];

    expect(entry).toBeTruthy();
    expect(entry).toContain("label: 'Funding Opportunities'");
    expect(entry).toContain("path: '/intelligence/opportunities'");
    // No flag row exists for any tenant, and this guard has no internal-tenant
    // fallback — dropping the flag would expose the surface everywhere at once.
    expect(entry).toContain("featureFlag: 'funding_opportunities'");
  });

  test('sits alongside the other Intelligence subtabs', () => {
    for (const sibling of [
      "label: 'LegiWatch'",
      "label: 'Data Explorer'",
      "label: 'District Nexus'",
      "label: 'Knowledge Graph'",
      "label: 'Program Elements'",
    ]) {
      expect(peGroup).toContain(sibling);
    }
  });

  test('its path is matched before the general /intelligence prefix', () => {
    const specific = appShellSource.indexOf("startsWith('/intelligence/opportunities')");
    const general = appShellSource.indexOf(
      "startsWith('/explorer') || pathname.startsWith('/intelligence')",
    );

    expect(specific).toBeGreaterThan(-1);
    expect(general).toBeGreaterThan(-1);
    // Matched after the general prefix, the nav highlights Data Explorer while
    // the user is on Funding Opportunities.
    expect(specific).toBeLessThan(general);
  });
});
