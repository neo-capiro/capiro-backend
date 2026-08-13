import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ClientCrmOverviewView } from './ClientCrmOverview.js';
import type { ClientCrmOverviewModel } from '../../adapters/legacy/useClientCrmOverviewModel.js';

const metric = { kind: 'value' as const, value: 0 };
const ready = { state: 'ready' as const, retry: () => undefined };

const model = {
  profile: {
    name: 'Overland AI',
    initials: 'OA',
    logoUrl: null,
    description: 'Autonomy software.',
    sectorLabel: 'Defense',
    website: null,
    location: null,
    clientSince: null,
  },
  account: {
    accountOwner: null,
    primaryContact: null,
    nextMeeting: null,
    accountTeamAvailable: false,
    accountTeam: [],
    briefState: 'none' as const,
  },
  work: {
    currentStrategies: metric,
    remainingActions: metric,
    upcomingMilestones: metric,
    openRisk: metric,
    readiness: null,
    readinessReason: 'No work completion source is available.',
    nextStep: null,
  },
  intelligence: {
    trackedBills: metric,
    opportunities: metric,
    districts: metric,
    regulatoryMatters: metric,
    signals: [],
    lastRefresh: null,
  },
  attention: [],
  attentionTotal: 0,
  accountStatus: ready,
  workStatus: ready,
  intelligenceStatus: ready,
  attentionStatus: ready,
} satisfies ClientCrmOverviewModel;

describe('ClientCrmOverviewView', () => {
  it('routes both profile edit affordances to the supplied edit action', () => {
    let calls = 0;
    render(
      <MemoryRouter>
        <ClientCrmOverviewView model={model} onEditProfile={() => { calls += 1; }} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(calls).toBe(2);
  });
});
