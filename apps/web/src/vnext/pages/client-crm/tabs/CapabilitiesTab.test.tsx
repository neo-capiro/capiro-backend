import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmCapabilitiesProto } from './CapabilitiesTab.js';
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

function renderCapabilities(clientOverride?: Client) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmCapabilitiesProto client={clientOverride ?? client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('ClientCrmCapabilitiesProto', () => {
  it('shows a real empty state instead of the design fixture when the client has no capabilities', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderCapabilities();

    await waitFor(() => expect(screen.getByText('No capability areas recorded yet.')).toBeInTheDocument());
    // The CAP_AREAS fixture's designed cards must not leak through as if real.
    expect(screen.queryByText('Autonomous ground maneuver')).not.toBeInTheDocument();
  });

  it('does not render a second Fill with Meri button — the shell header owns the only one', async () => {
    getMock.mockResolvedValue({
      data: [{ id: 'cap-1', name: 'Autonomy stack', type: 'platform', tags: [], peNumbers: [] }],
    });
    renderCapabilities();

    await screen.findByText('Autonomy stack');
    expect(screen.queryByRole('button', { name: 'Fill with Meri' })).not.toBeInTheDocument();
    // Add capability is still the tab's own action.
    expect(screen.getAllByRole('button', { name: 'Add capability' }).length).toBeGreaterThan(0);
  });

  it('does not render past performance — it moved to Intelligence / Federal Footprint', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderCapabilities();

    await waitFor(() => expect(screen.getByText('No capability areas recorded yet.')).toBeInTheDocument());
    expect(screen.queryByText('Past performance')).not.toBeInTheDocument();
  });

  it('opens a modal capability editor rather than appending the editor below the page', async () => {
    getMock.mockResolvedValue({
      data: [{ id: 'cap-1', name: 'Autonomy stack', type: 'platform', tags: [], peNumbers: [] }],
    });
    renderCapabilities();

    fireEvent.click(await screen.findByRole('button', { name: /Autonomy stack/i }));

    expect(await screen.findByRole('dialog', { name: /Autonomy stack/i })).toBeInTheDocument();
  });

  /* ── §7.2 Registrations & codes (wire-audit "3 Compose extend" item 1) ──── */

  it('renders registrations from the real client record, not the CAP_CODES fixture', async () => {
    getMock.mockResolvedValue({ data: [] });
    // Deliberately none of these values appear in portfolio-fixtures.ts — a
    // test that reuses a fixture string passes even when nothing is wired.
    renderCapabilities({
      ...client,
      uei: 'WQ7RSTUV1234',
      cageCode: '5K2P1',
      pscCodes: ['5865', 'R425'],
      setAsideCertifications: ['HZC'],
      intakeData: {
        primaryNaics: '541512 · Computer Systems Design Services',
        samStatus: 'Active',
        samExpirationDate: '2027-03-19',
        sbClassification: { sb: true, wosb: true },
      },
    });

    expect(await screen.findByText('WQ7RSTUV1234')).toBeInTheDocument();
    expect(screen.getByText('5K2P1')).toBeInTheDocument();
    expect(screen.getByText('5865, R425')).toBeInTheDocument();
    expect(screen.getByText('541512 · Computer Systems Design Services')).toBeInTheDocument();
    // SAM codes render as their English labels, from the same option list the
    // Company Info wizard writes them with.
    expect(screen.getByText('HUBZone')).toBeInTheDocument();
    expect(screen.getByText('Small Business · WOSB')).toBeInTheDocument();
    // The header stamp is the recorded SAM status, not a hardcoded date.
    expect(screen.getByText(/SAM\.gov · Active · expires/)).toBeInTheDocument();

    // The fixture's own UEI must not appear anywhere.
    expect(screen.queryByText('ZQ4M8TR2LKD7')).not.toBeInTheDocument();
    expect(screen.queryByText('SAM.gov · verified Aug 04')).not.toBeInTheDocument();
  });

  it('shows a real empty state when the client has no registrations recorded', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderCapabilities();

    expect(await screen.findByText('No registrations or codes recorded for this client yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit client profile' })).toBeInTheDocument();
    expect(screen.queryByText('ZQ4M8TR2LKD7')).not.toBeInTheDocument();
  });
});

/* ── capability evidence ("4 New capability" row 2) ──────────────────────── */

describe('ClientCrmCapabilitiesProto — capability evidence (row 2)', () => {
  it('renders no invented matches count or evidence tier on a real capability', async () => {
    getMock.mockResolvedValue({
      data: [{ id: 'cap-1', name: 'Autonomy stack', type: 'platform', tags: [], peNumbers: [] }],
    });
    renderCapabilities();

    await screen.findByText('Autonomy stack');
    // The CAP_AREAS fixture used to supply these by index, stamping invented
    // provenance onto a real capability record.
    expect(screen.queryByText('Matches')).not.toBeInTheDocument();
    expect(screen.queryByText('SAM.gov')).not.toBeInTheDocument();
  });
});

describe('ClientCrmCapabilitiesProto — capability fit', () => {
  const emptyFit = {
    matches: [],
    computedAt: null,
    status: 'empty',
    emptyReason: 'No fit matches yet.',
    sources: { pe: false, bill: false, fo: false },
  };

  function mockFit(fit: unknown) {
    getMock.mockImplementation((url: string) => {
      if (url.endsWith('/capability-fit')) return Promise.resolve({ data: fit });
      if (url.endsWith('/capabilities')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
  }

  it('renders live PE and bill matches with their fit chips', async () => {
    mockFit({
      matches: [
        { id: 'pe:0605053A', kind: 'pe', targetId: '0605053A', target: 'PE 0605053A · Ground Robotics', why: 'Capability lists PE 0605053A', fit: 100, score01: 1, capabilityIds: ['cap-1'], href: '/program-elements/0605053A' },
        { id: 'bill:119-hr-9201', kind: 'bill', targetId: '119-hr-9201', target: 'H.R. 9201 · Defense Autonomy Test Range Act', why: 'Matched capability tags: autonomy', fit: 94, score01: 0.94, capabilityIds: ['cap-1'], href: '/bills/119-hr-9201' },
      ],
      computedAt: '2026-08-21T12:00:00.000Z', status: 'ready', sources: { pe: true, bill: true, fo: false },
    });
    renderCapabilities();

    expect(await screen.findByText('PE 0605053A · Ground Robotics')).toBeInTheDocument();
    expect(screen.getByText('H.R. 9201 · Defense Autonomy Test Range Act')).toBeInTheDocument();
    expect(screen.getByText('Capability lists PE 0605053A')).toBeInTheDocument();
    expect(screen.getByText('Matched capability tags: autonomy')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('94%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PE 0605053A · Ground Robotics' })).toHaveAttribute('href', '/program-elements/0605053A');
  });

  it.each([
    ['empty', 'No bill, PE, or funding matches.', 'Refresh'],
    ['profile_too_thin', 'Add tags to a capability first.', 'Add capability'],
  ] as const)('renders the API-owned %s state without fixture fallback', async (status, reason, action) => {
    mockFit({ ...emptyFit, status, emptyReason: reason });
    renderCapabilities();
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: action }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Autonomous ground maneuver')).not.toBeInTheDocument();
  });

  it('renders stale rows with the freshness warning and refresh action', async () => {
    mockFit({ ...emptyFit, status: 'stale', emptyReason: undefined, matches: [
      { id: 'fo:sam_gov:notice-1', kind: 'fo', targetId: 'notice-1', target: 'UGV Autonomy R&D', why: 'The notice matches the client capability profile.', fit: 88, score01: 0.88, capabilityIds: [], href: '/intelligence/opportunities/sam_gov/notice-1' },
    ] });
    renderCapabilities();
    expect(await screen.findByText('UGV Autonomy R&D')).toBeInTheDocument();
    expect(screen.getByText(/may be outdated/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('refreshes through the capability-fit endpoint', async () => {
    mockFit(emptyFit);
    postMock.mockResolvedValue({ data: emptyFit });
    renderCapabilities();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/capability-fit/refresh'));
  });
});
