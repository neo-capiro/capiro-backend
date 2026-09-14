/**
 * Layout contract for Settings vNext: tabs are role-filtered through the SAME
 * visibleSettingsTabs the canonical SettingsLayout uses (settings-shared.ts —
 * presentation-only filtering; the API's RolesGuard stays the boundary), the
 * /settings index redirects to /settings/personal, and the Policy Packs
 * query-param tab renders in place of the outlet — exactly like canonical.
 *
 * Sub-pages are stubbed: this file tests the layout/routing contract, not the
 * page bodies.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { TenantRole } from '@capiro/shared';

const useMeMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/me.js', () => ({ useMe: useMeMock }));

vi.mock('./VNextPersonalPage.js', () => ({
  VNextPersonalPage: () => <div data-testid="page-personal" />,
}));
vi.mock('./VNextContactInfoPage.js', () => ({
  VNextContactInfoPage: () => <div data-testid="page-contact" />,
}));
vi.mock('./VNextMemorySettingsPage.js', () => ({
  VNextMemorySettingsPage: () => <div data-testid="page-memory" />,
}));
vi.mock('./VNextTeamPage.js', () => ({ VNextTeamPage: () => <div data-testid="page-team" /> }));
vi.mock('./VNextBrandingPage.js', () => ({
  VNextBrandingPage: () => <div data-testid="page-branding" />,
}));
vi.mock('./VNextClientsPage.js', () => ({
  VNextClientsPage: () => <div data-testid="page-clients" />,
}));
vi.mock('./VNextIntegrationsPage.js', () => ({
  VNextIntegrationsPage: () => <div data-testid="page-integrations" />,
}));
vi.mock('./VNextBillingPage.js', () => ({
  VNextBillingPage: () => <div data-testid="page-billing" />,
}));
vi.mock('./VNextCustomersPage.js', () => ({
  VNextCustomersPage: () => <div data-testid="page-customers" />,
}));
vi.mock('./VNextAiUsagePage.js', () => ({
  VNextAiUsagePage: () => <div data-testid="page-ai-usage" />,
}));
vi.mock('./VNextIntelligenceMappingsPage.js', () => ({
  VNextIntelligenceMappingsPage: () => <div data-testid="page-intel" />,
}));
vi.mock('./VNextSkillsPage.js', () => ({
  VNextSkillsPage: () => <div data-testid="page-skills" />,
}));
vi.mock('./VNextPolicyPacksPage.js', () => ({
  VNextPolicyPacksPage: () => <div data-testid="page-policy-packs" />,
}));
vi.mock('./VNextCapiroAdminPage.js', () => ({
  VNextCapiroAdminPage: () => <div data-testid="page-tenants" />,
}));
vi.mock('./VNextBroadcastsPage.js', () => ({
  VNextBroadcastsPage: () => <div data-testid="page-broadcasts" />,
}));

import { VNextSettingsRoutes } from './VNextSettingsRoutes.js';

function mockMe(role: TenantRole, billingAdmin: boolean) {
  useMeMock.mockReturnValue({
    isLoading: false,
    data: {
      user: { id: 'u1' },
      tenant: { id: 't1', slug: 'acme', name: 'Acme' },
      role,
      billingAdmin,
      features: {},
    },
  });
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <VNextSettingsRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function tabNames(): string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent ?? '');
}

describe('VNextSettingsRoutes — role-filtered tabs (same visibleSettingsTabs as canonical)', () => {
  it('standard user without billing sees only the four unrestricted tabs', () => {
    mockMe('standard_user', false);
    renderAt('/settings/personal');
    expect(tabNames()).toEqual(['Personal', 'Contact Info', 'Memory', 'Integrations']);
    expect(screen.getByTestId('page-personal')).toBeInTheDocument();
  });

  it('user_admin with billingAdmin gains the admin + billing tabs but not capiro-admin ones', () => {
    mockMe('user_admin', true);
    renderAt('/settings/personal');
    const names = tabNames();
    expect(names).toEqual([
      'Personal',
      'Contact Info',
      'Memory',
      'Team',
      'Branding',
      'Clients',
      'Integrations',
      'Billing',
      'AI Usage',
      'Intelligence',
      'Skills',
      'Policy Packs',
    ]);
    expect(names).not.toContain('Tenants');
    expect(names).not.toContain('Customers');
    expect(names).not.toContain('Broadcasts');
  });

  it('user_admin WITHOUT billingAdmin does not see Billing or AI Usage', () => {
    mockMe('user_admin', false);
    renderAt('/settings/personal');
    const names = tabNames();
    expect(names).not.toContain('Billing');
    expect(names).not.toContain('AI Usage');
    expect(names).toContain('Team');
  });

  it('capiro_admin with billingAdmin sees all fifteen tabs including Tenants, Customers and Broadcasts', () => {
    mockMe('capiro_admin', true);
    renderAt('/settings/personal');
    const names = tabNames();
    expect(names).toContain('Tenants');
    expect(names).toContain('Customers');
    expect(names).toContain('Broadcasts');
    expect(names).toHaveLength(15);
  });
});

describe('VNextSettingsRoutes — routing contract', () => {
  it('the /settings index redirects to /settings/personal', () => {
    mockMe('standard_user', false);
    renderAt('/settings');
    expect(screen.getByTestId('page-personal')).toBeInTheDocument();
  });

  it('routes each admin sub-page to its vNext body', () => {
    mockMe('capiro_admin', true);
    renderAt('/settings/tenants');
    expect(screen.getByTestId('page-tenants')).toBeInTheDocument();
  });

  it('routes /settings/broadcasts to the Broadcasts console', () => {
    mockMe('capiro_admin', true);
    renderAt('/settings/broadcasts');
    expect(screen.getByTestId('page-broadcasts')).toBeInTheDocument();
  });

  it('renders Policy Packs in place of the outlet for /settings/skills?view=policy-packs', () => {
    mockMe('user_admin', false);
    renderAt('/settings/skills?view=policy-packs');
    expect(screen.getByTestId('page-policy-packs')).toBeInTheDocument();
    expect(screen.queryByTestId('page-skills')).not.toBeInTheDocument();
  });

  it('renders the Skills page (not Policy Packs) for the bare /settings/skills path', () => {
    mockMe('user_admin', false);
    renderAt('/settings/skills');
    expect(screen.getByTestId('page-skills')).toBeInTheDocument();
    expect(screen.queryByTestId('page-policy-packs')).not.toBeInTheDocument();
  });

  it('renders the canonical 404 copy for an unknown /settings sub-path', () => {
    mockMe('standard_user', false);
    renderAt('/settings/does-not-exist');
    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(screen.getByText("404 - this page doesn't exist.")).toBeInTheDocument();
  });
});
