import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OutreachV3Proposal,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  VNextOutreachOperatorWorkspace,
  describeOutreachProposal,
  outreachStepForStage,
} from './VNextOutreachOperatorWorkspace.js';

const useOutreachV3SessionMock = vi.fn();
const innerWorkspaceMock = vi.fn();

vi.mock('../../../pages/engagement/outreach/v3/useOutreachV3Session.js', () => ({
  useOutreachV3Session: (...args: unknown[]) => useOutreachV3SessionMock(...args),
}));

vi.mock('./VNextOutreachWorkspace.js', () => ({
  VNextOutreachWorkspace: (props: Record<string, unknown>) => {
    innerWorkspaceMock(props);
    return <div data-testid="outreach-workbench">Governed workbench</div>;
  },
}));

vi.mock('../../../pages/engagement/outreach/v3/CampaignBrief.js', () => ({
  CampaignBrief: ({ onSelectStage }: { onSelectStage?: (stage: 'context') => void }) => (
    <div data-testid="campaign-brief">
      Canonical campaign brief
      <button type="button" onClick={() => onSelectStage?.('context')}>Open context</button>
    </div>
  ),
}));

vi.mock('../../../pages/engagement/outreach/v3/OutreachConversation.js', () => ({
  OutreachConversation: ({ onSend }: { onSend: (message: string) => Promise<unknown> }) => (
    <div data-testid="outreach-conversation">
      Meri conversation
      <button type="button" onClick={() => void onSend('Update the topic')}>Ask Meri</button>
    </div>
  ),
}));

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 2,
    specHash: 'hash-2',
    pendingProposalCount: 0,
    readiness: {},
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: 'Protect funding',
        objective: 'Keep the program funded',
        topic: 'Ground Robotics',
        desiredOutcome: 'Member support',
        ask: { mode: 'explicit', text: 'Support the program' },
        whyNow: 'Markup is approaching',
      },
      sponsor: { kind: 'firm', label: null, clientRefs: [] },
      targeting: {
        criteria: {
          notes: 'Defense appropriators',
          governmentLevels: ['federal'],
          chambers: ['house'],
          committees: ['House Appropriations'],
          agencies: [],
          states: [],
          relationshipPreference: 'any',
          includeStaff: true,
          includePrincipals: true,
        },
        selectedTargetRefs: [],
        rejectedRecommendationRefs: [],
      },
      delivery: { pattern: 'personalized_separate', personalization: 'light' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: {
        campaignAngle: 'Protect a validated capability',
        tone: 'Direct',
        length: 'short',
        customLengthInstruction: null,
      },
    },
  };
}

function topicProposal(expectedStateVersion = 2): OutreachV3Proposal {
  return {
    id: 'proposal-1',
    status: 'pending',
    expectedStateVersion,
    commands: [
      {
        type: 'SET_TOPIC',
        schemaVersion: 1,
        payload: { value: 'Autonomous Ground Systems' },
      },
    ],
  };
}

function controller(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    session: session(),
    stage: 'targets',
    isBootstrapping: false,
    errorMessage: null,
    reasoningUnavailable: false,
    reasoningErrorMessage: null,
    turns: [],
    sendTurn: vi.fn(async () => undefined),
    sendingTurn: false,
    retryReasoning: vi.fn(async () => undefined),
    pendingProposals: [],
    applyProposal: vi.fn(async () => undefined),
    rejectProposal: vi.fn(async () => undefined),
    proposalBusy: false,
    ...overrides,
  };
}

function renderOperator(onStepChange = vi.fn()) {
  render(
    <VNextOutreachOperatorWorkspace
      sessionId="session-1"
      clients={[]}
      selectedClientId={null}
      integrations={[]}
      step="targets"
      onStepChange={onStepChange}
      onExit={() => undefined}
    />,
  );
  return { onStepChange };
}

describe('VNextOutreachOperatorWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOutreachV3SessionMock.mockReturnValue(controller());
  });

  it('wraps the governed workbench with an always-visible brief and Meri conversation', () => {
    const { onStepChange } = renderOperator();

    expect(screen.getByText('Meri campaign operator')).toBeInTheDocument();
    expect(screen.getByText('Human approval required')).toBeInTheDocument();
    expect(screen.getByTestId('campaign-brief')).toBeInTheDocument();
    expect(screen.getByTestId('outreach-workbench')).toBeInTheDocument();
    expect(screen.getByTestId('outreach-conversation')).toBeInTheDocument();
    expect(useOutreachV3SessionMock).toHaveBeenCalledWith({ sessionId: 'session-1' });

    fireEvent.click(screen.getByRole('button', { name: 'Open context' }));
    expect(onStepChange).toHaveBeenCalledWith('context');
  });

  it('shows a before/after receipt and applies a current proposal only after approval', async () => {
    const proposal = topicProposal();
    const applyProposal = vi.fn(async () => undefined);
    useOutreachV3SessionMock.mockReturnValue(
      controller({ pendingProposals: [proposal], applyProposal }),
    );
    const { onStepChange } = renderOperator();

    expect(screen.getByText('Topic: Ground Robotics')).toBeInTheDocument();
    expect(screen.getByText('Topic: Autonomous Ground Systems')).toBeInTheDocument();
    expect(screen.getByText('Nothing below changes campaign state until you apply it.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));

    await waitFor(() => expect(applyProposal).toHaveBeenCalledWith(proposal));
    expect(onStepChange).toHaveBeenCalledWith('goal');
    expect(await screen.findByText(/Applied · Update goal/)).toBeInTheDocument();
  });

  it('refuses to apply a stale proposal prepared for an older campaign version', () => {
    useOutreachV3SessionMock.mockReturnValue(
      controller({ pendingProposals: [topicProposal(1)] }),
    );
    renderOperator();

    expect(screen.getByRole('button', { name: 'Apply change' })).toBeDisabled();
    expect(screen.getByText(/prepared for V1/)).toBeInTheDocument();
    expect(screen.getByText(/campaign is now V2/)).toBeInTheDocument();
  });

  it('discards a proposal without changing canonical campaign state', async () => {
    const proposal = topicProposal();
    const rejectProposal = vi.fn(async () => undefined);
    useOutreachV3SessionMock.mockReturnValue(
      controller({ pendingProposals: [proposal], rejectProposal }),
    );
    renderOperator();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(rejectProposal).toHaveBeenCalledWith(proposal));
    expect(await screen.findByText(/Discarded · Update goal/)).toBeInTheDocument();
    expect(screen.getByText('Canonical campaign state was not changed.')).toBeInTheDocument();
  });
});

describe('Meri operator proposal descriptions', () => {
  it('maps canonical reasoning stages to the live vNext workbench', () => {
    expect(outreachStepForStage('sponsor')).toBe('goal');
    expect(outreachStepForStage('context')).toBe('context');
    expect(outreachStepForStage('ready_for_generation')).toBe('drafts');
  });

  it('describes compound changes against the current canonical spec', () => {
    const current = session();
    const preview = describeOutreachProposal(
      {
        id: 'proposal-2',
        status: 'pending',
        expectedStateVersion: 2,
        commands: [
          { type: 'SET_DELIVERY_PATTERN', schemaVersion: 1, payload: { value: 'uniform_separate' } },
          { type: 'SET_PERSONALIZATION', schemaVersion: 1, payload: { value: 'none' } },
        ],
      },
      current.spec,
      current.currentStateVersion,
    );

    expect(preview.title).toBe('Update delivery');
    expect(preview.before).toContain('Delivery: personalized separate');
    expect(preview.after).toContain('Delivery: uniform separate');
    expect(preview.after).toContain('Personalization: none');
  });
});
