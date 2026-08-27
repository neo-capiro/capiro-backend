import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VNextOutreachWorkspace,
  attachmentTone,
  buildHonestPreflightRows,
  draftStrategyHeadline,
  outreachCampaignHeading,
  type EngagementOutreachStep,
} from './VNextOutreachWorkspace.js';
import { humanizeBlockerCode } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import type { OutreachV3SessionEnvelope } from '../../../pages/engagement/outreach/v3/contracts.js';
import type { OutreachV3NamedPreflightCheck } from './engagement-api.js';

/**
 * VNextOutreachWorkspace has a very large data-dependency surface (a full
 * planning-session controller plus half a dozen react-query calls of its
 * own). Following the same convention VNextMeetingsWorkspace.test.tsx already
 * uses for its own heavy hook: mock useOutreachV3Session wholesale and mock
 * useApi generically, keeping `stage` away from 'ready_for_generation' so
 * every OTHER query this component runs directly (plan/approach/generationJob
 * /intent) stays disabled and only the always-on `drafts` list query
 * actually fires, resolving to an empty array via the generic `get` mock.
 * This isolates the chrome-level fixes (crumb header, accordion vocabulary,
 * step-dot rail) from the full planning flow.
 *
 * The Send-flow tests below (held-out fix, action-bar relocation) need
 * realistic, request-shaped responses for several endpoints (plan, drafts,
 * settings, and critically a STATEFUL preflight response that reacts to
 * excludedGenerationKeys/acknowledgeHeldOut). `onGet`/`onPost` register
 * per-test fixture handlers matched by URL suffix; anything unregistered
 * falls back to the exact same `[]`/`{}` default the chrome tests above
 * already rely on, so those tests are unaffected.
 */
const useOutreachV3SessionMock = vi.fn();
// Only the HOOK is stubbed. The module also exports pure readiness helpers
// (outreachV3PlanningBlockerCodes) that the workspace now calls directly, so
// the real exports must be preserved — replacing the module wholesale left
// that helper undefined at runtime.
vi.mock('../../../pages/engagement/outreach/v3/useOutreachV3Session.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../pages/engagement/outreach/v3/useOutreachV3Session.js')
  >()),
  useOutreachV3Session: (...args: unknown[]) => useOutreachV3SessionMock(...args),
}));

const { getHandlers, postHandlers, resetHandlers, onGet, onPost } = vi.hoisted(() => {
  const getHandlers: Array<{ suffix: string; handler: (url: string) => unknown }> = [];
  const postHandlers: Array<{
    suffix: string;
    handler: (url: string, body?: unknown) => unknown;
  }> = [];
  return {
    getHandlers,
    postHandlers,
    resetHandlers: () => {
      getHandlers.length = 0;
      postHandlers.length = 0;
    },
    onGet: (suffix: string, handler: (url: string) => unknown) => {
      getHandlers.push({ suffix, handler });
    },
    onPost: (suffix: string, handler: (url: string, body?: unknown) => unknown) => {
      postHandlers.push({ suffix, handler });
    },
  };
});

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string) => {
      const found = getHandlers.find((entry) => url.endsWith(entry.suffix));
      return Promise.resolve({ data: found ? found.handler(url) : [] });
    },
    post: (url: string, body?: unknown) => {
      const found = postHandlers.find((entry) => url.endsWith(entry.suffix));
      return Promise.resolve({ data: found ? found.handler(url, body) : {} });
    },
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
    startingNewSession: false,
    ownedSessions: [],
    sessionsLoading: false,
    sessionsError: null,
    refreshSessions: vi.fn(),
    openSession: vi.fn(),
    archiveSessionById: vi.fn(),
    ...overrides,
  };
}

function renderWorkspace(step: EngagementOutreachStep = 'targets') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <VNextOutreachWorkspace
          sessionId="session-1"
          clients={[]}
          selectedClientId={null}
          integrations={[]}
          step={step}
          onStepChange={() => undefined}
          onExit={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Fixtures for the Send-flow tests (held-out fix + action-bar relocation).
// Four generation keys, one of which (r4) is always ineligible
// (a real RECIPIENT_EMAIL_MISSING blocker) unless explicitly held out AND
// acknowledged — this is a simplified but behaviorally-faithful stand-in for
// apps/api's evaluateOutreachV3Preflight + buildNamedChecks: same shape,
// same "one ineligible recipient blocks everyone" bug being fixed, same
// "held-out must be acknowledged before eligible" contract.
// ---------------------------------------------------------------------------
const PLAN_KEYS = ['r1', 'r2', 'r3', 'r4'] as const;

function draftFixture(key: string, recipientKey: string) {
  return {
    id: `artifact-${key}`,
    outreachRecordId: 'session-1',
    generationKey: key,
    recipientKey,
    audienceKind: 'individual',
    currentVersion: 1,
    current: {
      id: `version-${key}`,
      artifactId: `artifact-${key}`,
      outreachRecordId: 'session-1',
      version: 1,
      sourceVersionId: null,
      generationKey: key,
      recipientKey,
      audienceKind: 'individual',
      subject: `Subject ${key}`,
      body: `Body ${key}`,
      contentHash: 'hash',
      generationStatus: 'succeeded',
      auditStatus: 'passed',
      approvalStatus: 'approved',
      auditDecision: null,
      auditChecks: [],
      reviewRequestId: null,
      provider: null,
      model: null,
      promptSpecVersion: null,
      sendable: true,
      createdAt: new Date().toISOString(),
    },
    history: [],
  };
}

const DRAFTS_FIXTURE = [
  draftFixture('r1', 'Recipient One'),
  draftFixture('r2', 'Recipient Two'),
  draftFixture('r3', 'Recipient Three'),
  draftFixture('r4', 'Blocked Recipient'),
];

const PLAN_FIXTURE = {
  planVersion: 'outreach_v3_generation_plan_v1',
  sessionId: 'session-1',
  stateVersion: 1,
  specHash: 'spec-hash',
  planHash: 'plan-hash',
  deliveryPattern: 'personalized_separate' as const,
  slots: PLAN_KEYS.map((key) => ({
    generationKey: key,
    audienceKind: 'individual' as const,
    recipients: [{ targetKey: key, label: key, email: `${key}@example.test` }],
  })),
  representativeSampleKeys: ['r1'],
  eligible: true,
  blockers: [],
};

const SETTINGS_FIXTURE = {
  schemaVersion: 'outreach_v3_send_settings_v1',
  senderConnectionId: 'conn-1',
  appendSignature: true,
  attachmentIds: [],
  settingsHash: 'settings-hash',
  stateVersion: 1,
  updatedAt: new Date().toISOString(),
};

function namedCheckFixture(
  key: string,
  label: string,
  detail: string,
  state: 'pass' | 'review' | 'blocked',
): OutreachV3NamedPreflightCheck {
  return { key, label, detail, state };
}

/**
 * Simplified but behaviorally-faithful stand-in for the real backend's
 * evaluateOutreachV3Preflight + buildNamedChecks (see
 * apps/api/src/outreach-v3/preflight/outreach-v3-preflight.ts and
 * apps/api/src/outreach-v3/send/outreach-v3-send.service.ts): r4 is always
 * ineligible (RECIPIENT_EMAIL_MISSING) unless excluded, and held-out
 * recipients require acknowledgeHeldOut:true before `eligible` can be true.
 */
function preflightFixture(body: { excludedGenerationKeys?: string[]; acknowledgeHeldOut?: boolean }) {
  const requestedExclusions = new Set(
    (body?.excludedGenerationKeys ?? []).filter((key) => (PLAN_KEYS as readonly string[]).includes(key)),
  );
  const required = PLAN_KEYS.filter((key) => !requestedExclusions.has(key));
  const draftResults = required.map((key) => {
    const blocked = key === 'r4';
    return {
      generationKey: key,
      versionId: blocked ? null : `version-${key}`,
      eligible: !blocked,
      blockers: blocked ? ['RECIPIENT_EMAIL_MISSING'] : [],
      recipientEmails: blocked ? [] : [`${key}@example.test`],
    };
  });
  const allRequiredEligible = draftResults.every((result) => result.eligible);
  const heldOutAcknowledged = requestedExclusions.size === 0 || body?.acknowledgeHeldOut === true;
  const eligible = allRequiredEligible && heldOutAcknowledged;
  const draftVersionIds = draftResults
    .filter((result) => result.eligible)
    .map((result) => result.versionId as string);
  return {
    eligible,
    testMode: false,
    blockers: [
      ...(allRequiredEligible ? [] : ['RECIPIENT_EMAIL_MISSING']),
      ...(heldOutAcknowledged ? [] : ['HELD_RECIPIENTS_NOT_ACKNOWLEDGED']),
    ],
    checks: [
      namedCheckFixture('campaign', 'Campaign plan', 'Current plan is generation-eligible.', 'pass'),
      namedCheckFixture('scope', 'Sponsor scope', 'Sponsor scope permits external outreach.', 'pass'),
      namedCheckFixture('sender', 'Sender', 'A connected sender is selected.', 'pass'),
      namedCheckFixture(
        'sender-auth',
        'Sender authorization',
        'Sender ownership was verified server-side.',
        'pass',
      ),
      namedCheckFixture('signature', 'Signature', 'Your current signature will be appended.', 'pass'),
      namedCheckFixture('attachments', 'Attachments', 'Every selected attachment is ready.', 'pass'),
      namedCheckFixture('drafts', 'Draft coverage', 'Every required slot has one current draft.', 'pass'),
      namedCheckFixture('versions', 'Exact versions', 'Exact immutable versions are selected.', 'pass'),
      namedCheckFixture('approval', 'Author approval', 'Exact current versions are approved.', 'pass'),
      namedCheckFixture(
        'audit',
        'Assurance review',
        'All selected versions passed the send assurance boundary.',
        'pass',
      ),
      namedCheckFixture(
        'recipients',
        'Recipient snapshots',
        'Recipient snapshots match the current target set.',
        'pass',
      ),
      namedCheckFixture(
        'emails',
        'Recipient email',
        allRequiredEligible
          ? 'Recipient addresses are present and unique.'
          : 'Fix missing or duplicate recipient addresses.',
        allRequiredEligible ? 'pass' : 'blocked',
      ),
      namedCheckFixture(
        'held',
        'Held-out recipients',
        heldOutAcknowledged
          ? 'Any held-out recipients were explicitly acknowledged.'
          : 'Acknowledge held-out recipients before sending.',
        heldOutAcknowledged ? 'pass' : 'blocked',
      ),
      namedCheckFixture(
        'intent',
        'Send intent',
        eligible
          ? 'A durable intent will be committed before the provider call.'
          : 'The send intent cannot be created until every blocker is cleared.',
        eligible ? 'pass' : 'review',
      ),
    ],
    draftVersionIds,
    excludedGenerationKeys: [...requestedExclusions].sort(),
    heldOutAcknowledged,
    plan: PLAN_FIXTURE,
    settings: SETTINGS_FIXTURE,
    draftResults,
  };
}

describe('VNextOutreachWorkspace', () => {
  beforeEach(() => {
    useOutreachV3SessionMock.mockReset();
    useOutreachV3SessionMock.mockReturnValue(baseController());
    resetHandlers();
  });

  describe('the Meri conversation pane is gone (UX adjustment)', () => {
    it('renders no chat rail, transcript or composer', () => {
      const { container } = renderWorkspace('targets');
      expect(container.querySelector('.uui-outreach-chat')).toBeNull();
      expect(container.querySelector('.uui-outreach-transcript')).toBeNull();
      expect(screen.queryByLabelText('Message Meri')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send to Meri' })).not.toBeInTheDocument();
    });

    it('does not render the Meri outage banner even when reasoning is unavailable', () => {
      // The controller still reports the outage. Nothing in Outreach V3 has a
      // reason to surface it now that there is no conversation to be down.
      useOutreachV3SessionMock.mockReturnValue(
        baseController({
          reasoningUnavailable: true,
          reasoningErrorMessage: 'The model provider is unavailable.',
        }),
      );
      const { container } = renderWorkspace('targets');
      expect(container.querySelector('.uui-model-outage')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry Meri' })).not.toBeInTheDocument();
      expect(screen.queryByText('The model provider is unavailable.')).not.toBeInTheDocument();
    });
  });

  describe('the campaigns dropdown is gone (UX adjustment)', () => {
    it('renders no in-builder campaign list, even when the controller has other sessions', () => {
      const openSession = vi.fn();
      useOutreachV3SessionMock.mockReturnValue(
        baseController({
          ownedSessions: [
            { id: 'session-2', title: 'FY27 mark-up', status: 'active', currentStateVersion: 4 },
          ],
          openSession,
        }),
      );
      const { container } = renderWorkspace('targets');
      expect(container.querySelector('.uui-campaign-list')).toBeNull();
      expect(screen.queryByLabelText('Your campaigns')).not.toBeInTheDocument();
      expect(screen.queryByText('FY27 mark-up')).not.toBeInTheDocument();
      expect(openSession).not.toHaveBeenCalled();
    });
  });

  describe('builder identity and exit', () => {
    it('pins the hook to the routed campaign instead of letting it self-create one', () => {
      renderWorkspace('targets');
      expect(useOutreachV3SessionMock).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('offers a way back to the campaign list', () => {
      const onExit = vi.fn();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <VNextOutreachWorkspace
              sessionId="session-1"
              clients={[]}
              selectedClientId={null}
              integrations={[]}
              step="targets"
              onStepChange={() => undefined}
              onExit={onExit}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Back to campaigns' }));
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('titles the builder from the spec topic, never the always-identical session title', () => {
      expect(
        outreachCampaignHeading({
          session: { id: 's', title: 'New outreach campaign' },
          spec: { goal: { topic: 'FY27 ground robotics' } },
        } as never),
      ).toBe('FY27 ground robotics');
      expect(
        outreachCampaignHeading({
          session: { id: 's', title: 'New outreach campaign' },
          spec: { goal: { topic: null } },
        } as never),
      ).toBe('New outreach campaign');
      expect(outreachCampaignHeading(null)).toBe('Untitled campaign');
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

  describe('optional Examples step (few-shot samples)', () => {
    it('sits between Context and Drafts, and renumbers the steps after it', () => {
      const { container } = renderWorkspace('targets');
      const labels = Array.from(
        container.querySelectorAll('.uui-outreach-step-strip button'),
      ).map((node) => node.textContent);
      expect(labels).toEqual([
        'Goal',
        'Targets',
        'Delivery',
        'Context',
        'Examples',
        'Drafts',
        'Send',
      ]);

      const numbers = Array.from(
        container.querySelectorAll('.uui-outreach-section__number'),
      ).map((node) => node.textContent);
      expect(numbers).toEqual(['01', '02', '03', '04', '05', '06', '07']);
    });

    it('is reachable from the very first planning stage — it never blocks or is blocked', () => {
      const { container } = renderWorkspace('goal');
      const strip = container.querySelector('.uui-outreach-step-strip')!;
      const examples = within(strip as HTMLElement).getByRole('button', { name: 'Examples' });
      expect(examples).toHaveProperty('disabled', false);
    });

    it('reads "no examples added" rather than Complete when the campaign has none', () => {
      // The bug this pins: an optional step is passed by the planning stage the
      // moment Context is done, so the generic "index < planningIndex" rule would
      // label it Complete and tell the user they had supplied examples.
      const { container } = renderWorkspace('drafts');
      const heading = Array.from(
        container.querySelectorAll('.uui-outreach-section__header strong'),
      ).find((node) => node.textContent === 'Examples')!;
      const section = heading.closest('section')!;
      expect(within(section).getByText('Optional — no examples added')).toBeInTheDocument();
      expect(within(section).queryByText('Complete')).not.toBeInTheDocument();
    });

    it('renders the examples surface, not a decision surface, in its own section', () => {
      const { container } = renderWorkspace('samples');
      const heading = Array.from(
        container.querySelectorAll('.uui-outreach-section__header strong'),
      ).find((node) => node.textContent === 'Examples')!;
      const section = heading.closest('section')!;
      expect(within(section).getByText('Show Meri how you write')).toBeInTheDocument();
    });

    it('gets its own dot on the narrow rail without colliding with Delivery or Drafts', () => {
      const { container } = renderWorkspace('targets');
      const dotRail = container.querySelector('.uui-outreach-step-dots')! as HTMLElement;
      expect(within(dotRail).getByText('Ex')).toHaveAttribute('aria-label', 'Examples');
      expect(within(dotRail).getByText('D')).toHaveAttribute('aria-label', 'Delivery');
      expect(within(dotRail).getByText('Dr')).toHaveAttribute('aria-label', 'Drafts');
    });
  });

  describe('accordion status vocabulary (item 3)', () => {
    const PLANNING_LABELS = ['Goal', 'Targets', 'Delivery', 'Context'] as const;

    const sectionOf = (container: HTMLElement, label: string) =>
      Array.from(container.querySelectorAll('.uui-outreach-section__header strong'))
        .find((node) => node.textContent === label)!
        .closest('section')! as HTMLElement;

    /** Every planning decision actually made, per the canonical readiness contract. */
    function readySession(): OutreachV3SessionEnvelope {
      const envelope = session();
      envelope.readiness = {
        goalReady: true,
        sponsorResolved: true,
        targetCriteriaReady: true,
        targetsReady: true,
        deliveryReady: true,
        contextReady: true,
        contextEvidenceReady: true,
        strategyReady: false,
        blockers: [],
      };
      return envelope;
    }

    it('reads Locked for steps that are not yet reachable', () => {
      const { container } = renderWorkspace('targets');
      const sendSection = sectionOf(container, 'Send');
      expect(within(sendSection).getByText('Locked')).toBeInTheDocument();
      expect(within(sendSection).queryByText('Waiting')).not.toBeInTheDocument();
    });

    it('never claims Complete for a step whose required decisions are still missing', () => {
      // THE defect this pins. Status used to be derived from position
      // (`index < reachedIndex`), and because reachedIndex is floored at 5
      // (Drafts is always reachable) every planning step read "Complete" from
      // the first render. Observed live on os.capiro.ai: Targets and Context
      // both displayed COMPLETE while TARGET_CRITERIA_MISSING and
      // CONTEXT_NOT_REVIEWED were the only two blockers preventing generation,
      // so the campaign silently could not advance and nothing pointed at the
      // cause. The default fixture spec is empty, so none of these are done.
      const { container } = renderWorkspace('drafts');
      for (const label of PLANNING_LABELS) {
        const section = sectionOf(container, label);
        expect(
          within(section).queryByText('Complete'),
          `${label} must not read Complete while incomplete`,
        ).not.toBeInTheDocument();
        expect(within(section).getByText('In progress')).toBeInTheDocument();
      }
    });

    it("reads Complete once the step's own decisions are satisfied", () => {
      useOutreachV3SessionMock.mockReturnValue(baseController({ session: readySession() }));
      const { container } = renderWorkspace('drafts');
      for (const label of PLANNING_LABELS) {
        expect(
          within(sectionOf(container, label)).getByText('Complete'),
          `${label} should read Complete`,
        ).toBeInTheDocument();
      }
    });

    it('keeps a finished step reading Complete even while it is the open step', () => {
      // Status used to also depend on `candidate.key === step`, so merely
      // expanding a finished section flipped its label Complete -> In progress.
      useOutreachV3SessionMock.mockReturnValue(baseController({ session: readySession() }));
      const { container } = renderWorkspace('goal');
      const goalSection = sectionOf(container, 'Goal');
      expect(within(goalSection).getByText('Complete')).toBeInTheDocument();
      expect(within(goalSection).queryByText('In progress')).not.toBeInTheDocument();
    });

    it('shows the incomplete summary instead of hiding it behind a false Complete', () => {
      // "0 governed sources" is exactly the evidence that Context is not done,
      // and it used to be suppressed precisely when the badge wrongly claimed
      // Complete (the summary only rendered for state === 'locked').
      const { container } = renderWorkspace('drafts');
      const contextSection = sectionOf(container, 'Context');
      expect(
        within(contextSection).getByText('0 governed sources · 0 excluded'),
      ).toBeInTheDocument();
    });
  });

  describe('blocking-work notice', () => {
    it('names the real readiness blockers and offers a jump to the step that clears each', () => {
      useOutreachV3SessionMock.mockReturnValue(
        baseController({
          session: {
            ...session(),
            readiness: {
              blockers: [
                'TARGET_CRITERIA_MISSING',
                'CONTEXT_NOT_REVIEWED',
                'DRAFTS_NOT_AVAILABLE',
              ],
            },
          },
        }),
      );
      const { container } = renderWorkspace('targets');
      const notice = container.querySelector('.uui-outreach-blocking')! as HTMLElement;

      expect(
        within(notice).getByText('Save the audience criteria for this campaign.'),
      ).toBeInTheDocument();
      expect(
        within(notice).getByText('Accept at least one governed context source.'),
      ).toBeInTheDocument();
      expect(within(notice).getByRole('button', { name: 'Go to Targets' })).toBeInTheDocument();
      expect(within(notice).getByRole('button', { name: 'Go to Context' })).toBeInTheDocument();

      // Availability blockers are deliberately filtered out: every real gate
      // already ignores them (planningBlockers), so surfacing one would tell
      // the user to fix something that is not blocking and cannot be acted on.
      expect(within(notice).queryByText(/drafts not available/i)).not.toBeInTheDocument();
    });

    it('renders nothing once no planning blocker remains', () => {
      useOutreachV3SessionMock.mockReturnValue(
        baseController({
          session: {
            ...session(),
            readiness: { blockers: ['GENERATION_NOT_AVAILABLE', 'PREFLIGHT_NOT_AVAILABLE'] },
          },
        }),
      );
      const { container } = renderWorkspace('targets');
      expect(container.querySelector('.uui-outreach-blocking')).toBeNull();
    });
  });

  describe('draftStrategyHeadline (Drafts item 1 — real strategy headline)', () => {
    it('uses the real, already-committed campaign angle and tone, never the old hardcoded placeholder', () => {
      const withStrategy = session();
      withStrategy.spec.strategy.campaignAngle =
        'Protect funding through concise, evidence-led staff education';
      withStrategy.spec.strategy.tone = 'Direct and professional';

      const result = draftStrategyHeadline(withStrategy);

      expect(result.headline).toBe(
        'Protect funding through concise, evidence-led staff education',
      );
      expect(result.headline).not.toMatch(/lead with what changed/i);
      expect(result.sub).toMatch(/Direct and professional/);
    });

    it('derives from goal + delivery pattern rather than fabricating campaign-specific copy when no angle is set yet', () => {
      const withoutStrategy = session();
      withoutStrategy.spec.goal.topic = 'Ground Robotics';
      withoutStrategy.spec.delivery.pattern = 'personalized_separate';

      const result = draftStrategyHeadline(withoutStrategy);

      expect(result.headline).toContain('Ground Robotics');
      expect(result.headline).toContain('personalized separate');
      expect(result.headline).not.toMatch(/lead with what changed/i);
      expect(result.sub).toMatch(/no campaign angle has been confirmed/i);
    });
  });

  describe('humanizeBlockerCode', () => {
    it('maps known backend blocker codes to short human text', () => {
      expect(humanizeBlockerCode('RECIPIENT_EMAIL_MISSING')).toBe(
        'Recipient email is missing or malformed',
      );
      expect(humanizeBlockerCode('DRAFT_HELD')).toBe('Draft is held for review');
    });

    it('falls back to sentence-cased text for an unmapped code instead of throwing or going blank', () => {
      expect(humanizeBlockerCode('SOME_NEW_FUTURE_CODE')).toBe('Some New Future Code');
    });
  });

  describe('attachmentTone (Drafts item 3 — attachment state marker)', () => {
    const base = {
      id: 'a1',
      fileName: 'exhibit.pdf',
      contentType: 'application/pdf',
      byteSize: 100,
    };

    it('flags blocked lifecycle or a threat scan verdict as error, never as ready', () => {
      expect(
        attachmentTone({ ...base, lifecycleStatus: 'blocked', scanStatus: null }).tone,
      ).toBe('error');
      expect(
        attachmentTone({ ...base, lifecycleStatus: 'ready', scanStatus: 'threat' }).tone,
      ).toBe('error');
    });

    it('flags quarantined, pending, or never-scanned attachments as warning (processing) — never ready', () => {
      expect(
        attachmentTone({ ...base, lifecycleStatus: 'quarantined', scanStatus: null }).tone,
      ).toBe('warning');
      expect(
        attachmentTone({ ...base, lifecycleStatus: 'ready', scanStatus: 'pending' }).tone,
      ).toBe('warning');
    });

    it('only calls a clean-scanned, ready attachment "Ready"', () => {
      expect(
        attachmentTone({ ...base, lifecycleStatus: 'ready', scanStatus: 'clean' }),
      ).toEqual({ tone: 'navy', label: 'Ready' });
    });

    it('is neutral/unknown for a chip whose attachment object has not resolved yet', () => {
      expect(attachmentTone(undefined).tone).toBe('neutral');
    });
  });

  describe('buildHonestPreflightRows (Send item C — the honest 14-row preflight table)', () => {
    const ALL_REAL_CHECKS: OutreachV3NamedPreflightCheck[] = [
      namedCheckFixture('campaign', 'Campaign plan', 'ok', 'pass'),
      namedCheckFixture('scope', 'Sponsor scope', 'ok', 'pass'),
      namedCheckFixture('sender', 'Sender', 'ok', 'pass'),
      namedCheckFixture('sender-auth', 'Sender authorization', 'ok', 'pass'),
      namedCheckFixture('signature', 'Signature', 'ok', 'pass'),
      namedCheckFixture('attachments', 'Attachments', 'ok', 'pass'),
      namedCheckFixture('drafts', 'Draft coverage', 'ok', 'pass'),
      namedCheckFixture(
        'versions',
        'Exact versions',
        'A draft changed after generation or approval.',
        'blocked',
      ),
      namedCheckFixture('approval', 'Author approval', 'ok', 'pass'),
      namedCheckFixture('audit', 'Assurance review', 'ok', 'pass'),
      namedCheckFixture('recipients', 'Recipient snapshots', 'ok', 'pass'),
      namedCheckFixture(
        'emails',
        'Recipient email',
        'Fix missing or duplicate recipient addresses.',
        'blocked',
      ),
      namedCheckFixture('held', 'Held-out recipients', 'ok', 'pass'),
      namedCheckFixture('intent', 'Send intent', 'ok', 'review'),
    ];

    it('places the mockup row vocabulary at the documented row numbers', () => {
      const rows = buildHonestPreflightRows(ALL_REAL_CHECKS);
      // 1-indexed mockup row numbers from the phase brief -> 0-indexed here.
      // The three placeholder rows (Role policy, Shared visibility, Context checks)
      // were removed — only real server checks remain.
      expect(rows[1]!.label).toBe('Exact draft versions'); // row 2
      expect(rows[5]!.label).toBe('Stale or dirty draft'); // row 6
      expect(rows[7]!.label).toBe('Recipient email'); // was row 9, shifted after Role policy removed
      expect(rows[8]!.label).toBe('Duplicate recipients'); // was row 10, shifted
      expect(rows[9]!.label).toBe('Draft coverage'); // was row 12, shifted after Shared visibility removed
    });

    it('gives both "versions" rows the exact same live state/detail from the one real check — never two independent booleans', () => {
      const rows = buildHonestPreflightRows(ALL_REAL_CHECKS);
      const exact = rows.find((row) => row.label === 'Exact draft versions')!;
      const stale = rows.find((row) => row.label === 'Stale or dirty draft')!;
      expect(exact.state).toBe('blocked');
      expect(stale.state).toBe('blocked');
      expect(exact.detail).toBe(stale.detail);
    });

    it('gives both "emails" rows the same live state, and never overclaims a verification step that doesn\'t exist', () => {
      const rows = buildHonestPreflightRows(ALL_REAL_CHECKS);
      const format = rows.find((row) => row.label === 'Recipient email')!;
      const duplicate = rows.find((row) => row.label === 'Duplicate recipients')!;
      expect(format.state).toBe('blocked');
      expect(duplicate.state).toBe('blocked');
      expect(format.label).not.toMatch(/verified/i);
      expect(format.detail).toMatch(/not independently verified/i);
    });


    it('does not drop the real audit/recipients/intent checks just because the mockup has no named row for them', () => {
      const rows = buildHonestPreflightRows(ALL_REAL_CHECKS);
      expect(rows.some((row) => row.label === 'Assurance review')).toBe(true);
      expect(rows.some((row) => row.label === 'Recipient snapshots')).toBe(true);
      expect(rows.some((row) => row.label === 'Send intent')).toBe(true);
    });

    it('does not include removed placeholder rows (Role policy, Shared visibility, Context checks)', () => {
      const rows = buildHonestPreflightRows(ALL_REAL_CHECKS);
      expect(rows.some((row) => row.label === 'Role policy')).toBe(false);
      expect(rows.some((row) => row.label === 'Shared visibility')).toBe(false);
      expect(rows.some((row) => row.label === 'Context checks')).toBe(false);
    });
  });

  describe('Send step — held-out fix + action-bar relocation (items A, C, D)', () => {
    let sendIntentCalls: Array<Record<string, unknown>>;

    beforeEach(() => {
      sendIntentCalls = [];
      useOutreachV3SessionMock.mockReturnValue(baseController({ stage: 'ready_for_generation' }));
      onGet('/drafts', () => DRAFTS_FIXTURE);
      onGet('/generation/plan', () => PLAN_FIXTURE);
      // Must be truthy (approachCurrent = Boolean(approach.data)) so
      // InlineActions progresses past its own earlier "Approve approach"
      // gate and reaches the held-out/send logic this test exercises.
      onGet('/generation/approach-approval', () => ({
        gateVersion: 'outreach_v3_approach_approval_v1',
        sessionId: 'session-1',
        stateVersion: 1,
        specHash: 'spec-hash',
        planHash: 'plan-hash',
        sampleVersions: [],
        approvalHash: 'approval-hash',
      }));
      onGet('/send/settings', () => SETTINGS_FIXTURE);
      onPost('/send/preflight', (_url, body) => preflightFixture(body as never));
      onPost('/send/intent', (_url, body) => {
        sendIntentCalls.push(body as Record<string, unknown>);
        return { intentId: 'intent-1', deduped: false, preflight: preflightFixture(body as never) };
      });
      onGet('/send/intents/intent-1', () => ({
        id: 'intent-1',
        outreachRecordId: 'session-1',
        status: 'sent',
        testMode: false,
        requestKey: 'send-test',
        totals: { sent: 3, failed: 0, unknown: 0, skipped: 0, held: 0 },
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        deliveries: [],
      }));
    });

    it('has no send button in the workbench, and lets 3 clean recipients send once the 1 blocked one is held out and acknowledged — never before', async () => {
      const { container } = renderWorkspace('send');
      const workbench = () => container.querySelector('.uui-send-panel') as HTMLElement;
      const actionBar = () =>
        container.querySelector('.uui-outreach-actionbar') as HTMLElement;

      await waitFor(() => {
        expect(workbench()).toBeTruthy();
        expect(within(workbench()).getByRole('button', { name: /run preflight/i })).toBeEnabled();
      });

      // First preflight, no exclusions: the one real blocked recipient (r4)
      // blocks the ENTIRE send today — this is the bug item A fixes.
      fireEvent.click(within(workbench()).getByRole('button', { name: /run preflight/i }));
      await waitFor(() =>
        expect(within(workbench()).getByText(/recipient status/i)).toBeInTheDocument(),
      );
      expect(within(workbench()).getByText(/4 evaluated/)).toBeInTheDocument();

      // (C) — the preflight table only renders real server checks; the 3
      // placeholder rows (Role policy, Shared visibility, Context checks)
      // were removed because they had no real backend check.
      expect(within(workbench()).queryByText('Role policy')).not.toBeInTheDocument();
      expect(within(workbench()).queryByText('Shared visibility')).not.toBeInTheDocument();
      expect(within(workbench()).queryByText('Context checks')).not.toBeInTheDocument();

      // (D) — no send button inside the Send section; only the closing note.
      expect(
        within(workbench()).queryByRole('button', { name: /send \d+ approved email/i }),
      ).not.toBeInTheDocument();
      expect(
        within(workbench()).getByText(/send is the action bar at the bottom of this page/i),
      ).toBeInTheDocument();

      // Not sendable from the action bar either — nothing held out or acknowledged.
      expect(
        within(actionBar()).queryByRole('button', { name: /send \d+ approved email/i }),
      ).not.toBeInTheDocument();

      // (A) — hold out the blocked recipient via its real per-draft toggle.
      const blockedRow = within(workbench())
        .getByText('Blocked Recipient')
        .closest('.uui-recipient-status-row') as HTMLElement;
      fireEvent.click(within(blockedRow).getByRole('checkbox'));

      fireEvent.click(within(workbench()).getByRole('button', { name: /run preflight/i }));
      await waitFor(() => expect(within(workbench()).getByText(/held out · 1/i)).toBeInTheDocument());

      // Held out but NOT acknowledged yet — still not sendable.
      expect(
        within(actionBar()).queryByRole('button', { name: /send \d+ approved email/i }),
      ).not.toBeInTheDocument();
      expect(within(actionBar()).getByText(/held out\..*acknowledge/i)).toBeInTheDocument();

      // Acknowledge in the workbench, then re-run preflight.
      fireEvent.click(
        within(workbench()).getByLabelText(/I understand the held-out recipients/i),
      );
      fireEvent.click(within(workbench()).getByRole('button', { name: /run preflight/i }));

      // Now — and only now — the action bar's real send button appears,
      // enabled, for exactly the 3 clean recipients.
      const sendButton = await within(actionBar()).findByRole('button', {
        name: /send 3 approved emails/i,
      });
      expect(sendButton).toBeEnabled();
      expect(
        within(workbench()).queryByRole('button', { name: /send \d+ approved email/i }),
      ).not.toBeInTheDocument();

      fireEvent.click(sendButton);

      await waitFor(() => expect(sendIntentCalls).toHaveLength(1));
      // The exact held-out set and acknowledgment the user actually set are
      // what gets sent — not an empty echo-back (the original bug).
      expect(sendIntentCalls[0]).toMatchObject({
        excludedGenerationKeys: ['r4'],
        acknowledgeHeldOut: true,
      });
    });
  });
  describe('Refine with Meri is offered on every draft, at every stage', () => {
    // The reported gap: "i dont see the option to edit drafts with meri".
    // The refine control originally lived only inside DraftPreviewCard, which
    // renders AFTER approach approval — so the representative samples the user
    // is explicitly asked to review offered only a manual editor. Approach
    // approval is also unreachable while any sample is audit-held, so for a
    // held campaign there was no Meri affordance on any draft at all.
    const refineCalls: Array<{ url: string; body: unknown }> = [];

    function renderApproachStage() {
      refineCalls.length = 0;
      useOutreachV3SessionMock.mockReturnValue(baseController({ stage: 'ready_for_generation' }));
      onGet('/drafts', () => [DRAFTS_FIXTURE[0]!]);
      onGet('/generation/plan', () => PLAN_FIXTURE);
      // null => approachCurrent is false => the approach grid renders, which is
      // the pre-approval surface that was missing the control.
      onGet('/generation/approach-approval', () => null);
      onPost('/refine', (url, body) => {
        refineCalls.push({ url, body });
        return DRAFTS_FIXTURE[0]!.current;
      });
      return renderWorkspace('drafts');
    }

    it('renders the refine control on a representative sample before approval', async () => {
      const { container } = renderApproachStage();
      const sampleList = await waitFor(() => {
        const node = container.querySelector('.uui-sample-list');
        expect(node).not.toBeNull();
        return node as HTMLElement;
      });
      const refine = sampleList.querySelector('.uui-draft-refine');
      expect(refine, 'a sample card must offer Refine with Meri').not.toBeNull();
      expect(within(refine as HTMLElement).getByText('Refine with Meri')).toBeInTheDocument();
      expect(
        within(refine as HTMLElement).getByRole('button', { name: /Refine/ }),
      ).toBeInTheDocument();
    });

    it('shows the sample body in full rather than a truncated slice', async () => {
      const { container } = renderApproachStage();
      const sampleList = await waitFor(() => {
        const node = container.querySelector('.uui-sample-list');
        expect(node).not.toBeNull();
        return node as HTMLElement;
      });
      // The old card sliced body to 220 chars and appended an ellipsis; you
      // cannot judge or refine a draft you can only partly see.
      expect(sampleList.querySelector('.uui-draft-body')).not.toBeNull();
      expect(within(sampleList).getByText(/Body r1/)).toBeInTheDocument();
    });

    it('sends the typed instruction to the refine endpoint for that sample', async () => {
      const { container } = renderApproachStage();
      const sampleList = await waitFor(() => {
        const node = container.querySelector('.uui-sample-list');
        expect(node).not.toBeNull();
        return node as HTMLElement;
      });
      const refine = sampleList.querySelector('.uui-draft-refine') as HTMLElement;
      const input = refine.querySelector('input') as HTMLInputElement;

      // Empty instruction must not fire a model call.
      fireEvent.click(within(refine).getByRole('button', { name: /Refine/ }));
      expect(refineCalls).toHaveLength(0);

      fireEvent.change(input, { target: { value: 'warmer opening' } });
      fireEvent.click(within(refine).getByRole('button', { name: /Refine/ }));

      await waitFor(() => expect(refineCalls).toHaveLength(1));
      expect(refineCalls[0]!.url).toContain('/drafts/artifact-r1/refine');
      expect(refineCalls[0]!.body).toMatchObject({
        baseVersionId: 'version-r1',
        instruction: 'warmer opening',
      });
    });
  });
});
