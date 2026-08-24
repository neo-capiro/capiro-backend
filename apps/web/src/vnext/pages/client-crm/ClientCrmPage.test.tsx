/**
 * Client CRM — Portfolio prototype shell tests.
 *
 * Behavioural contract only (URL-persisted route state, legacy deep links,
 * real client data in the header). The tab bodies are mocked at their
 * `./tabs/*` paths so the shell/orchestration is what is under test.
 *
 * Phase 4 (vnext UI cleanup): the old six-tab strip is gone. Relationships /
 * Work / Files / Capabilities now open in the right-side `RecordDrawer` via
 * the sticky `DrawerRail`; Overview / Timeline / Advocacy history /
 * Intelligence are an always-mounted, independently collapsible accordion
 * stack. The `?tab=`/`?view=` URL contract itself (client-crm-routing.ts) is
 * completely unchanged — every assertion below about URL normalization is
 * carried over verbatim from before this restructuring; only the DOM
 * assertions (which used to target `role="tab"`) are new, since that widget
 * no longer exists.
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
// The shell reads the client's sources for the breadcrumb freshness/gap chip
// and writes focus tags, so it needs an API client. Mocked the same way the
// sibling header test does — the real `useApi` pulls in Clerk's `useAuth`,
// which throws without a ClerkProvider.
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: () => Promise.resolve({ data: [] }),
    post: () => Promise.resolve({ data: {} }),
    put: () => Promise.resolve({ data: {} }),
    delete: () => Promise.resolve({ data: {} }),
  }),
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
// Advocacy history is a NEW always-mounted section (it was previously only
// reachable via ?tab=relationships&view=matters, which no test here ever
// exercised, so it had no mock before). Mocked the same way every other tab
// surface in this file is, so this shell test stays scoped to routing/
// presentation rather than AdvocacyMattersTab's own query behaviour, which
// has its own dedicated test file.
vi.mock('./tabs/AdvocacyMattersTab.js', () => ({
  ClientCrmAdvocacyMattersProto: () => <div data-testid="advocacy-surface">advocacy</div>,
}));
vi.mock('./tabs/WorkTab.js', () => ({
  ClientCrmWorkProto: () => <div data-testid="work-surface">work</div>,
}));
// Intelligence used to render exactly one domain at a time, so one shared
// testid was unambiguous. It is now an always-stacked section (all four
// domains mount together), so the mock must give each instance a distinct
// testid — otherwise four elements would answer to the same
// `getByTestId('intelligence-surface')` and RTL would throw on the
// ambiguity. This is a test-double change forced by the real restructuring,
// not a weakened assertion: `intelligence-surface-<view>` is strictly more
// precise than the old single shared id.
vi.mock('./tabs/IntelligenceTab.js', () => ({
  ClientCrmIntelligenceProto: ({ view }: { view: string }) => (
    <div data-testid={`intelligence-surface-${view}`}>{view}</div>
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
/** The DrawerRail's row for one of the four drawer tabs. */
const railRow = (key: 'relationships' | 'work' | 'files' | 'capabilities') =>
  screen.getByTestId(`drawer-rail-${key}`);
/** An accordion section's clickable header. */
const sectionHeader = (id: 'overview' | 'timeline' | 'advocacy' | 'intelligence') =>
  screen.getByTestId(`cap-pf-section-${id}-header`);

describe('DrawerRail (replaces the tab strip for Relationships/Work/Files/Capabilities)', () => {
  it('renders the four drawer triggers, in the prototype reading order, inside a sticky rail landmark', () => {
    renderAt('/clients?clientId=client-1');
    const rail = screen.getByRole('complementary', { name: 'Client record sections' });
    const keys = within(rail)
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-testid'));
    expect(keys).toEqual([
      'drawer-rail-relationships',
      'drawer-rail-work',
      'drawer-rail-files',
      'drawer-rail-capabilities',
    ]);
  });

  it('opens the Work drawer and writes the tab into the URL so it is linkable', async () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(railRow('work'));
    expect(url()).toContain('tab=work');
    expect(url()).toContain('clientId=client-1');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('work-surface')).toBeInTheDocument();
  });

  it('opens the Relationships drawer on its default view with a two-option sub-nav (history/matters are promoted sections, not drawer views)', async () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(railRow('relationships'));
    expect(url()).toContain('tab=relationships');
    expect(url()).toContain('view=organization');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('organization-surface')).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Organization' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Government relationships' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('tab', { name: /history/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('tab', { name: /matters/i })).not.toBeInTheDocument();
  });

  it('switching the Relationships drawer sub-nav updates the URL and swaps the drawer body', async () => {
    renderAt('/clients?clientId=client-1&tab=relationships&view=organization');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Government relationships' }));
    expect(url()).toContain('tab=relationships');
    expect(url()).toContain('view=government');
    expect(await screen.findByTestId('government-surface')).toBeInTheDocument();
  });

  it('keeps the client identity stable across a drawer open', async () => {
    renderAt('/clients?clientId=client-1');
    const heading = screen.getByRole('heading', { name: 'Overland AI' });
    fireEvent.click(railRow('files'));
    await screen.findByRole('dialog');
    expect(screen.getByRole('heading', { name: 'Overland AI' })).toBe(heading);
  });

  it('opens the Capabilities drawer directly from a deep link and highlights its rail row', async () => {
    renderAt('/clients?clientId=client-1&tab=capabilities');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('capabilities-surface')).toBeInTheDocument();
    expect(railRow('capabilities')).toHaveAttribute('aria-current', 'true');
  });

  it('closing the drawer (Escape) returns the URL to Overview', async () => {
    renderAt('/clients?clientId=client-1&tab=work');
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(url()).toContain('tab=overview');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('accordion sections (replaces the single-active-panel body)', () => {
  it('opens on Overview expanded, every other section collapsed, and no drawer', () => {
    renderAt('/clients?clientId=client-1');
    expect(screen.getByTestId('overview-surface')).toBeInTheDocument();
    expect(sectionHeader('overview')).toHaveAttribute('aria-expanded', 'true');
    expect(sectionHeader('timeline')).toHaveAttribute('aria-expanded', 'false');
    expect(sectionHeader('advocacy')).toHaveAttribute('aria-expanded', 'false');
    expect(sectionHeader('intelligence')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('history-surface')).not.toBeInTheDocument();
    expect(screen.queryByTestId('advocacy-surface')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intelligence-surface-legislative')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('each section header is an independent toggle: expanding one never touches another', async () => {
    renderAt('/clients?clientId=client-1');

    fireEvent.click(sectionHeader('timeline'));
    expect(sectionHeader('timeline')).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByTestId('history-surface')).toBeInTheDocument();
    // Overview stayed open, Advocacy history/Intelligence stayed closed.
    expect(sectionHeader('overview')).toHaveAttribute('aria-expanded', 'true');
    expect(sectionHeader('advocacy')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('advocacy-surface')).not.toBeInTheDocument();

    // Collapsible: clicking the same header again closes only that section.
    fireEvent.click(sectionHeader('timeline'));
    expect(sectionHeader('timeline')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('history-surface')).not.toBeInTheDocument();
    expect(sectionHeader('overview')).toHaveAttribute('aria-expanded', 'true');
  });

  it('?tab=relationships&view=history auto-expands Timeline, not the drawer', async () => {
    renderAt('/clients?clientId=client-1&tab=relationships&view=history');
    expect(await screen.findByTestId('history-surface')).toBeInTheDocument();
    expect(sectionHeader('timeline')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('?tab=relationships&view=matters auto-expands Advocacy history, not the drawer', async () => {
    renderAt('/clients?clientId=client-1&tab=relationships&view=matters');
    expect(await screen.findByTestId('advocacy-surface')).toBeInTheDocument();
    expect(sectionHeader('advocacy')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('navigating into a promoted section does not collapse a section the visitor already opened by hand', async () => {
    renderAt('/clients?clientId=client-1');
    fireEvent.click(sectionHeader('advocacy'));
    expect(await screen.findByTestId('advocacy-surface')).toBeInTheDocument();

    fireEvent.click(sectionHeader('timeline'));
    expect(await screen.findByTestId('history-surface')).toBeInTheDocument();
    // Advocacy history the visitor opened earlier is still open.
    expect(screen.getByTestId('advocacy-surface')).toBeInTheDocument();
  });

  it('always stacks all four Intelligence domains regardless of ?view=, and expands the section', async () => {
    for (const view of ['legislative', 'funding', 'footprint', 'district']) {
      const rendered = renderAt(`/clients?clientId=client-1&tab=intelligence&view=${view}`);
      expect(await screen.findByTestId('intelligence-surface-legislative')).toBeInTheDocument();
      expect(screen.getByTestId('intelligence-surface-funding')).toBeInTheDocument();
      expect(screen.getByTestId('intelligence-surface-footprint')).toBeInTheDocument();
      expect(screen.getByTestId('intelligence-surface-district')).toBeInTheDocument();
      expect(sectionHeader('intelligence')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      rendered.unmount();
    }
  });

  it('falls back to Overview expanded (not a blank record) for an unknown tab', () => {
    renderAt('/clients?clientId=client-1&tab=nonsense');
    expect(screen.getByTestId('overview-surface')).toBeInTheDocument();
    expect(sectionHeader('overview')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('legacy deep links (§2 compatibility mapping) — URL normalization is unchanged', () => {
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

  it.each(cases)('?tab=%s cold-loads and normalizes the URL to tab=%s', async (legacy, canonicalTab, view) => {
    renderAt(`/clients?clientId=client-1&tab=${legacy}`);
    expect(await screen.findByTestId('location')).toHaveTextContent(`tab=${canonicalTab}`);
    if (view) expect(url()).toContain(`view=${view}`);
  });

  it('retired ?view=overview and ?view=regulatory bookmarks under Intelligence normalize to legislative', async () => {
    const retired = renderAt('/clients?clientId=client-1&tab=intelligence&view=overview');
    expect(await screen.findByTestId('location')).toHaveTextContent('view=legislative');
    retired.unmount();

    const retiredRegulatory = renderAt('/clients?clientId=client-1&tab=intelligence&view=regulatory');
    expect(await screen.findByTestId('location')).toHaveTextContent('view=legislative');
    retiredRegulatory.unmount();
  });
});

describe('legacy deep links — land on the correct new surface (section vs. drawer)', () => {
  it('activity -> relationships/history lands on the Timeline section, no drawer', async () => {
    renderAt('/clients?clientId=client-1&tab=activity');
    expect(await screen.findByTestId('history-surface')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['facilities', 'tracker', 'radar', 'legiwatch'])(
    '%s lands on the always-stacked Intelligence section, no drawer',
    async (legacy) => {
      renderAt(`/clients?clientId=client-1&tab=${legacy}`);
      expect(await screen.findByTestId('intelligence-surface-legislative')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it.each([
    ['people', 'organization-surface'],
    ['targets', 'government-surface'],
    ['documents', 'files-surface'],
  ])('%s opens the drawer, showing %s', async (legacy, testId) => {
    renderAt(`/clients?clientId=client-1&tab=${legacy}`);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId(testId)).toBeInTheDocument();
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
