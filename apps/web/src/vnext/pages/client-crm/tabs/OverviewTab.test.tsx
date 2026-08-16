import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClientCrmOverviewProto } from './OverviewTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { ClientCrmOverviewModel } from '../../../adapters/legacy/useClientCrmOverviewModel.js';

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
  };
}

describe('ClientCrmOverviewProto', () => {
  it('renders the primary contact as a mailto link when an email exists', () => {
    modelMock.mockReturnValue(baseModel());
    render(
      <ClientCrmOverviewProto
        client={{ ...client, primaryContactEmail: 'stephanie.bonk@overland.ai' }}
      />,
    );

    const link = screen.getByRole('link', { name: 'Stephanie Bonk' });
    expect(link).toHaveAttribute('href', 'mailto:stephanie.bonk@overland.ai');
  });

  it('renders the primary contact as plain text when there is no email on file', () => {
    modelMock.mockReturnValue(baseModel());
    render(<ClientCrmOverviewProto client={client} />);

    expect(screen.queryByRole('link', { name: 'Stephanie Bonk' })).not.toBeInTheDocument();
    expect(screen.getByText('Stephanie Bonk')).toBeInTheDocument();
  });

  it('calls onOpenFederalFootprint when "Open federal footprint" is clicked', () => {
    modelMock.mockReturnValue(baseModel());
    const onOpen = vi.fn();
    render(<ClientCrmOverviewProto client={client} onOpenFederalFootprint={onOpen} />);

    fireEvent.click(screen.getByText('Open federal footprint →'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
