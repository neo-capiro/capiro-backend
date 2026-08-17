import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmOverviewProto } from './OverviewTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { ClientCrmOverviewModel } from '../../../adapters/legacy/useClientCrmOverviewModel.js';

// The advocacy card reads capabilities + submission history for real; the real
// `useApi` pulls in Clerk's `useAuth`, which throws without a ClerkProvider.
const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

const modelMock = vi.hoisted(() => vi.fn());
vi.mock('../../../adapters/legacy/useClientCrmOverviewModel.js', () => ({
  useClientCrmOverviewModel: () => modelMock(),
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

const readyStatus = { state: 'ready' as const, retry: () => {} };

function baseModel(): ClientCrmOverviewModel {
  return {
    profile: {
      name: client.name,
      initials: 'OA',
      logoUrl: null,
      description: null,
      sectorLabel: null,
      website: null,
      location: null,
      clientSince: null,
    },
    account: {
      accountOwner: null,
      primaryContact: 'Stephanie Bonk',
      nextMeeting: null,
      briefState: 'no-meeting',
      accountTeam: [],
      accountTeamAvailable: false,
    },
    accountStatus: readyStatus,
    attention: [],
    attentionTotal: 0,
    attentionStatus: readyStatus,
    work: {
      currentStrategies: { kind: 'value', value: 0 },
      remainingActions: { kind: 'value', value: 0 },
      upcomingMilestones: { kind: 'value', value: 0 },
      openRisk: { kind: 'value', value: 0 },
      readiness: null,
      readinessReason: null,
      nextStep: null,
    },
    workStatus: readyStatus,
    intelligence: {
      trackedBills: { kind: 'value', value: 0 },
      opportunities: { kind: 'value', value: 0 },
      districts: { kind: 'value', value: 0 },
      regulatoryMatters: { kind: 'value', value: 0 },
      signals: [],
      lastRefresh: null,
    },
    intelligenceStatus: readyStatus,
    federalFootprint: {
      ldaSpend: { kind: 'unavailable', reason: 'No LDA match for this client' },
      ldaFilings: { kind: 'unavailable', reason: 'No LDA match for this client' },
      federalAwards: { kind: 'unavailable', reason: 'No federal award match for this client' },
      lobbyingTrajectory: { kind: 'unavailable', reason: 'No lobbying intel match for this client' },
      ready: true,
      registrantsLabel: null,
    },
  };
}

/** The tab now reads real submission history and navigates, so it needs both. */
function renderOverview(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockResolvedValue({ data: [] });
  postMock.mockResolvedValue({ data: {} });
});

describe('ClientCrmOverviewProto', () => {
  it('renders the primary contact as a mailto link when an email exists', () => {
    modelMock.mockReturnValue(baseModel());
    renderOverview(
      <ClientCrmOverviewProto
        client={{ ...client, primaryContactEmail: 'stephanie.bonk@overland.ai' }}
      />,
    );

    const link = screen.getByRole('link', { name: 'Stephanie Bonk' });
    expect(link).toHaveAttribute('href', 'mailto:stephanie.bonk@overland.ai');
  });

  it('renders the primary contact as plain text when there is no email on file', () => {
    modelMock.mockReturnValue(baseModel());
    renderOverview(<ClientCrmOverviewProto client={client} />);

    expect(screen.queryByRole('link', { name: 'Stephanie Bonk' })).not.toBeInTheDocument();
    expect(screen.getByText('Stephanie Bonk')).toBeInTheDocument();
  });

  it('calls onOpenFederalFootprint when "Open federal footprint" is clicked', () => {
    modelMock.mockReturnValue(baseModel());
    const onOpen = vi.fn();
    renderOverview(<ClientCrmOverviewProto client={client} onOpenFederalFootprint={onOpen} />);

    fireEvent.click(screen.getByText('Open federal footprint →'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

/* ── §6.3 Log a submission ("4 New capability" row 6) ─────────────────────── */

const CAPABILITY = { id: 'cap-9', name: 'Autonomy stack', type: 'platform', tags: [], peNumbers: [] };

describe('ClientCrmOverviewProto — advocacy history', () => {
  it('logs a submission against a real capability through the real endpoint', async () => {
    modelMock.mockReturnValue(baseModel());
    getMock.mockImplementation((url: string) => {
      if (url.endsWith('/submission-history')) return Promise.resolve({ data: [] });
      if (url.endsWith('/history')) return Promise.resolve({ data: [] });
      if (url.endsWith('/capabilities')) return Promise.resolve({ data: [CAPABILITY] });
      return Promise.resolve({ data: [] });
    });
    renderOverview(<ClientCrmOverviewProto client={client} />);

    // The action is disabled until a capability exists to attach the row to.
    const log = await screen.findByRole('button', { name: 'Log a submission' });
    await waitFor(() => expect(log).toBeEnabled());
    fireEvent.click(log);
    fireEvent.change(screen.getByLabelText('Fiscal year'), { target: { value: 'FY28' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retrofit line request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log submission' }));

    // Rows hang off a capability — the route 404s without a real capability id.
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/clients/client-1/capabilities/cap-9/history',
        expect.objectContaining({ fiscalYear: 'FY28', title: 'Retrofit line request', outcomeType: 'in_progress' }),
      ),
    );
  });

  it('renders real submissions instead of the ADVOCACY fixture, with no invented evidence class', async () => {
    modelMock.mockReturnValue(baseModel());
    const submissionRows = [
      {
        id: 'sub-9',
        clientId: 'client-1',
        capabilityId: 'cap-9',
        fiscalYear: 'FY28',
        title: 'Retrofit line request',
        meta: 'SASC professional staff',
        outcome: 'Included +$4M',
        outcomeType: 'success',
        notes: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ];
    getMock.mockImplementation((url: string) => {
      if (url.endsWith('/submission-history')) return Promise.resolve({ data: submissionRows });
      if (url.endsWith('/history')) return Promise.resolve({ data: submissionRows });
      if (url.endsWith('/capabilities')) return Promise.resolve({ data: [CAPABILITY] });
      return Promise.resolve({ data: [] });
    });
    renderOverview(<ClientCrmOverviewProto client={client} />);

    expect(await screen.findByText('Retrofit line request')).toBeInTheDocument();
    expect(screen.getByText('1 submission on file')).toBeInTheDocument();
    // The ADVOCACY fixture must not leak through as if real...
    expect(screen.queryByText('Ground robotics / autonomy provisions')).not.toBeInTheDocument();
    // ...and neither must its evidence taxonomy, which has no field anywhere.
    expect(
      screen.queryByText('6 records · 3 public · 2 client-verified · 1 inferred'),
    ).not.toBeInTheDocument();
  });
});
