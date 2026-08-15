/**
 * Client CRM — Portfolio prototype shell tests.
 *
 * Behavioural contract only (URL-persisted tab state, legacy deep links, the
 * keyboard contract, real client data in the header). The tab bodies are
 * mocked at their new `./tabs/*` paths so the shell is what is under test.
 *
 * IA note: Capabilities is a PRIMARY tab in the Portfolio prototype (§5.3,
 * §16), second in the order — it is no longer an overflow-only surface.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ClientCrmPage } from './ClientCrmPage.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ data: { role: 'user_admin' } }),
}));
vi.mock('./tabs/OverviewTab.js', () => ({
  ClientCrmOverviewProto: () => <div data-testid="overview-surface">overview</div>,
}));
vi.mock('./tabs/CapabilitiesTab.js', () => ({
  ClientCrmCapabilitiesProto: () => <div data-testid="capabilities-surface">capabilities</div>,
}));
vi.mock('./tabs/RelationshipsOrgTab.js', () => ({
  ClientCrmOrganizationProto: () => <div data-testid="organization-surface">organization</div>,
}));
vi.mock('./tabs/RelationshipsGovTab.js', () => ({
  ClientCrmGovernmentProto: () => <div data-testid="government-surface">government</div>,
}));
vi.mock('./tabs/RelationshipsHistoryTab.js', () => ({
  ClientCrmHistoryProto: () => <div data-testid="history-surface">history</div>,
}));
vi.mock('./tabs/WorkTab.js', () => ({
  ClientCrmWorkProto: () => <div data-testid="work-surface">work</div>,
}));
vi.mock('./tabs/IntelligenceTab.js', () => ({
  ClientCrmIntelligenceProto: ({ view }: { view: string }) => (
    <div data-testid="intelligence-surface">{view}</div>
  ),
}));
vi.mock('./tabs/FilesTab.js', () => ({
  ClientCrmFilesProto: () => <div data-testid="files-surface">files</div>,
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

describe('primary tabs (six, Portfolio order)', () => {
  it('renders all six tabs in the prototype order with Capabilities second', () => {
    renderAt('/clients?clientId=client-1');
    const tabs = screen.getAllByRole('tab').map((node) => node.textContent);
    expect(tabs).toEqual(['Overview', 'Capabilities', 'Relationships', 'Work', 'Intelligence', 'Files']);
  });

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

  it('writes the default secondary view when entering a two-level tab', () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(tab('Intelligence'));
    expect(url()).toContain('tab=intelligence');
    expect(url()).toContain('view=overview');
  });

  it('keeps the client identity stable across a tab change', () => {
    renderAt('/clients?clientId=client-1');
    const heading = screen.getByRole('heading', { name: 'Overland AI' });
    fireEvent.click(tab('Files'));
    expect(screen.getByRole('heading', { name: 'Overland AI' })).toBe(heading);
  });

  it('selects Capabilities as a primary tab', () => {
    renderAt('/clients?clientId=client-1&tab=capabilities');
    expect(tab('Capabilities')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('capabilities-surface')).toBeInTheDocument();
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
    expect(await screen.findByTestId('location')).toHaveTextContent(`tab=${tabName.toLowerCase()}`);
    if (view) expect(url()).toContain(`view=${view}`);
  });

  it('renders a real surface for every legacy destination', () => {
    const expected: Array<[string, string]> = [
      ['activity', 'history-surface'],
      ['people', 'organization-surface'],
      ['targets', 'government-surface'],
      ['facilities', 'intelligence-surface'],
      ['documents', 'files-surface'],
      ['tracker', 'intelligence-surface'],
    ];
    for (const [legacy, testId] of expected) {
      const view = renderAt(`/clients?clientId=client-1&tab=${legacy}`);
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      view.unmount();
    }
  });

  it('routes each Intelligence view to its own surface', () => {
    for (const view of ['overview', 'legislative', 'regulatory', 'funding', 'footprint', 'district']) {
      const rendered = renderAt(`/clients?clientId=client-1&tab=intelligence&view=${view}`);
      expect(screen.getByTestId('intelligence-surface')).toHaveTextContent(view);
      rendered.unmount();
    }
  });

  it('falls back to Overview for an unknown tab instead of rendering nothing', () => {
    renderAt('/clients?clientId=client-1&tab=nonsense');
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('keyboard contract (§6)', () => {
  it('moves focus and selection with Arrow, Home and End', () => {
    renderAt('/clients?clientId=client-1');

    tab('Overview').focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(tab('Capabilities')).toHaveFocus();
    expect(tab('Capabilities')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(tab('Files')).toHaveFocus();
    expect(tab('Files')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(tab('Overview')).toHaveFocus();
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  it('wraps at both ends', () => {
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
});

describe('header content is real client data, never sample copy', () => {
  it('renders focus chips from the client record', () => {
    renderAt('/clients?clientId=client-1');
    expect(screen.getByText('FY27 Ground Robotics')).toBeInTheDocument();
    expect(screen.getByText('Autonomy')).toBeInTheDocument();
  });

  it('renders the client name and active status in the identity block', () => {
    renderAt('/clients?clientId=client-1');
    expect(screen.getByRole('heading', { name: 'Overland AI' })).toBeInTheDocument();
    expect(screen.getByText('Active client')).toBeInTheDocument();
  });
});
