import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../../../pages/clients/clientTypes.js';
import type {
  OutreachV3Command,
  OutreachV3ResolvedContextRef,
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import { VNextOutreachGuidedWorkspace } from './VNextOutreachGuidedWorkspace.js';

/**
 * These tests exercise the guided workflow's safety-critical seams: the
 * review-packet human gate must be recorded (with an empty, client-field-free
 * body) before draft generation starts, a personal note must stay scoped to
 * the one recipient it was written for, and client-profile context accepted by
 * an earlier review packet must be explicitly superseded rather than silently
 * duplicated when the packet is rebuilt.
 */

const useOutreachV3SessionMock = vi.fn();
vi.mock('../../../pages/engagement/outreach/v3/useOutreachV3Session.js', () => ({
  useOutreachV3Session: (...args: unknown[]) => useOutreachV3SessionMock(...args),
}));

const { api, calls } = vi.hoisted(() => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const api = {
    get: vi.fn(async (url: string) => {
      calls.push({ method: 'get', url });
      if (url.includes('/people')) {
        return { data: [{ id: 'person-1', name: 'Alex Rivera', title: 'Chief of Staff' }] };
      }
      return { data: [] };
    }),
    post: vi.fn(async (url: string, body?: unknown) => {
      calls.push({ method: 'post', url, body });
      return { data: {} };
    }),
  };
  return { api, calls };
});
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

const startFullGenerationMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    jobId: 'job-1',
    deduped: false,
    complete: false,
    remaining: 2,
  })),
);
vi.mock('./engagement-api.js', () => ({
  startOutreachV3FullGeneration: startFullGenerationMock,
}));

const CLIENT_ID = '8f7e6d5c-4b3a-4210-9fed-cba987654321';

const client: Client = {
  id: CLIENT_ID,
  name: 'Example Client',
  website: null,
  description: 'A defense contractor.',
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const targetA: OutreachV3ResolvedTargetRef = {
  targetKey: 'directory_member:a',
  locator: { source: 'directory_member', id: 'a' },
  displayName: 'Jordan Smith',
  title: 'Legislative Director',
  organization: 'Office of Representative Example',
  email: 'jordan@example.gov',
  clientId: null,
  roleStatus: 'current',
  snapshotHash: 'hash-a',
  jurisdiction: {
    governmentLevel: 'federal',
    chamber: 'house',
    state: 'VA',
    district: '01',
    committees: [],
    issueAreas: [],
  },
};

const targetB: OutreachV3ResolvedTargetRef = {
  ...targetA,
  targetKey: 'directory_member:b',
  locator: { source: 'directory_member', id: 'b' },
  displayName: 'Casey Doe',
  email: 'casey@example.gov',
  snapshotHash: 'hash-b',
};

function session(overrides: Partial<OutreachV3SessionEnvelope['spec']['context']> = {}): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'New outreach campaign', status: 'active' },
    currentStateVersion: 3,
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
      sponsor: { kind: 'client', label: 'Example Client', clientRefs: [{ clientId: CLIENT_ID }] },
      targeting: {
        criteria: null,
        selectedTargetRefs: [targetA, targetB],
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
        ...overrides,
      },
      strategy: { campaignAngle: null, tone: null, length: 'undecided', customLengthInstruction: null },
    },
  };
}

function controller(overrides: Record<string, unknown> = {}) {
  return {
    session: session(),
    isBootstrapping: false,
    errorMessage: null,
    applyCommands: vi.fn(async () => undefined),
    applyingCommands: false,
    getTargetProfile: vi.fn(async () => undefined),
    targetProfile: undefined,
    targetProfilePending: false,
    targetSearchError: null,
    ...overrides,
  };
}

function renderWorkspace() {
  const onStepChange = vi.fn();
  const onExit = vi.fn();
  render(
    <VNextOutreachGuidedWorkspace
      sessionId="session-1"
      clients={[client]}
      selectedClientId={null}
      integrations={[]}
      step="goal"
      onStepChange={onStepChange}
      onExit={onExit}
    />,
  );
  return { onStepChange, onExit };
}

function commandsOf(applyCommands: ReturnType<typeof vi.fn>, callIndex: number): OutreachV3Command[] {
  return applyCommands.mock.calls[callIndex]![0] as OutreachV3Command[];
}

describe('VNextOutreachGuidedWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startFullGenerationMock.mockClear();
  });

  it('resumes directly at the review packet once workflow, sponsor, and targets are already saved', async () => {
    useOutreachV3SessionMock.mockReturnValue(controller());
    renderWorkspace();

    expect(await screen.findByText('Choose client context')).toBeInTheDocument();
    expect(useOutreachV3SessionMock).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('scopes an attendee note to that attendee only and records the review-packet gate before generation starts', async () => {
    const applyCommands = vi.fn(async () => undefined);
    useOutreachV3SessionMock.mockReturnValue(controller({ applyCommands }));
    const { onStepChange } = renderWorkspace();

    await screen.findByText('Choose client context');
    const relationshipsLabel = screen.getByText('Relationships').closest('label')!;
    fireEvent.click(within(relationshipsLabel).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /build review packet/i }));

    expect(await screen.findByText('Confirm exactly what Meri will use')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'get' && call.url.includes('/people'))).toBe(true);

    const notes = screen.getAllByPlaceholderText('Optional personal note for this attendee only');
    expect(notes).toHaveLength(2);
    fireEvent.change(notes[0]!, { target: { value: 'Mention the May briefing.' } });

    fireEvent.click(screen.getByRole('button', { name: /accept and generate 2 drafts/i }));

    await waitFor(() => expect(startFullGenerationMock).toHaveBeenCalledTimes(1));
    expect(applyCommands).toHaveBeenCalledTimes(1);

    const commands = commandsOf(applyCommands, 0);
    const acceptContext = commands.find((command) => command.type === 'ACCEPT_CONTEXT_REFS');
    expect(acceptContext).toBeDefined();
    const selections = (acceptContext!.payload as { selections: Array<Record<string, unknown>> }).selections;

    const clientRecord = selections.find(
      (selection) => (selection.locator as Record<string, unknown>).source === 'capiro_record',
    );
    expect(clientRecord).toMatchObject({ locator: { id: CLIENT_ID, clientId: CLIENT_ID } });

    const overviewSection = selections.find(
      (selection) => (selection.locator as Record<string, unknown>).title === 'Overview — client profile',
    );
    expect(overviewSection).toBeDefined();

    const relationshipsSection = selections.find(
      (selection) => (selection.locator as Record<string, unknown>).title === 'Relationships — client profile',
    );
    expect(String((relationshipsSection!.locator as Record<string, unknown>).text)).toContain('Alex Rivera');

    const subjectLine = selections.find(
      (selection) => (selection.locator as Record<string, unknown>).title === 'Campaign subject line',
    );
    expect(String((subjectLine!.locator as Record<string, unknown>).text)).toContain(
      'Autonomous systems briefing',
    );

    // Target isolation: exactly one target-specific selection, and it belongs to Jordan (target A) only.
    const targetSpecific = selections.filter(
      (selection) => (selection.scope as Record<string, unknown>).kind === 'target',
    );
    expect(targetSpecific).toHaveLength(1);
    expect(targetSpecific[0]!.scope).toEqual({ kind: 'target', targetKey: targetA.targetKey });
    expect(String((targetSpecific[0]!.locator as Record<string, unknown>).text)).toContain(
      'Mention the May briefing.',
    );
    expect(
      selections.some((selection) => (selection.scope as Record<string, unknown>).targetKey === targetB.targetKey),
    ).toBe(false);

    // The review-packet approval call carries no client-supplied fields and
    // happens before generation is asked to start.
    const approvalCall = calls.find((call) => call.url.includes('/generation/review-packet-approval'));
    expect(approvalCall).toBeDefined();
    expect(approvalCall!.body).toEqual({});
    const approvalOrder = api.post.mock.invocationCallOrder[api.post.mock.calls.indexOf(
      api.post.mock.calls.find((call) => (call[0] as string).includes('review-packet-approval'))!,
    )]!;
    const generationOrder = startFullGenerationMock.mock.invocationCallOrder[0]!;
    expect(approvalOrder).toBeLessThan(generationOrder);

    expect(onStepChange).toHaveBeenCalledWith('drafts');
  });

  it('supersedes client-profile context accepted by an earlier review packet instead of duplicating it', async () => {
    // Having any context already accepted (e.g. from a prior review packet in
    // an earlier visit) resumes the session directly on the review step —
    // `preparedContext` is ephemeral UI state, so the packet must be reloaded.
    const priorRef: OutreachV3ResolvedContextRef = {
      contextKey: 'prior-ref-1',
      locator: { source: 'manual', id: 'prior-1', sourceLabel: 'capiro_client_profile' },
      contextClass: 'writing_guidance',
      scope: { kind: 'campaign' },
      title: 'Overview — client profile',
      summary: 'Prior snapshot',
      verificationClass: 'unverified',
      sensitivity: 'normal',
      instructionsAllowed: true,
      usableAsEvidence: false,
      usableAsWritingGuidance: true,
      snapshotHash: 'prior-hash',
    };
    const applyCommands = vi.fn(async () => undefined);
    useOutreachV3SessionMock.mockReturnValue(
      controller({
        applyCommands,
        session: session({ writingGuidanceRefs: [priorRef] }),
      }),
    );
    renderWorkspace();

    await screen.findByText('Confirm exactly what Meri will use');
    expect(screen.getByText('Reload the client context snapshot')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load packet/i }));
    await waitFor(() =>
      expect(screen.queryByText('Reload the client context snapshot')).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /accept and generate 2 drafts/i }));
    await waitFor(() => expect(startFullGenerationMock).toHaveBeenCalledTimes(1));

    const commands = commandsOf(applyCommands, 0);
    const exclude = commands.find((command) => command.type === 'EXCLUDE_CONTEXT_REFS');
    expect(exclude).toBeDefined();
    expect(exclude!.payload).toEqual({
      refs: [{ contextKey: 'prior-ref-1', reason: 'superseded' }],
    });
  });
});
