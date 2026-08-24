import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope } from '../../../pages/engagement/outreach/v3/contracts.js';
import { VNextOutreachApproveSendWorkspace } from './VNextOutreachApproveSendWorkspace.js';

/**
 * Exercises the real "approve approach -> start full generation" mutation
 * chain with a mounted component (not just a source-text contract check).
 * This is the second live call site of startOutreachV3FullGeneration besides
 * VNextOutreachGuidedWorkspace, and it must observe the same two rules:
 *
 *   1. complete=false + jobId=null is never treated as a successful start.
 *   2. the request key is derived deterministically from the approval hash,
 *      never a fresh crypto.randomUUID() per call.
 */

const useOutreachV3SessionMock = vi.fn();
vi.mock('../../../pages/engagement/outreach/v3/useOutreachV3Session.js', () => ({
  useOutreachV3Session: (...args: unknown[]) => useOutreachV3SessionMock(...args),
}));

const PLAN = {
  planVersion: 'v1',
  sessionId: 'session-1',
  stateVersion: 4,
  specHash: 'spec',
  planHash: 'plan',
  deliveryPattern: 'personalized_separate' as const,
  representativeSampleKeys: ['d1', 'd2'],
  eligible: true,
  blockers: [],
  slots: ['d1', 'd2', 'd3'].map((generationKey) => ({
    generationKey,
    audienceKind: 'individual' as const,
    recipients: [{ targetKey: generationKey, label: generationKey, email: `${generationKey}@example.com` }],
  })),
};

function sampleDraft(id: string) {
  return {
    id,
    outreachRecordId: 'record-1',
    generationKey: id,
    recipientKey: `${id}@example.com`,
    audienceKind: 'individual',
    currentVersion: 1,
    current: {
      id: `${id}-v1`,
      artifactId: id,
      outreachRecordId: 'record-1',
      version: 1,
      sourceVersionId: null,
      generationKey: id,
      recipientKey: `${id}@example.com`,
      audienceKind: 'individual',
      subject: `Subject ${id}`,
      body: `Body ${id}`,
      contentHash: `${id}-hash`,
      generationStatus: 'ready',
      auditStatus: 'pass',
      approvalStatus: 'unapproved',
      auditDecision: null,
      auditChecks: [],
      reviewRequestId: null,
      provider: 'openai',
      model: 'test',
      promptSpecVersion: 'v1',
      sendable: false,
      createdAt: '2026-08-21T12:00:00.000Z',
      contextNote: 'Governed campaign context',
    },
    history: [],
  };
}

const APPROVAL_HASH = 'b'.repeat(64);

const { api, startFullGenerationMock, approveApproachMock } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  startFullGenerationMock: vi.fn(async (..._args: unknown[]) => ({
    jobId: null as string | null,
    deduped: false,
    complete: false,
    remaining: 0,
  })),
  approveApproachMock: vi.fn(async (..._args: unknown[]) => ({
    approval: {
      gateVersion: 'v1',
      sessionId: 'session-1',
      stateVersion: 4,
      specHash: 'spec',
      planHash: 'plan',
      sampleVersions: [],
      approvalHash: APPROVAL_HASH,
    },
    eventId: 'event-1',
    eventSequence: '1',
    idempotent: false,
  })),
}));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('./engagement-api.js', async () => {
  const actual = await vi.importActual<typeof import('./engagement-api.js')>('./engagement-api.js');
  return {
    ...actual,
    startOutreachV3FullGeneration: startFullGenerationMock,
    approveOutreachV3Approach: approveApproachMock,
    getOutreachV3GenerationPlan: vi.fn(async () => PLAN),
    listOutreachV3Drafts: vi.fn(async () => [sampleDraft('d1'), sampleDraft('d2')]),
    getOutreachV3ApproachApproval: vi.fn(async () => null),
    getOutreachV3SendSettings: vi.fn(async () => null),
    listOutreachAttachments: vi.fn(async () => []),
    // Server-truth recovery query (section 8) fires on every mount. This
    // suite is exercising the generation-start mutation chain, not
    // recovery, so it always starts from "no job exists yet" — the
    // recovery-specific behavior has its own dedicated test file.
    getLatestOutreachV3FullGenerationJob: vi.fn(async () => null),
  };
});

function baseSession(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'New outreach campaign', status: 'active' },
    currentStateVersion: 4,
    specHash: 'spec-hash',
    pendingProposalCount: 0,
    readiness: { blockers: [] },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: 'Request a meeting',
        objective: 'Secure a meeting',
        topic: 'Autonomous systems briefing',
        desiredOutcome: 'Meeting accepted',
        ask: { mode: 'explicit', text: 'Reply with availability.' },
        whyNow: 'Timely',
      },
      sponsor: { kind: 'client', label: 'Example Client', clientRefs: [] },
      targeting: { criteria: null, selectedTargetRefs: [], rejectedRecommendationRefs: [] },
      delivery: { pattern: 'personalized_separate', personalization: 'high' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: { campaignAngle: null, tone: null, length: 'undecided', customLengthInstruction: null },
    },
  };
}

function controllerFixture() {
  return {
    session: baseSession(),
    sessionId: 'session-1',
    stage: 'ready_for_generation',
    isBootstrapping: false,
    errorMessage: null,
    templateProvenance: null,
    reasoningUnavailable: false,
    reasoningErrorMessage: null,
    pendingProposals: [],
    proposalBusy: false,
    sendingTurn: false,
    turns: [],
    sendTurn: vi.fn(async () => undefined),
    retryReasoning: vi.fn(async () => undefined),
    applyProposal: vi.fn(async () => undefined),
    rejectProposal: vi.fn(async () => undefined),
  };
}

function renderWorkspace() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VNextOutreachApproveSendWorkspace
        sessionId="session-1"
        clients={[]}
        selectedClientId={null}
        integrations={[]}
        step="drafts"
        onStepChange={vi.fn()}
        onExit={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('VNextOutreachApproveSendWorkspace full-generation idempotency + gating', () => {
  beforeEach(() => {
    useOutreachV3SessionMock.mockReset();
    useOutreachV3SessionMock.mockReturnValue(controllerFixture());
    startFullGenerationMock.mockClear();
    approveApproachMock.mockClear();
    window.sessionStorage.clear();
  });

  it('derives the full-generation requestKey from the approach approvalHash, never a random UUID', async () => {
    renderWorkspace();

    await screen.findByRole('button', { name: /approve this approach/i });
    (await screen.findByRole('button', { name: /approve this approach/i })).click();

    await waitFor(() => expect(approveApproachMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(startFullGenerationMock).toHaveBeenCalledTimes(1));

    const [, sessionIdArg, requestKeyArg] = startFullGenerationMock.mock.calls[0]!;
    expect(sessionIdArg).toBe('session-1');
    expect(requestKeyArg).toBe(`session-1:${APPROVAL_HASH}`);
    expect(requestKeyArg).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('does not treat complete=false + jobId=null as success: no job is stored, an error surfaces', async () => {
    renderWorkspace();

    (await screen.findByRole('button', { name: /approve this approach/i })).click();
    await waitFor(() => expect(startFullGenerationMock).toHaveBeenCalledTimes(1));

    // The ambiguous/failed response must produce a visible error, not a
    // silent no-op or an assumed-complete state.
    expect(
      await screen.findByText(
        /Generation did not start\. The server returned neither a generation job nor a completed result\./i,
      ),
    ).toBeInTheDocument();
    expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBeNull();
  });

  it('stores the job id and resumes polling when generation starts for real', async () => {
    startFullGenerationMock.mockResolvedValueOnce({
      jobId: 'job-77',
      deduped: false,
      complete: false,
      remaining: 1,
    });
    renderWorkspace();

    (await screen.findByRole('button', { name: /approve this approach/i })).click();
    await waitFor(() => expect(startFullGenerationMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBe('job-77'),
    );
  });
});
