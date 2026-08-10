import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope } from './contracts.js';
import { CurrentDecisionSurface, type CurrentDecisionSurfaceProps } from './CurrentDecisionSurface.js';

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 1,
    specHash: 'hash-1',
    pendingProposalCount: 1,
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
      sponsor: { kind: 'firm', label: null, clientRefs: [] },
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
      delivery: { pattern: 'uniform_separate', personalization: 'none' },
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
        tone: 'Professional',
        length: 'short',
        customLengthInstruction: null,
      },
    },
  };
}

function props(expectedStateVersion = 1): CurrentDecisionSurfaceProps {
  return {
    session: session(),
    stage: 'strategy',
    clients: [],
    selectedClientId: null,
    busy: false,
    applyCommands: vi.fn(async () => undefined),
    pendingProposals: [
      {
        id: 'proposal-12345678',
        status: 'pending',
        expectedStateVersion,
        commands: [{ type: 'SET_TONE', schemaVersion: 1, payload: { value: 'Direct' } }],
      },
    ],
    proposalBusy: false,
    applyProposal: vi.fn(async () => undefined),
    rejectProposal: vi.fn(async () => undefined),
    searchTargets: vi.fn(async () => undefined),
    targetCandidates: [],
    targetSearchPending: false,
    targetSearchError: null,
    getTargetProfile: vi.fn(async () => undefined),
    targetProfile: undefined,
    targetProfilePending: false,
    coverage: undefined,
    coveragePending: false,
    searchContext: vi.fn(async () => undefined),
    contextCandidates: [],
    contextSearchPending: false,
    contextSearchError: null,
    contextReview: undefined,
    contextReviewPending: false,
    contextReviewError: null,
    strategy: undefined,
    strategyPending: false,
    strategyError: null,
    onFinish: vi.fn(),
    onSelectStage: vi.fn(),
  };
}

describe('CurrentDecisionSurface proposal review', () => {
  it('shows the exact current/proposed values and an inspectable rationale', () => {
    render(<CurrentDecisionSurface {...props()} />);

    expect(screen.getByText('Professional')).toBeInTheDocument();
    expect(screen.getByText('Direct')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Why this proposal?' }));
    expect(screen.getByText('The visible Meri response is the rationale')).toBeInTheDocument();
    expect(screen.getByText(/does not expose or rely on hidden chain-of-thought/i)).toBeInTheDocument();
  });

  it('rejects the proposal before opening its owning stage for manual editing', async () => {
    const value = props();
    render(<CurrentDecisionSurface {...value} />);

    fireEvent.click(screen.getByRole('button', { name: /Edit manually/i }));

    await waitFor(() => expect(value.rejectProposal).toHaveBeenCalledWith(value.pendingProposals[0]));
    expect(value.onSelectStage).toHaveBeenCalledWith('strategy');
  });

  it('never lets a stale proposal Apply or auto-rebase', () => {
    render(<CurrentDecisionSurface {...props(2)} />);

    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByText(/will not auto-rebase/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply 1' })).toBeDisabled();
  });
});