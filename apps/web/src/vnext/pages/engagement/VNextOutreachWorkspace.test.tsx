import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VNextOutreachWorkspace,
  outreachChatStateLabel,
  type EngagementOutreachStep,
} from './VNextOutreachWorkspace.js';
import type { OutreachV3SessionEnvelope } from '../../../pages/engagement/outreach/v3/contracts.js';

/**
 * VNextOutreachWorkspace has a very large data-dependency surface (a full
 * planning-session controller plus half a dozen react-query calls of its
 * own). Following the same convention VNextMeetingsWorkspace.test.tsx already
 * uses for its own heavy hook: mock useOutreachV3Session wholesale and mock
 * useApi generically, keeping `stage` away from 'ready_for_generation' so
 * every OTHER query this component runs directly (plan/approach/generationJob
 * /intent) stays disabled and only the always-on `drafts` list query
 * actually fires, resolving to an empty array via the generic `get` mock.
 * This isolates the chrome-level fixes (chat header pill, model-outage
 * banner, accordion vocabulary, step-dot rail) from the full planning flow.
 */
const useOutreachV3SessionMock = vi.fn();
vi.mock('../../../pages/engagement/outreach/v3/useOutreachV3Session.js', () => ({
  useOutreachV3Session: (...args: unknown[]) => useOutreachV3SessionMock(...args),
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: () => Promise.resolve({ data: [] }),
    post: () => Promise.resolve({ data: {} }),
  }),
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
        objective: null,
        topic: 'Ground Robotics',
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
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

function baseController(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    session: session(),
    stage: 'targets',
    isBootstrapping: false,
    error: null,
    errorMessage: null,
    lifecycleErrorMessage: null,
    applyCommands: vi.fn(async () => undefined),
    applyingCommands: false,
    reasoningUnavailable: false,
    reasoningErrorMessage: null,
    retryReasoning: vi.fn(),
    turns: [],
    sendTurn: vi.fn(async () => undefined),
    sendingTurn: false,
    pendingProposals: [],
    applyProposal: vi.fn(async () => undefined),
    rejectProposal: vi.fn(async () => undefined),
    proposalBusy: false,
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
    startNewSession: vi.fn(),
    ...overrides,
  };
}

function renderWorkspace(step: EngagementOutreachStep = 'targets') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <VNextOutreachWorkspace
          clients={[]}
          selectedClientId={null}
          integrations={[]}
          step={step}
          onStepChange={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextOutreachWorkspace', () => {
  beforeEach(() => {
    useOutreachV3SessionMock.mockReset();
    useOutreachV3SessionMock.mockReturnValue(baseController());
  });

  describe('chat header state pill (item 1a)', () => {
    it('resolves Sent / Drafts / step name in that priority, as a plain testable function', () => {
      expect(outreachChatStateLabel('targets', true, true)).toBe('Sent');
      expect(outreachChatStateLabel('targets', true, false)).toBe('Sent');
      expect(outreachChatStateLabel('targets', false, true)).toBe('Drafts');
      expect(outreachChatStateLabel('targets', false, false)).toBe('TARGETS');
    });

    it('shows the raw step name today when no intent or approach exists yet', () => {
      renderWorkspace('targets');
      expect(screen.getByText('TARGETS')).toBeInTheDocument();
    });
  });

  describe('model-outage banner (item 1b)', () => {
    it('renders "Retry Meri" as a proper pill button, not a plain text-style button', () => {
      const retryReasoning = vi.fn();
      useOutreachV3SessionMock.mockReturnValue(
        baseController({
          reasoningUnavailable: true,
          reasoningErrorMessage: 'The model provider is unavailable.',
          retryReasoning,
        }),
      );
      renderWorkspace('targets');

      const retry = screen.getByRole('button', { name: 'Retry Meri' });
      expect(retry).toHaveClass('uui-model-outage__retry');

      fireEvent.click(retry);
      expect(retryReasoning).toHaveBeenCalledTimes(1);
    });
  });

  describe('composer send button (item 1c)', () => {
    it('uses the shared primary gradient treatment instead of a flat fill', () => {
      renderWorkspace('targets');
      expect(screen.getByRole('button', { name: 'Send to Meri' })).toHaveClass('uui-button--primary');
    });
  });

  describe('step-dot rail (item 2)', () => {
    it('renders one initial per step, "Dr" (not "D") for Drafts to disambiguate from Delivery', () => {
      const { container } = renderWorkspace('targets');
      const dotRail = container.querySelector('.uui-outreach-step-dots')!;
      const draftsDot = within(dotRail as HTMLElement).getByText('Dr');
      expect(draftsDot.tagName).toBe('BUTTON');
      expect(draftsDot).toHaveAttribute('aria-label', 'Drafts');
      // The full label strip still renders its own separate "Drafts" button
      // — this is an additional fallback rail, not a replacement of the
      // strip (both share the same accessible name by design).
      const fullStrip = container.querySelector('.uui-outreach-step-strip')!;
      expect(within(fullStrip as HTMLElement).getByRole('button', { name: 'Drafts' })).toBeInTheDocument();
    });
  });

  describe('accordion status vocabulary (item 3)', () => {
    it('shows Complete for answered sections, In progress for the current one, and Locked for not-yet-reached ones', () => {
      // stage='targets', no drafts yet: Goal precedes the current planning
      // stage (answered/complete), Targets is the open/current step, Send has
      // not been reached. Exercises all three states in one render.
      const { container } = renderWorkspace('targets');
      const sectionHeading = (label: string) =>
        Array.from(container.querySelectorAll('.uui-outreach-section__header strong')).find(
          (node) => node.textContent === label,
        )!;

      const goalSection = sectionHeading('Goal').closest('section')!;
      const targetsSection = sectionHeading('Targets').closest('section')!;
      const sendSection = sectionHeading('Send').closest('section')!;

      expect(within(goalSection).getByText('Complete')).toBeInTheDocument();
      expect(within(goalSection).queryByText('Locked')).not.toBeInTheDocument();

      expect(within(targetsSection).getByText('In progress')).toBeInTheDocument();

      // This is the actual bug fix: previously said "Waiting" here (backwards
      // — the mockup's vocabulary is LOCKED for not-yet-reachable sections).
      expect(within(sendSection).getByText('Locked')).toBeInTheDocument();
      expect(within(sendSection).queryByText('Waiting')).not.toBeInTheDocument();
    });
  });
});
