/**
 * Port of pages/settings/IntegrationsPage.capabilities.test.tsx to the vNext
 * body — the fail-OPEN capability-probe contract is identical: only an
 * explicit configured:false disables a provider's Connect button; a rejected
 * probe must never block a provider that is in fact configured.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VNextIntegrationsPage } from './VNextIntegrationsPage.js';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();
const apiPatchMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
    delete: apiDeleteMock,
    patch: apiPatchMock,
  }),
}));

const ME = {
  user: {
    id: 'u1',
    clerkUserId: 'clerk_1',
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    title: null,
    emailSignatureEnabled: false,
    hasEmailSignature: false,
    tourCompleted: true,
  },
  tenant: { id: 't1', slug: 'acme', name: 'Acme' },
  role: 'standard_user',
  billingAdmin: false,
  features: { meetingsV2: false },
};

const CATALOG = { oauthConfigured: false, oauthRedirectUri: null, connectors: [] };

type CapabilitiesBehavior = { kind: 'value'; configured: boolean } | { kind: 'reject' };

function byLabel(text: string) {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function mockRoutes(opts: { microsoft: CapabilitiesBehavior; google: CapabilitiesBehavior }) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/engagement/integrations') return { data: [] };
    if (url === '/api/me') return { data: ME };
    if (url === '/api/clio/mcp-catalog') return { data: CATALOG };
    if (url === '/api/clio/mcp-servers') return { data: [] };
    if (url === '/api/engagement/integrations/microsoft/capabilities') {
      if (opts.microsoft.kind === 'reject') throw new Error('capabilities probe failed');
      return {
        data: { configured: opts.microsoft.configured, redirectUri: '', scopes: [] },
      };
    }
    if (url === '/api/engagement/integrations/google/capabilities') {
      if (opts.google.kind === 'reject') throw new Error('capabilities probe failed');
      return { data: { configured: opts.google.configured, redirectUri: '', scopes: [] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <VNextIntegrationsPage />
    </QueryClientProvider>,
  );
}

describe('VNextIntegrationsPage capability gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('configured:false for Google disables only the Google Connect button', async () => {
    mockRoutes({
      microsoft: { kind: 'value', configured: true },
      google: { kind: 'value', configured: false },
    });
    renderPage();

    const googleButton = await screen.findByRole('button', {
      name: byLabel('Administrator setup required'),
    });
    expect(googleButton).toBeDisabled();

    const microsoftButton = screen.getByRole('button', { name: byLabel('Connect Microsoft 365') });
    expect(microsoftButton).toBeEnabled();
  });

  test('configured:true for both leaves both Connect buttons enabled with normal labels', async () => {
    mockRoutes({
      microsoft: { kind: 'value', configured: true },
      google: { kind: 'value', configured: true },
    });
    renderPage();

    const microsoftButton = await screen.findByRole('button', {
      name: byLabel('Connect Microsoft 365'),
    });
    const googleButton = await screen.findByRole('button', {
      name: byLabel('Connect Google Workspace'),
    });
    expect(microsoftButton).toBeEnabled();
    expect(googleButton).toBeEnabled();
    expect(screen.queryByText('Administrator setup required')).not.toBeInTheDocument();
  });

  test('a rejected capabilities probe fails OPEN: both buttons stay enabled', async () => {
    mockRoutes({ microsoft: { kind: 'reject' }, google: { kind: 'reject' } });
    renderPage();

    // Wait for the (rejected) queries to settle before asserting the fail-open state.
    const microsoftButton = await screen.findByRole('button', {
      name: byLabel('Connect Microsoft 365'),
    });
    const googleButton = screen.getByRole('button', { name: byLabel('Connect Google Workspace') });
    expect(microsoftButton).toBeEnabled();
    expect(googleButton).toBeEnabled();
  });
});
