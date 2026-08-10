import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilityResult,
  OutreachV3SessionEnvelope,
  OutreachV3StrategyData,
} from './contracts.js';
import {
  StrategyDecisionSurface,
  type StrategyDecisionSurfaceProps,
} from './StrategyDecisionSurface.js';

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 7,
    specHash: 'hash-7',
    pendingProposalCount: 0,
    readiness: {
      goalReady: true,
      sponsorResolved: true,
      targetCriteriaReady: true,
      targetsReady: true,
      deliveryReady: true,
      contextReady: true,
      contextEvidenceReady: true,
      strategyReady: false,
      blockers: ['STRATEGY_INCOMPLETE', 'GENERATION_NOT_AVAILABLE'],
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
      delivery: { pattern: 'uniform_separate', personalization: 'light' },
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
      campaignAngle: 'Protect funding through concise staff education',
      tone: 'Direct',
      length: 'short',
      rationale: ['Verified funding movement is the strongest shared fact.'],
      warnings: ['Appropriations coverage is still incomplete.'],
      recommendation: {
        campaignAngle: 'Protect funding through concise staff education',
        tone: 'Direct',
        length: 'short',
        rationale: ['Verified funding movement is the strongest shared fact.'],
        warnings: ['Appropriations coverage is still incomplete.'],
      },
    },
    provenance: [],
  } as CapabilityResult<OutreachV3StrategyData>;
}

function props(): StrategyDecisionSurfaceProps {
  return {
    session: session(),
    busy: false,
    applyCommands: vi.fn(async () => undefined),
    strategy: strategy(),
    strategyPending: false,
    strategyError: null,
  };
}

describe('StrategyDecisionSurface', () => {
  it('shows a deterministic recommendation without applying it', () => {
    const value = props();
    render(<StrategyDecisionSurface {...value} />);

    expect(screen.getByDisplayValue('Protect funding through concise staff education')).toBeInTheDocument();
    expect(screen.getByText('Verified funding movement is the strongest shared fact.')).toBeInTheDocument();
    expect(value.applyCommands).not.toHaveBeenCalled();
  });

  it('requires an explicit complete strategy before committing', async () => {
    const value = props();
    render(<StrategyDecisionSurface {...value} />);
    fireEvent.change(screen.getByLabelText(/^Campaign angle/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm strategy' }));

    expect(await screen.findByText('Campaign angle, tone, and length are required.')).toBeInTheDocument();
    expect(value.applyCommands).not.toHaveBeenCalled();
  });

  it('commits only angle, tone, and length commands', async () => {
    const value = props();
    render(<StrategyDecisionSurface {...value} />);
    fireEvent.change(screen.getByLabelText(/^Campaign angle/i), {
      target: { value: 'Protect funding through evidence-led staff education' },
    });
    fireEvent.change(screen.getByLabelText(/^Tone/i), {
      target: { value: 'Direct and professional' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Short/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm strategy' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    const commands = vi.mocked(value.applyCommands).mock.calls[0]?.[0] ?? [];
    expect(commands.map((entry) => entry.type)).toEqual([
      'SET_CAMPAIGN_ANGLE',
      'SET_TONE',
      'SET_LENGTH',
    ]);
    expect(JSON.stringify(commands)).not.toMatch(/GENERAT|APPROV|PREFLIGHT|SEND/i);
  });
});