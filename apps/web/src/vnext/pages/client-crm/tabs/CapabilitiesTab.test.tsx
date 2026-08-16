import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmCapabilitiesProto } from './CapabilitiesTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
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

function renderCapabilities(onFillWithMeri?: () => void, clientOverride?: Client) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmCapabilitiesProto client={clientOverride ?? client} onFillWithMeri={onFillWithMeri} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
});

describe('ClientCrmCapabilitiesProto', () => {
  it('shows a real empty state instead of the design fixture when the client has no capabilities', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderCapabilities();

    await waitFor(() => expect(screen.getByText('No capability areas recorded yet.')).toBeInTheDocument());
    // The CAP_AREAS fixture's designed cards must not leak through as if real.
    expect(screen.queryByText('Autonomous ground maneuver')).not.toBeInTheDocument();
  });

  it('calls the passed-down Fill with Meri handler when the tab button is clicked', async () => {
    getMock.mockResolvedValue({
      data: [{ id: 'cap-1', name: 'Autonomy stack', type: 'platform', tags: [], peNumbers: [] }],
    });
    const onFillWithMeri = vi.fn();
    renderCapabilities(onFillWithMeri);

    await screen.findByText('Autonomy stack');
    fireEvent.click(screen.getByRole('button', { name: 'Fill with Meri' }));

    expect(onFillWithMeri).toHaveBeenCalledTimes(1);
  });

  /* ── §7.2 Registrations & codes (wire-audit "3 Compose extend" item 1) ──── */

  it('renders registrations from the real client record, not the CAP_CODES fixture', async () => {
    getMock.mockResolvedValue({ data: [] });
    // Deliberately none of these values appear in portfolio-fixtures.ts — a
    // test that reuses a fixture string passes even when nothing is wired.
    renderCapabilities(undefined, {
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

/* ── §7.3 past performance + capability evidence ("4 New capability") ────── */

const CAPABILITY = { id: 'cap-1', name: 'Autonomy stack', type: 'platform', tags: [], peNumbers: [] };

/** Routes capabilities vs. per-capability submission history. */
function mockCapabilityApi(history: unknown[]) {
  getMock.mockImplementation((url: string) => {
    if (url.endsWith('/history')) return Promise.resolve({ data: history });
    if (url.endsWith('/capabilities')) return Promise.resolve({ data: [CAPABILITY] });
    return Promise.resolve({ data: [] });
  });
}

describe('ClientCrmCapabilitiesProto — past performance (row 12)', () => {
  it('renders the real submission history instead of the CAP_PERF fixture', async () => {
    mockCapabilityApi([
      {
        id: 'sub-1',
        clientId: 'client-1',
        capabilityId: 'cap-1',
        fiscalYear: 'FY28',
        // Absent from portfolio-fixtures.ts, so this cannot pass against CAP_PERF.
        title: 'Ground autonomy retrofit line',
        meta: 'Submitted to SASC professional staff',
        outcome: 'Included +$4M',
        outcomeType: 'success',
        notes: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ]);
    renderCapabilities();

    expect(await screen.findByText('Ground autonomy retrofit line')).toBeInTheDocument();
    expect(screen.getByText('Included +$4M')).toBeInTheDocument();
    // Real count, not the design's hardcoded "View all 14".
    expect(screen.getByText('1 record')).toBeInTheDocument();
    expect(screen.queryByText('View all 14')).not.toBeInTheDocument();
    // The CAP_PERF fixture must not leak through as if real.
    expect(screen.queryByText('ULTRA autonomy integration')).not.toBeInTheDocument();
    expect(screen.queryByText('GPS-denied navigation study')).not.toBeInTheDocument();
  });

  it('shows a real empty state when the client has no submissions', async () => {
    mockCapabilityApi([]);
    renderCapabilities();

    expect(
      await screen.findByText("No submissions recorded against this client's capabilities yet."),
    ).toBeInTheDocument();
  });

  it('renders no invented matches count or evidence tier on a real capability (row 2)', async () => {
    mockCapabilityApi([]);
    renderCapabilities();

    await screen.findByText('Autonomy stack');
    // The CAP_AREAS fixture used to supply these by index, stamping invented
    // provenance onto a real capability record.
    expect(screen.queryByText('Matches')).not.toBeInTheDocument();
    expect(screen.queryByText('SAM.gov')).not.toBeInTheDocument();
  });
});
