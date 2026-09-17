import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Outlet } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';

vi.mock('./components/AppShell.js', () => ({
  AppShell: () => <div data-testid="classic-shell"><Outlet /></div>,
}));
vi.mock('./vnext/shell/AppShellUui/index.js', () => ({
  AppShellUui: ({ children }: { children: React.ReactNode }) => <div data-testid="uui-shell">{children}</div>,
}));
vi.mock('./vnext/pages/funding-opportunities/FundingOpportunitiesClassicShell.js', () => ({
  FundingOpportunitiesClassicShell: ({ children }: { children: React.ReactNode }) => <div data-testid="classic-funding-shell">{children}</div>,
}));
vi.mock('./lib/billing.js', () => ({
  useBillingState: () => ({ isLoading: false, data: { billingEnabled: false } }),
}));
vi.mock('./lib/me.js', () => ({ useMe: () => ({ data: { tenant: { slug: 'test' } } }) }));
vi.mock('@clerk/clerk-react', () => ({
  SignIn: () => <div>sign-in</div>,
  SignUp: () => <div>sign-up</div>,
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
}));
vi.mock('./vnext/pages/funding-opportunities/FundingOpportunitiesPage.js', () => ({
  FundingOpportunitiesPage: () => <div data-testid="v2-funding-page">v2 funding</div>,
}));
vi.mock('./pages/explorer/DataExplorerPage.js', () => ({
  DataExplorerPage: () => <div data-testid="data-explorer-page">explorer</div>,
}));
vi.mock('./pages/engagement/EngagementPreviewBoundary.js', () => ({ EngagementPreviewBoundary: () => null }));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>);
}

describe('canonical Funding Opportunities routes use the v2 implementation', () => {
  test.each([
    '/intelligence/opportunities?mode=all&query=typed',
    '/intelligence/opportunities/sam_gov/opaque%2Frecord%3Fone?mode=matched&clientId=client-1',
  ])('routes %s through the shared v2 page under classic shell', async (path) => {
    renderAt(path);
    await waitFor(() => expect(screen.getByTestId('v2-funding-page')).toBeInTheDocument());
    expect(screen.getByTestId('classic-funding-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('uui-shell')).not.toBeInTheDocument();
  });

  test('does not let the intelligence catch-all swallow the funding list', async () => {
    renderAt('/intelligence/opportunities');
    await waitFor(() => expect(screen.getByTestId('v2-funding-page')).toBeInTheDocument());
    expect(screen.queryByTestId('data-explorer-page')).not.toBeInTheDocument();
  });

  test('keeps malformed funding depths outside the owned route contract', async () => {
    renderAt('/intelligence/opportunities/only-one-segment');
    await waitFor(() => expect(screen.getByTestId('data-explorer-page')).toBeInTheDocument());
    expect(screen.queryByTestId('v2-funding-page')).not.toBeInTheDocument();
  });
});
