import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ClientCrmPage } from './ClientCrmPage.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ data: { role: 'user_admin' } }),
}));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: () => Promise.resolve({ data: [] }),
    post: () => Promise.resolve({ data: {} }),
    put: () => Promise.resolve({ data: {} }),
    delete: () => Promise.resolve({ data: {} }),
  }),
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
vi.mock('./tabs/AdvocacyMattersTab.js', () => ({
  ClientCrmAdvocacyMattersProto: () => <div data-testid="advocacy-surface">advocacy</div>,
}));
vi.mock('./tabs/WorkTab.js', () => ({
  ClientCrmWorkProto: () => <div data-testid="work-surface">work</div>,
}));
vi.mock('./tabs/IntelligenceTab.js', () => ({
  useDomainStats: (_client: Client, view: string) =>
    view === 'legislative' ? [['3', 'Tracked bills']] : [['2', 'Records']],
  ClientCrmIntelligenceProto: ({ view, headless }: { view: string; headless?: boolean }) => (
    <div data-testid={`intelligence-surface-${view}`} data-headless={headless}>{view}</div>
  ),
}));
vi.mock('./tabs/OpportunitiesTab.js', () => ({
  ClientCrmOpportunitiesProto: () => <div data-testid="opportunities-surface">opportunities</div>,
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
const directoryRow = (key: string) => screen.getByTestId(`client-directory-${key}`);

describe('prototype client-record information architecture', () => {
  it('renders one eight-row directory in the prototype order', () => {
    renderAt('/clients?clientId=client-1');
    const directory = screen.getByRole('complementary', { name: 'Client record directories' });
    expect(
      within(directory).getAllByRole('button').map((button) => button.getAttribute('data-testid')),
    ).toEqual([
      'client-directory-timeline',
      'client-directory-advocacy',
      'client-directory-intelligence',
      'client-directory-opportunities',
      'client-directory-capabilities',
      'client-directory-relationships',
      'client-directory-work',
      'client-directory-files',
    ]);
  });

  it('opens a plain client record on Timeline with no accordion or drawer', () => {
    renderAt('/clients?clientId=client-1');
    expect(screen.getByTestId('history-surface')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Timeline' })).toBeInTheDocument();
    expect(directoryRow('timeline')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('advocacy-surface')).not.toBeInTheDocument();
  });

  it('swaps to Advocacy history instead of mounting a second record section', () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(directoryRow('advocacy'));

    expect(url()).toContain('tab=relationships');
    expect(url()).toContain('view=matters');
    expect(screen.getByTestId('advocacy-surface')).toBeInTheDocument();
    expect(screen.queryByTestId('history-surface')).not.toBeInTheDocument();
    expect(directoryRow('advocacy')).toHaveAttribute('aria-current', 'page');
  });

  it('deep-links to one Intelligence panel and opens each domain through its header', () => {
    renderAt('/clients?clientId=client-1&tab=intelligence&view=footprint');
    const domains = [
      ['legislative', 'Legislative & Regulatory'],
      ['footprint', 'Federal Footprint'],
      ['district', 'District Nexus'],
    ];
    expect(screen.getByTestId('intelligence-surface-footprint')).toBeInTheDocument();
    expect(screen.queryByTestId('intelligence-surface-legislative')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intelligence-surface-district')).not.toBeInTheDocument();

    for (const [view, label] of domains) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(label!) }));
      expect(url()).toContain(`view=${view}`);
      expect(screen.getByTestId(`intelligence-surface-${view}`)).toHaveAttribute('data-headless', 'true');
      for (const [otherView, otherLabel] of domains) {
        const header = screen.getByRole('button', { name: new RegExp(otherLabel!) });
        expect(header).toHaveAttribute('aria-expanded', String(otherView === view));
        expect(header).toHaveAttribute('aria-controls', `cap-pf-intel-panel-${otherView}`);
        if (otherView !== view) {
          expect(screen.queryByTestId(`intelligence-surface-${otherView}`)).not.toBeInTheDocument();
        }
      }
    }
    expect(screen.queryByTestId('intelligence-surface-funding')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-surface')).not.toBeInTheDocument();
  });

  it('collapses and reopens the same Intelligence header without changing its deep link', () => {
    renderAt('/clients?clientId=client-1&tab=intelligence&view=footprint');
    const header = screen.getByRole('button', { name: /Federal Footprint/ });
    const initialUrl = url();
    expect(header.tagName).toBe('BUTTON');
    expect(header).toHaveAttribute('type', 'button');

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByTestId(/^intelligence-surface-/)).toHaveLength(0);
    expect(url()).toBe(initialUrl);

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId(/^intelligence-surface-/)).toHaveLength(1);
    expect(screen.getByTestId('intelligence-surface-footprint')).toBeInTheDocument();
    expect(url()).toBe(initialUrl);
  });

  it('redirects a stale ?tab=intelligence&view=funding bookmark to Opportunities', () => {
    renderAt('/clients?clientId=client-1&tab=intelligence&view=funding');
    expect(screen.getByTestId('opportunities-surface')).toBeInTheDocument();
    expect(url()).toContain('tab=opportunities');
  });

  it('swaps to Opportunities from the directory', () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(directoryRow('opportunities'));

    expect(url()).toContain('tab=opportunities');
    expect(screen.getByTestId('opportunities-surface')).toBeInTheDocument();
    expect(screen.queryByTestId('history-surface')).not.toBeInTheDocument();
    expect(directoryRow('opportunities')).toHaveAttribute('aria-current', 'page');
  });
});

describe('directory drawers', () => {
  it('opens Work in the existing accessible drawer and persists the route', async () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(directoryRow('work'));

    expect(url()).toContain('tab=work');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('work-surface')).toBeInTheDocument();
  });

  it('opens Relationships on Organization and switches to Government', async () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(directoryRow('relationships'));

    const dialog = await screen.findByRole('dialog');
    expect(url()).toContain('view=organization');
    expect(within(dialog).getByTestId('organization-surface')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Government relationships' }));
    expect(url()).toContain('view=government');
    expect(await screen.findByTestId('government-surface')).toBeInTheDocument();
  });

  it('closes a drawer back to the prototype lead Timeline surface', async () => {
    renderAt('/clients?clientId=client-1&tab=work');
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(url()).toContain('tab=relationships');
    expect(url()).toContain('view=history');
    expect(await screen.findByTestId('history-surface')).toBeInTheDocument();
  });
});

describe('legacy route compatibility', () => {
  const cases: Array<[string, string, string | null]> = [
    ['activity', 'relationships', 'history'],
    ['people', 'relationships', 'organization'],
    ['targets', 'relationships', 'government'],
    ['facilities', 'intelligence', 'district'],
    ['documents', 'files', null],
    ['tracker', 'intelligence', 'legislative'],
    ['radar', 'intelligence', 'legislative'],
    ['legiwatch', 'intelligence', 'legislative'],
  ];

  it.each(cases)('?tab=%s normalizes to tab=%s', async (legacy, canonicalTab, view) => {
    renderAt(`/clients?clientId=client-1&tab=${legacy}`);
    expect(await screen.findByTestId('location')).toHaveTextContent(`tab=${canonicalTab}`);
    if (view) expect(url()).toContain(`view=${view}`);
  });
});

describe('header content', () => {
  it('renders real client identity, description, status and focus data', () => {
    renderAt('/clients?clientId=client-1');
    expect(screen.getByRole('heading', { name: 'Overland AI' })).toBeInTheDocument();
    expect(screen.getByText('Autonomy software for defense missions.')).toBeInTheDocument();
    expect(screen.getByText('Active client')).toBeInTheDocument();
    expect(screen.getByText('FY27 Ground Robotics')).toBeInTheDocument();
    expect(screen.getByText('Autonomy')).toBeInTheDocument();
  });
});
