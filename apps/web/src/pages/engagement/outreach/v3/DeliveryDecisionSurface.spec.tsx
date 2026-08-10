import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilityResult,
  OutreachV3SessionEnvelope,
  OutreachV3StrategyData,
} from './contracts.js';
import {
  DeliveryDecisionSurface,
  type DeliveryDecisionSurfaceProps,
} from './DeliveryDecisionSurface.js';

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 5,
    specHash: 'hash-5',
    pendingProposalCount: 0,
    readiness: {
      goalReady: true,
      sponsorResolved: true,
      targetCriteriaReady: true,
      targetsReady: true,
      deliveryReady: false,
      blockers: ['DELIVERY_UNDECIDED', 'GENERATION_NOT_AVAILABLE'],
    },
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
      sponsor: { kind: 'none', label: null, clientRefs: [] },
      targeting: {
        criteria: {
          notes: 'HASC staff',
          governmentLevels: ['federal'],
          chambers: ['house'],
          committees: ['HASC'],
          agencies: [],
          states: [],
          relationshipPreference: 'any',
          includeStaff: true,
          includePrincipals: true,
        },
        selectedTargetRefs: [],
        rejectedRecommendationRefs: [],
      },
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

function strategy(): CapabilityResult<OutreachV3StrategyData> {
  return {
    capability: 'recommend_outreach_strategy',
    schemaVersion: 1,
    data: {
      campaignAngle: null,
      tone: 'Direct',
      length: 'short',
      rationale: ['Separate delivery keeps every target independently reviewable.'],
      warnings: [],
      recommendedPattern: 'personalized_separate',
      recommendedPersonalization: 'light',
    },
    provenance: [],
  } as CapabilityResult<OutreachV3StrategyData>;
}

function props(): DeliveryDecisionSurfaceProps {
  return {
    session: session(),
    busy: false,
    applyCommands: vi.fn(async () => undefined),
    strategy: strategy(),
    strategyPending: false,
    strategyError: null,
  };
}

describe('DeliveryDecisionSurface', () => {
  it('shows a recommendation without selecting or committing it', () => {
    const value = props();
    render(<DeliveryDecisionSurface {...value} />);

    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Personalized separate/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(value.applyCommands).not.toHaveBeenCalled();
  });

  it('requires explicit shared-thread recipient-visibility acknowledgement', async () => {
    const value = props();
    render(<DeliveryDecisionSurface {...value} />);

    fireEvent.click(screen.getByRole('button', { name: /Shared thread/i }));
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue with shared thread/i }));

    expect(
      await screen.findByText(/Acknowledge that recipients can see one another/i),
    ).toBeInTheDocument();
    expect(value.applyCommands).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /I understand every recipient can see the other addresses/i,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Continue with shared thread/i }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      {
        type: 'SET_DELIVERY_PATTERN',
        schemaVersion: 1,
        payload: { value: 'shared_thread' },
      },
      {
        type: 'SET_PERSONALIZATION',
        schemaVersion: 1,
        payload: { value: 'none' },
      },
    ]);
  });

  it('disables high personalization for a shared thread', () => {
    render(<DeliveryDecisionSurface {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Shared thread/i }));
    expect(screen.getByRole('button', { name: 'High' })).toBeDisabled();
  });
});