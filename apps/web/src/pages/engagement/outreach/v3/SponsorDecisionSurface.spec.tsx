import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../../clients/clientTypes.js';
import type { OutreachV3SessionEnvelope } from './contracts.js';
import {
  SponsorDecisionSurface,
  type SponsorDecisionSurfaceProps,
} from './SponsorDecisionSurface.js';

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 2,
    specHash: 'hash-2',
    pendingProposalCount: 0,
    readiness: { goalReady: true, sponsorResolved: false, blockers: ['SPONSOR_UNDECIDED'] },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: 'Protect funding',
        objective: 'Educate staff',
        topic: 'Ground Robotics',
        desiredOutcome: 'Request a meeting',
        ask: { mode: 'explicit', text: 'Request a briefing' },
        whyNow: 'Current mark',
      },
      sponsor: { kind: 'undecided', label: null, clientRefs: [] },
      targeting: { criteria: null, selectedTargetRefs: [], rejectedRecommendationRefs: [] },
      delivery: { pattern: 'undecided', personalization: 'undecided' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: {
        campaignAngle: null,
        tone: null,
        length: 'undecided',
        customLengthInstruction: null,
      },
    },
  };
}

const clients = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Overland AI',
    website: 'https://overland.ai',
    sectorTag: 'Defense autonomy',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Shiftwave',
    website: 'https://shiftwave.co',
    sectorTag: 'Defense technology',
  },
] as Client[];

function props(): SponsorDecisionSurfaceProps {
  return {
    session: session(),
    clients,
    busy: false,
    applyCommands: vi.fn(async () => undefined),
  };
}

describe('SponsorDecisionSurface', () => {
  it('does not infer a client or firm sponsor before an explicit choice', () => {
    render(<SponsorDecisionSurface {...props()} />);
    expect(screen.getByText('Choose one')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /One client/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: /Firm-wide/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText(/No client is required/i)).toBeInTheDocument();
  });

  it('commits no-formal-sponsor without any client reference', async () => {
    const value = props();
    render(<SponsorDecisionSurface {...value} />);
    fireEvent.click(screen.getByRole('button', { name: /No formal sponsor/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sponsor' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      {
        type: 'SET_SPONSOR_SCOPE',
        schemaVersion: 1,
        payload: { kind: 'none', label: null, clientRefs: [] },
      },
    ]);
  });

  it('requires explicit client selection and keeps sponsor separate from targets', async () => {
    const value = props();
    render(<SponsorDecisionSurface {...value} />);
    fireEvent.click(screen.getByRole('button', { name: /One client/i }));
    fireEvent.click(screen.getByRole('button', { name: /Overland AI/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sponsor' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    const commands = vi.mocked(value.applyCommands).mock.calls[0]?.[0] ?? [];
    expect(commands).toEqual([
      {
        type: 'SET_SPONSOR_SCOPE',
        schemaVersion: 1,
        payload: {
          kind: 'client',
          label: null,
          clientRefs: [{ clientId: '11111111-1111-4111-8111-111111111111' }],
        },
      },
    ]);
    expect(JSON.stringify(commands)).not.toMatch(/ADD_TARGET_REFS/);
  });

  it('rejects a multi-client scope until two authorized clients are selected', async () => {
    const value = props();
    render(<SponsorDecisionSurface {...value} />);
    fireEvent.click(screen.getByRole('button', { name: /Several clients/i }));
    fireEvent.click(screen.getByRole('button', { name: /Overland AI/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sponsor' }));

    expect(await screen.findByText('Select at least two authorized clients.')).toBeInTheDocument();
    expect(value.applyCommands).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Shiftwave/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sponsor' }));
    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
  });
});