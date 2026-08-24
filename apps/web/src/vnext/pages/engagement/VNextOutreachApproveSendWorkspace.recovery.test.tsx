import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope } from '../../../pages/engagement/outreach/v3/contracts.js';
import { VNextOutreachApproveSendWorkspace } from './VNextOutreachApproveSendWorkspace.js';

/**
 * Server-truth recovery (section 8): the Drafts/session mount must reconstruct
 * state from the BACKEND — sessionStorage is a same-tab cache/optimization
 * only, never a requirement. These tests simulate the sessionStorage-lost /
 * fresh-mount cases directly (refresh, browser navigation away-and-back, a
 * new tab, and a completely lost sessionStorage all collapse to the same
 * observable case from React's perspective: a fresh mount with no local
 * jobId state) and assert the server's `/generation/jobs/latest` response is
 * what drives the UI, not whatever sessionStorage did or didn't have.
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

const APPROVAL = {
  gateVersion: 'v1',
  sessionId: 'session-1',
  stateVersion: 4,
  specHash: 'spec',
  planHash: 'plan',
  sampleVersions: [],
  approvalHash: 'c'.repeat(64),
};

function jobFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-recovered-1',
    sessionId: 'session-1',
    status: 'running',
    totals: { queued: 1, succeeded: 2, failed: 0, skipped: 0, held: 0, total: 3 },
    requestKey: 'session-1:hash',
    planHash: 'plan',
    approachApprovalHash: APPROVAL.approvalHash,
    startedAt: '2026-08-23T12:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-08-23T12:00:00.000Z',
    items: [],
    ...overrides,
  };
}

function draftFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    generationKey: 'd1',
    recipientKey: 'd1',
    current: {
      id: 'version-1',
      generationStatus: 'generated',
      auditStatus: 'passed',
      approvalStatus: 'not_required',
      auditChecks: [],
      subject: 'Subject',
      body: 'Body',
    },
    ...overrides,
  };
}

const { api, getLatestJobMock, listDraftsMock, getJobMock } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  getLatestJobMock: vi.fn(async (..._args: unknown[]) => null as unknown),
  listDraftsMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  getJobMock: vi.fn(async (_api: unknown, _sessionId: string, jobId: string) => ({
    id: jobId,
    sessionId: 'session-1',
    status: 'running',
    totals: { queued: 1, succeeded: 2, failed: 0, skipped: 0, held: 0, total: 3 },
    requestKey: 'session-1:hash',
    planHash: 'plan',
    approachApprovalHash: 'c'.repeat(64),
    startedAt: '2026-08-23T12:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-08-23T12:00:00.000Z',
    items: [] as unknown[],
  })),
}));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('./engagement-api.js', async () => {
  const actual = await vi.importActual<typeof import('./engagement-api.js')>('./engagement-api.js');
  return {
    ...actual,
    getLatestOutreachV3FullGenerationJob: getLatestJobMock,
    getOutreachV3GenerationPlan: vi.fn(async () => PLAN),
    listOutreachV3Drafts: listDraftsMock,
    getOutreachV3ApproachApproval: vi.fn(async () => APPROVAL),
    getOutreachV3SendSettings: vi.fn(async () => null),
    listOutreachAttachments: vi.fn(async () => []),
    getOutreachV3GenerationJob: getJobMock,
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

describe('VNextOutreachApproveSendWorkspace server-truth recovery', () => {
  beforeEach(() => {
    useOutreachV3SessionMock.mockReset();
    useOutreachV3SessionMock.mockReturnValue(controllerFixture());
    getLatestJobMock.mockReset();
    listDraftsMock.mockReset();
    listDraftsMock.mockResolvedValue([]);
    getJobMock.mockReset();
    getJobMock.mockImplementation(async (_api: unknown, _sessionId: string, jobId: string) =>
      jobFixture({ id: jobId }),
    );
    window.sessionStorage.clear();
  });

  it('recovers an active job from the server on a fresh mount with empty sessionStorage (refresh/new-tab/lost-storage case)', async () => {
    // sessionStorage has nothing — simulating a refresh, browser-back, a
    // brand new tab, or sessionStorage having been cleared entirely.
    expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBeNull();
    getLatestJobMock.mockResolvedValueOnce(jobFixture({ id: 'job-recovered-1', status: 'running' }));

    renderWorkspace();

    await waitFor(() => expect(getLatestJobMock).toHaveBeenCalledWith(api, 'session-1'));
    // The recovered job id is adopted into local/sessionStorage state so
    // polling (getOutreachV3GenerationJob) resumes against the REAL job.
    await waitFor(() =>
      expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBe(
        'job-recovered-1',
      ),
    );
  });

  it('loads drafts directly when no job exists but drafts already do (no job + drafts exist -> load drafts)', async () => {
    getLatestJobMock.mockResolvedValueOnce(null);
    renderWorkspace();

    await waitFor(() => expect(getLatestJobMock).toHaveBeenCalledWith(api, 'session-1'));
    // No job recovered: must not be left dangling on a stale sessionStorage
    // job id from a different session/profile.
    expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBeNull();
  });

  it('does not let a stale sessionStorage job id from another session/profile override "no job" server truth', async () => {
    window.sessionStorage.setItem('outreach-v3:session-1:phase1-job', 'stale-job-from-elsewhere');
    getLatestJobMock.mockResolvedValueOnce(null);

    renderWorkspace();

    await waitFor(() => expect(getLatestJobMock).toHaveBeenCalledWith(api, 'session-1'));
    await waitFor(() =>
      expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBeNull(),
    );
  });

  it('replaces a stale local job id with the real server job id when they differ', async () => {
    window.sessionStorage.setItem('outreach-v3:session-1:phase1-job', 'old-local-job');
    getLatestJobMock.mockResolvedValueOnce(jobFixture({ id: 'job-recovered-1' }));

    renderWorkspace();

    await waitFor(() =>
      expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBe(
        'job-recovered-1',
      ),
    );
  });

  it('recovers a QUEUED job after refresh and keeps polling it (queued is not terminal)', async () => {
    getLatestJobMock.mockResolvedValueOnce(jobFixture({ id: 'job-queued', status: 'queued' }));
    getJobMock.mockImplementation(async (_api, _sessionId, jobId) =>
      jobFixture({ id: jobId, status: 'queued' }),
    );

    renderWorkspace();

    await waitFor(() =>
      expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBe('job-queued'),
    );
    await waitFor(() => expect(getJobMock).toHaveBeenCalledWith(api, 'session-1', 'job-queued'));
  });

  it('recovers a RUNNING job after refresh and keeps polling it', async () => {
    getLatestJobMock.mockResolvedValueOnce(jobFixture({ id: 'job-running', status: 'running' }));
    getJobMock.mockImplementation(async (_api, _sessionId, jobId) =>
      jobFixture({ id: jobId, status: 'running' }),
    );

    renderWorkspace();

    await waitFor(() =>
      expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBe('job-running'),
    );
    await waitFor(() => expect(getJobMock).toHaveBeenCalledWith(api, 'session-1', 'job-running'));
  });

  it('recovers a COMPLETED job after refresh and loads its drafts (completed job with drafts)', async () => {
    getLatestJobMock.mockResolvedValueOnce(
      jobFixture({ id: 'job-complete', status: 'complete', finishedAt: '2026-08-23T12:05:00.000Z' }),
    );
    getJobMock.mockImplementation(async (_api, _sessionId, jobId) =>
      jobFixture({
        id: jobId,
        status: 'complete',
        finishedAt: '2026-08-23T12:05:00.000Z',
        totals: { queued: 0, succeeded: 3, failed: 0, skipped: 0, held: 0, total: 3 },
      }),
    );
    // PLAN has 3 slots (d1, d2, d3) — a genuinely complete job returns drafts
    // for all of them.
    listDraftsMock.mockResolvedValue(
      ['d1', 'd2', 'd3'].map((key) => draftFixture({ id: `draft-${key}`, generationKey: key })),
    );

    renderWorkspace();

    await waitFor(() =>
      expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBe('job-complete'),
    );
    await waitFor(() => expect(listDraftsMock).toHaveBeenCalledWith(api, 'session-1'));
    // All 3 recovered drafts actually reached the draft-review screen — the
    // job's completeness is reflected in a real draft count, not just a
    // fetched-but-unrendered response.
    await waitFor(() =>
      expect(screen.getByText(/^3 drafts\./i)).toBeInTheDocument(),
    );
  });

  it('recovers a FAILED job after refresh — surfaces the failure, and any drafts that DID persist before the failure are still shown, not discarded', async () => {
    getLatestJobMock.mockResolvedValueOnce(jobFixture({ id: 'job-failed', status: 'failed' }));
    getJobMock.mockImplementation(async (_api, _sessionId, jobId) =>
      jobFixture({
        id: jobId,
        status: 'failed',
        totals: { queued: 0, succeeded: 0, failed: 3, skipped: 0, held: 0, total: 3 },
      }),
    );
    // A hard "failed" status (zero succeeded) legitimately has zero drafts —
    // this is the discriminator against 'partial' below, which must keep
    // whatever DID succeed.
    listDraftsMock.mockResolvedValue([]);

    renderWorkspace();

    await waitFor(() =>
      expect(window.sessionStorage.getItem('outreach-v3:session-1:phase1-job')).toBe('job-failed'),
    );
    await waitFor(() => expect(listDraftsMock).toHaveBeenCalledWith(api, 'session-1'));
  });

  it('a PARTIAL job (mixed success/failure) after refresh does not discard the successful drafts', async () => {
    // PLAN's representativeSampleKeys are ['d1', 'd2'] (the approach-approval
    // samples) — the full-generation "remaining" slots are only ['d3'].
    // Simulate: d1/d2 already had drafts from the approach-sample phase and
    // survive untouched; the full-generation job covers only d3, which
    // failed. The job's totals reflect the FULL slot set (3), but its items
    // only cover what it actually ran (d3).
    getLatestJobMock.mockResolvedValueOnce(jobFixture({ id: 'job-partial', status: 'partial' }));
    getJobMock.mockImplementation(async (_api, _sessionId, jobId) =>
      jobFixture({
        id: jobId,
        status: 'partial',
        totals: { queued: 0, succeeded: 2, failed: 1, skipped: 0, held: 0, total: 3 },
        items: [{ id: 'item-d3', generationKey: 'd3', status: 'failed', error: 'Provider timeout', attempt: 1 }],
      }),
    );
    // The 2 sample drafts (d1, d2) that succeeded earlier must still be
    // fetched and rendered even though the LATEST job's own totals show a
    // failure — a partial job must never cause previously-persisted
    // successful drafts to disappear.
    listDraftsMock.mockResolvedValue(
      ['d1', 'd2'].map((key) => draftFixture({ id: `draft-${key}`, generationKey: key })),
    );

    renderWorkspace();

    await waitFor(() => expect(listDraftsMock).toHaveBeenCalledWith(api, 'session-1'));
    // d3 (the only real "remaining" slot) shows its actual failure with an
    // independent retry action — retrying it does not touch d1/d2.
    await waitFor(() => expect(screen.getByText('Needs review')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // d1/d2's fetched drafts are what the "2 of 3 written" progress line
    // reflects — they were not discarded by d3's failure.
    expect(screen.getByText(/written, in the approach you approved/i)).toBeInTheDocument();
  });

  it('surfaces a distinct, retryable error when a COMPLETED job\'s drafts fail to load (generation succeeded, retrieval failed — not a generation failure)', async () => {
    getLatestJobMock.mockResolvedValueOnce(jobFixture({ id: 'job-complete', status: 'complete' }));
    getJobMock.mockImplementation(async (_api, _sessionId, jobId) =>
      jobFixture({ id: jobId, status: 'complete' }),
    );
    listDraftsMock.mockRejectedValue(new Error('drafts service unavailable'));

    renderWorkspace();

    expect(
      await screen.findByText(/Generation finished, but drafts could not be loaded/i),
    ).toBeInTheDocument();
    // The retry affordance must be present and must not be the generic
    // "campaign could not be opened" (session-level) error path.
    expect(screen.getByRole('button', { name: /Retry loading drafts/i })).toBeInTheDocument();
    expect(screen.queryByText(/This campaign could not be opened/i)).not.toBeInTheDocument();
  });

  it('no job and no drafts renders the approach-start screen, not an error or an infinite loading state', async () => {
    getLatestJobMock.mockResolvedValueOnce(null);
    listDraftsMock.mockResolvedValue([]);

    renderWorkspace();

    await waitFor(() => expect(getLatestJobMock).toHaveBeenCalledWith(api, 'session-1'));
    expect(screen.queryByText(/could not be opened/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/drafts could not be loaded/i)).not.toBeInTheDocument();
  });
});
