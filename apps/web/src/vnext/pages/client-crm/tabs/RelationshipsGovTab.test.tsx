import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmGovernmentProto } from './RelationshipsGovTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

const TARGET = {
  id: 'ct-1',
  clientId: 'client-1',
  memberId: 'M000123',
  memberName: 'Rep. Dana Whitfield',
  sourceDirectory: 'congress',
  party: 'D',
  state: 'WA',
  chamber: 'House',
  committee: 'Armed Services',
  tier: 1,
  source: 'manual',
  addedByUserId: 'user-1',
  addedAt: '2026-05-04T00:00:00.000Z',
  representedFacilities: [{ id: 'fac-1', name: 'Seattle HQ' }],
};

const REC = {
  memberId: 'M000999',
  office: 'Rep. Jordan Hale (WA-07)',
  party: 'D' as const,
  state: 'WA',
  chamber: 'House' as const,
  committee: 'Appropriations',
  score: 0.84,
  tags: ['jurisdiction'],
  billCount: 3,
};

function mockApis(opts?: {
  targets?: unknown[];
  recommendations?: unknown[];
  computedAt?: string | null;
  recsError?: boolean;
}) {
  const targets = opts?.targets ?? [TARGET];
  const recommendations = opts?.recommendations ?? [REC];
  const computedAt = opts?.computedAt === undefined ? '2026-08-01T12:00:00.000Z' : opts.computedAt;

  getMock.mockImplementation((url: string) => {
    if (url === '/api/clients/client-1/targets') return Promise.resolve({ data: targets });
    if (url === '/api/clients/client-1/target-recommendations') {
      if (opts?.recsError) return Promise.reject(new Error('recs failed'));
      return Promise.resolve({ data: { recommendations, computedAt } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

  postMock.mockImplementation((url: string, body?: unknown) => {
    if (url === '/api/clients/client-1/target-recommendations/refresh') {
      return Promise.resolve({
        data: { recommendations, computedAt: '2026-08-19T00:00:00.000Z' },
      });
    }
    if (url === '/api/clients/client-1/targets') {
      const b = body as { memberId: string; source: string; sourceDirectory: string };
      return Promise.resolve({
        data: {
          id: `ct-new-${b.memberId}`,
          clientId: 'client-1',
          memberId: b.memberId,
          memberName: REC.office,
          sourceDirectory: b.sourceDirectory,
          party: REC.party,
          state: REC.state,
          chamber: REC.chamber,
          committee: REC.committee,
          tier: null,
          source: b.source,
          addedByUserId: 'user-1',
          addedAt: '2026-08-19T00:00:00.000Z',
          representedFacilities: [],
        },
      });
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
}

function renderGov() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmGovernmentProto client={client} />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('ClientCrmGovernmentProto', () => {
  it('navigates to the Directory vNext congressional staff page when "View directory" is clicked', async () => {
    mockApis();
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'View directory' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/directory/congressional-staff');
  });
});

describe('ClientCrmGovernmentProto — real targets (items 11-14, wire-audit)', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('renders real targets in the cards and table instead of the TARGETS/GOV_ROWS fixtures (items 12/14)', async () => {
    mockApis();
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Tier 1').length).toBeGreaterThan(0);
    expect(screen.getByText('Seattle HQ')).toBeInTheDocument();

    // The TARGETS fixture's own cards must not leak through as if real.
    expect(screen.queryByText('Schedule member meeting before HASC markup')).not.toBeInTheDocument();
    expect(screen.queryByText('FY27 Ground Robotics Funding')).not.toBeInTheDocument();
    expect(screen.queryByText('3 active · from Strategies')).not.toBeInTheDocument();
  });

  it('opens the real target drawer with real record fields and no invented narrative (item 13)', async () => {
    mockApis();
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Open target →')[0]!);

    // Real fields render...
    await waitFor(() => expect(screen.getByText('Target record')).toBeInTheDocument());
    // Also a card field label, hence getAllByText.
    expect(screen.getAllByText('Represents').length).toBeGreaterThan(0);
    // ...and the unbacked context is stated as absent rather than fabricated.
    expect(
      screen.getByText(/No linked strategy, ask or next action is recorded/),
    ).toBeInTheDocument();
  });

  /**
   * This used to assert `?tab=targets`, and passed while the button was DEAD:
   * `client-crm-routing` maps that legacy tab back to relationships/government,
   * so the navigation landed on the view already on screen and nothing happened.
   * Assert the outcome the user needs — a directory picker — not a URL.
   */
  it('opens the vNext directory picker from "Add relationship" (item 11)', async () => {
    mockApis();
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Add relationship' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Add relationship');
    expect(within(dialog).getByLabelText(/^Search the directory/)).toBeInTheDocument();
    // The picker is in-place: no navigation at all, and in particular not the
    // old self-referential hop to the legacy ?tab=targets.
    expect(screen.getByTestId('location')).not.toHaveTextContent('tab=targets');
  });

  it('shows an honest empty state instead of the fixture when the client has no targets', async () => {
    mockApis({ targets: [] });
    renderGov();

    await waitFor(() =>
      expect(
        screen.getAllByText('No government targets have been added for this client yet.').length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByText('FY27 Ground Robotics Funding')).not.toBeInTheDocument();
    // The card empty state is a hint pointing at the header's button — not a
    // second copy of the same button (polish item 3).
    expect(screen.getByText('No government targets yet — add one from the header.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add relationship' })).toHaveLength(1);
    // Nothing to page through, so no pagination at all (polish item 2).
    expect(screen.queryByRole('button', { name: 'Previous page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('counts the filtered set in the footer and names the unfiltered total (polish item 1)', async () => {
    mockApis({
      targets: [
        TARGET,
        {
          ...TARGET,
          id: 'ct-2',
          memberId: 'S000456',
          memberName: 'Sen. Alicia Boren',
          sourceDirectory: 'state',
          chamber: null,
          committee: null,
          tier: 2,
        },
      ],
    });
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    // No filter active: the plain count, with pagination present and labelled.
    expect(screen.getByText('Showing 2 of 2 relationships')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();

    // Search active: N of the FILTERED count, unfiltered total called out.
    fireEvent.change(screen.getByLabelText('Search relationships'), { target: { value: 'whitfield' } });
    expect(screen.getByText('Showing 1 of 1 relationship · filtered from 2')).toBeInTheDocument();

    // Zero matches: empty message, and the pagination disappears entirely.
    fireEvent.change(screen.getByLabelText('Search relationships'), { target: { value: 'zzz-no-match' } });
    expect(screen.getByText('No target matches this search.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('marks filter chips with aria-pressed and humanizes the added-via source (polish items 4-5)', async () => {
    mockApis();
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    const allChip = screen.getByRole('button', { name: 'All' });
    expect(allChip).toHaveAttribute('aria-pressed', 'true');
    const staffChip = screen.getByRole('button', { name: 'Staff' });
    expect(staffChip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(staffChip);
    expect(screen.getByRole('button', { name: 'Staff' })).toHaveAttribute('aria-pressed', 'true');

    // source 'manual' renders humanized, and the date comes from the shared
    // short-date helper (exact day depends on the machine timezone, so the
    // assertion stops at the separator).
    expect(screen.getByText(/^Manual · /)).toBeInTheDocument();
  });

  it('keeps the design fixture on screen while the targets query is loading', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderGov();

    expect(screen.getByText('3 active · from Strategies')).toBeInTheDocument();
  });
});

describe('ClientCrmGovernmentProto — target recommendations rail', () => {
  it('replaces Relationship network with Suggested by Meri and wires the real recs API', async () => {
    mockApis();
    renderGov();

    await waitFor(() => expect(screen.getByText('Rep. Jordan Hale (WA-07)')).toBeInTheDocument());
    expect(screen.getByText('Suggested by Meri')).toBeInTheDocument();
    expect(screen.queryByText('Relationship network')).not.toBeInTheDocument();
    expect(screen.queryByText(/Access-path mapping is not available/)).not.toBeInTheDocument();

    expect(screen.getByText(/3 tracked bills/)).toBeInTheDocument();
    expect(screen.getByText(/score 0\.84/)).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('/api/clients/client-1/target-recommendations');
  });

  it('adds a recommendation via POST targets with source=meri and marks it Added', async () => {
    mockApis();
    renderGov();

    await waitFor(() => expect(screen.getByText('Rep. Jordan Hale (WA-07)')).toBeInTheDocument());
    const addBtn = screen.getByRole('button', { name: '+ Add' });
    expect(addBtn).not.toBeDisabled();
    fireEvent.click(addBtn);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/targets', {
        memberId: 'M000999',
        source: 'meri',
        sourceDirectory: 'congress',
      }),
    );
    await waitFor(() => expect(screen.getByText('Added')).toBeInTheDocument());
  });

  it('refreshes recommendations via POST .../target-recommendations/refresh', async () => {
    mockApis();
    renderGov();

    // Card title mounts immediately; wait until the query settles so Refresh is enabled.
    await waitFor(() => expect(screen.getByText('Rep. Jordan Hale (WA-07)')).toBeInTheDocument());
    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
    expect(refreshBtn).not.toBeDisabled();
    fireEvent.click(refreshBtn);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/target-recommendations/refresh'),
    );
  });

  it('shows an empty state when there are no recommendations', async () => {
    mockApis({ recommendations: [] });
    renderGov();

    await waitFor(() => expect(screen.getByText('No Meri suggestions yet')).toBeInTheDocument());
    expect(
      screen.getByText(/Confirm this client's LDA match and add tracked bills/),
    ).toBeInTheDocument();
  });

  it('navigates to Intelligence legislative from the rail footer', async () => {
    mockApis();
    renderGov();

    await waitFor(() => expect(screen.getByText('Suggested by Meri')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'View all in Intelligence →' }));

    expect(screen.getByTestId('location')).toHaveTextContent('tab=intelligence');
    expect(screen.getByTestId('location')).toHaveTextContent('view=legislative');
  });
});
