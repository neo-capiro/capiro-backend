/**
 * Client CRM vNext shell tests — the parts of contract `1244:4222` that are
 * behaviour rather than pixels: URL-persisted tab state, legacy deep links
 * resolving to the new IA, browser navigation, and the §6 keyboard contract.
 *
 * The Overview body is data-backed, so these tests render the shell with a stub
 * surface; the Overview's own numbers are covered by the adapter's rules.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ClientCrmPage } from './ClientCrmPage.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

// The Overview surface issues real queries; the shell is what is under test.
vi.mock('./ClientCrmOverview.js', () => ({
  ClientCrmOverview: () => <div data-testid="overview-surface">overview</div>,
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: 'Autonomy software for defense missions.',
  productDescription: null,
  primaryContactName: 'Stephanie Bonk',
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: { portfolio: ['FY27 Ground Robotics'], tags: ['Autonomy'] },
  status: 'active',
  sectorTag: null,
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/clients"
            element={
              <div className="capiro-vnext-root">
                <ClientCrmPage client={client} />
                <LocationProbe />
              </div>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const url = () => screen.getByTestId('location').textContent ?? '';
const tab = (name: string) => screen.getByRole('tab', { name });

describe('primary tabs', () => {
  it('opens on Overview and marks exactly one tab selected', () => {
    renderAt('/clients?clientId=client-1');
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);
    expect(screen.getByTestId('overview-surface')).toBeInTheDocument();
  });

  it('writes the tab into the URL so the view is linkable', () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(tab('Work'));
    expect(url()).toContain('tab=work');
    expect(url()).toContain('clientId=client-1');
  });

  it('writes the default secondary view when entering a two-level tab', async () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(tab('Intelligence'));
    expect(url()).toContain('tab=intelligence');
    expect(url()).toContain('view=overview');
  });

  it('keeps the client header stable across a tab change', async () => {
    renderAt('/clients?clientId=client-1');
    const heading = screen.getByRole('heading', { name: 'Overland AI' });
    fireEvent.click(tab('Files'));
    // Same node, not a remounted copy — §4 requires a stable header.
    expect(screen.getByRole('heading', { name: 'Overland AI' })).toBe(heading);
  });
});

describe('legacy deep links (§2 compatibility mapping)', () => {
  const cases: Array<[string, string, string | null]> = [
    ['activity', 'Relationships', 'history'],
    ['people', 'Relationships', 'organization'],
    ['targets', 'Relationships', 'government'],
    ['facilities', 'Intelligence', 'district'],
    ['documents', 'Files', null],
    ['tracker', 'Intelligence', 'legislative'],
    ['radar', 'Intelligence', 'legislative'],
    ['legiwatch', 'Intelligence', 'legislative'],
  ];

  it.each(cases)('?tab=%s cold-loads into %s', async (legacy, tabName, view) => {
    renderAt(`/clients?clientId=client-1&tab=${legacy}`);
    expect(tab(tabName)).toHaveAttribute('aria-selected', 'true');
    // The URL is rewritten to canonical form so the address bar matches the view.
    expect(await screen.findByTestId('location')).toHaveTextContent(
      `tab=${tabName.toLowerCase()}`,
    );
    if (view) expect(url()).toContain(`view=${view}`);
  });

  it('keeps the capability surface reachable (§13 non-regression)', () => {
    renderAt('/clients?clientId=client-1&tab=capabilities');
    // Not a primary tab, so no tab is selected — but the surface still resolves
    // rather than silently redirecting the user's bookmark to Overview.
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'id',
      'capiro-crm-panel-capabilities',
    );
  });

  it('falls back to Overview for an unknown tab instead of rendering nothing', () => {
    renderAt('/clients?clientId=client-1&tab=nonsense');
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('keyboard contract (§6)', () => {
  it('moves focus and selection with Arrow, Home and End', async () => {
    renderAt('/clients?clientId=client-1');

    tab('Overview').focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(tab('Relationships')).toHaveFocus();
    expect(tab('Relationships')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(tab('Files')).toHaveFocus();
    expect(tab('Files')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(tab('Overview')).toHaveFocus();
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  it('wraps at both ends', async () => {
    renderAt('/clients?clientId=client-1');
    tab('Overview').focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(tab('Files')).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(tab('Overview')).toHaveFocus();
  });

  it('exposes a single tab stop for the tablist (roving tabindex)', () => {
    renderAt('/clients?clientId=client-1');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.filter((node) => node.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('wires each tab to its panel', () => {
    renderAt('/clients?clientId=client-1');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'capiro-crm-tab-overview');
    expect(tab('Overview')).toHaveAttribute('aria-controls', 'capiro-crm-panel-overview');
  });
});

describe('header content is real client data, never sample copy', () => {
  it('renders focus chips from the client record', () => {
    renderAt('/clients?clientId=client-1');
    const header = screen.getByRole('banner');
    expect(within(header).getByText('FY27 Ground Robotics')).toBeInTheDocument();
    expect(within(header).getByText('Autonomy')).toBeInTheDocument();
  });

  it('says so when no focus areas are set rather than inventing one', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/clients?clientId=client-1']}>
          <div className="capiro-vnext-root">
            <ClientCrmPage client={{ ...client, intakeData: null }} />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('No focus areas set')).toBeInTheDocument();
  });

  it('states the account owner is not tracked instead of showing a name', () => {
    // There is no owner column on Client; a name here would be invented.
    renderAt('/clients?clientId=client-1');
    expect(within(screen.getByRole('banner')).getByText('Not tracked')).toBeInTheDocument();
  });
});
