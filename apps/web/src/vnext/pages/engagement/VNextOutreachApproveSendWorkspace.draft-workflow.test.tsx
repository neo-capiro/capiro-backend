import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope } from '../../../pages/engagement/outreach/v3/contracts.js';
import { EngagementToastProvider } from './engagement-toast.js';
import { VNextOutreachApproveSendWorkspace } from './VNextOutreachApproveSendWorkspace.js';

/**
 * Downstream draft workflow (reliability repair, sections 11/13/14).
 *
 * The pre-existing VNextOutreachApproveSendWorkspace.test.tsx only covers the
 * pure view-model (deriveOutreachPhase1View, partitionDrafts, sendProgress)
 * and a source-text "authority contract" (readFileSync + string assertions).
 * Neither of those actually renders the component or calls the real mutation
 * functions. This file mounts the workspace on the draft-review and send
 * steps and drives real user interactions through to the actual API call
 * sites: reviseOutreachV3Draft (inline edit), refineOutreachV3Draft (Edit
 * with Meri / tone change), createOutreachV3TestSend (test send), and
 * createOutreachV3SendIntent (final send) — proving the wiring, not just the
 * static shape of the source.
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
  representativeSampleKeys: [] as string[],
  eligible: true,
  blockers: [],
  slots: ['d1'].map((generationKey) => ({
    generationKey,
    audienceKind: 'individual' as const,
    recipients: [{ targetKey: generationKey, label: 'Alpha Recipient', email: `${generationKey}@example.com` }],
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

function draftFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    outreachRecordId: 'record-1',
    generationKey: 'd1',
    recipientKey: 'd1@example.com',
    audienceKind: 'individual',
    currentVersion: 1,
    current: {
      id: 'version-1',
      artifactId: 'draft-1',
      outreachRecordId: 'record-1',
      version: 1,
      sourceVersionId: null,
      generationKey: 'd1',
      recipientKey: 'd1@example.com',
      audienceKind: 'individual',
      subject: 'Original subject',
      body: 'Original body',
      contentHash: 'hash-1',
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
    ...overrides,
  };
}

const {
  api,
  reviseMock,
  refineMock,
  testSendMock,
  createSendIntentMock,
  approveDraftMock,
  runPreflightMock,
  saveSendSettingsMock,
  getDraftVersionMock,
  listDraftsMock,
} = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  reviseMock: vi.fn(async (_api: unknown, _sessionId: string, _draftId: string, input: unknown) => ({
    id: 'version-2',
    artifactId: 'draft-1',
    version: 2,
    subject: (input as { subject: string }).subject,
    body: (input as { body: string }).body,
    generationStatus: 'ready',
    auditStatus: 'pass',
    approvalStatus: 'unapproved',
    auditChecks: [],
    createdAt: '2026-08-21T12:05:00.000Z',
    contentHash: 'hash-2',
  })),
  refineMock: vi.fn(async (_api: unknown, _sessionId: string, _draftId: string, input: unknown) => ({
    id: 'version-3',
    artifactId: 'draft-1',
    version: 2,
    subject: 'Refined subject',
    body: `Refined via Meri: ${(input as { instruction: string }).instruction}`,
    generationStatus: 'ready',
    auditStatus: 'pass',
    approvalStatus: 'unapproved',
    auditChecks: [],
    createdAt: '2026-08-21T12:06:00.000Z',
    contentHash: 'hash-3',
  })),
  testSendMock: vi.fn(async (_api: unknown, _sessionId: string, _input: unknown) => ({
    id: 'test-send-1',
    status: 'sent',
  })),
  createSendIntentMock: vi.fn(async (_api: unknown, _sessionId: string, input: unknown) => ({
    intentId: 'intent-1',
    requestKey: (input as { requestKey: string }).requestKey,
  })),
  approveDraftMock: vi.fn(async () => ({
    id: 'version-1',
    approvalStatus: 'approved',
  })),
  runPreflightMock: vi.fn(async () => ({
    eligible: true,
    excludedGenerationKeys: [],
    heldOutAcknowledged: true,
    draftVersionIds: ['version-1'],
    draftResults: [{ generationKey: 'd1', eligible: true, blockers: [] }],
    checks: [],
  })),
  saveSendSettingsMock: vi.fn(async () => ({
    senderConnectionId: 'conn-1',
    appendSignature: false,
    attachmentIds: [],
  })),
  getDraftVersionMock: vi.fn(async (_api: unknown, _sessionId: string, versionId: string) => ({
    id: versionId,
    artifactId: 'draft-1',
    outreachRecordId: 'record-1',
    version: versionId === 'version-2' ? 2 : 1,
    sourceVersionId: null,
    generationKey: 'd1',
    recipientKey: 'd1@example.com',
    audienceKind: 'individual',
    subject: 'Original subject',
    body: 'Original body',
    contentHash: 'hash-1',
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
  })),
  listDraftsMock: vi.fn(async () => [draftFixture()]),
}));

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('./engagement-api.js', async () => {
  const actual = await vi.importActual<typeof import('./engagement-api.js')>('./engagement-api.js');
  return {
    ...actual,
    getLatestOutreachV3FullGenerationJob: vi.fn(async () => null),
    getOutreachV3GenerationPlan: vi.fn(async () => PLAN),
    getOutreachV3ApproachApproval: vi.fn(async () => APPROVAL),
    listOutreachV3Drafts: listDraftsMock,
    getOutreachV3SendSettings: vi.fn(async () => ({
      senderConnectionId: 'conn-1',
      appendSignature: false,
      attachmentIds: [],
    })),
    listOutreachAttachments: vi.fn(async () => []),
    reviseOutreachV3Draft: reviseMock,
    refineOutreachV3Draft: refineMock,
    createOutreachV3TestSend: testSendMock,
    createOutreachV3SendIntent: createSendIntentMock,
    approveOutreachV3Draft: approveDraftMock,
    runOutreachV3Preflight: runPreflightMock,
    saveOutreachV3SendSettings: saveSendSettingsMock,
    getOutreachV3DraftVersion: getDraftVersionMock,
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

function renderWorkspace(step: 'drafts' | 'send' = 'drafts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onStepChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <EngagementToastProvider>
        <VNextOutreachApproveSendWorkspace
          sessionId="session-1"
          clients={[]}
          selectedClientId={null}
          integrations={[
            { id: 'conn-1', provider: 'microsoft_365', status: 'connected', accountEmail: 'me@example.com' },
          ]}
          step={step}
          onStepChange={onStepChange}
          onExit={vi.fn()}
        />
      </EngagementToastProvider>
    </QueryClientProvider>,
  );
  return { onStepChange };
}

describe('VNextOutreachApproveSendWorkspace downstream draft workflow', () => {
  beforeEach(() => {
    useOutreachV3SessionMock.mockReset();
    useOutreachV3SessionMock.mockReturnValue(controllerFixture());
    reviseMock.mockClear();
    refineMock.mockClear();
    testSendMock.mockClear();
    createSendIntentMock.mockClear();
    approveDraftMock.mockClear();
    getDraftVersionMock.mockClear();
    listDraftsMock.mockClear();
    listDraftsMock.mockImplementation(async () => [draftFixture()]);
    window.sessionStorage.clear();
  });

  it('inline edit calls reviseOutreachV3Draft with the exact base version and new subject/body', async () => {
    renderWorkspace('drafts');

    // This draft has clean audit/approval status, so it lands in the
    // "matching" bucket (not "needs judgment") and is only rendered after
    // explicitly choosing to read it.
    fireEvent.click(await screen.findByRole('button', { name: /read all/i }));
    fireEvent.click(await screen.findByRole('button', { name: /open draft/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit text/i }));

    const subjectInput = await screen.findByDisplayValue('Original subject');
    fireEvent.change(subjectInput, { target: { value: 'Edited subject' } });
    const bodyInput = screen.getByDisplayValue('Original body');
    fireEvent.change(bodyInput, { target: { value: 'Edited body' } });

    fireEvent.click(screen.getByRole('button', { name: /Save V2/i }));

    await waitFor(() =>
      expect(reviseMock).toHaveBeenCalledWith(
        api,
        'session-1',
        'draft-1',
        expect.objectContaining({
          baseVersionId: 'version-1',
          subject: 'Edited subject',
          body: 'Edited body',
          editKind: 'manual',
        }),
      ),
    );
  });

  it('Edit with Meri (tone/instruction change) calls refineOutreachV3Draft with the base version and the exact instruction typed', async () => {
    renderWorkspace('drafts');

    fireEvent.click(await screen.findByRole('button', { name: /read all/i }));
    fireEvent.click(await screen.findByRole('button', { name: /open draft/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit with meri/i }));

    const instructionBox = await screen.findByPlaceholderText(/make the opening more personal/i);
    fireEvent.change(instructionBox, { target: { value: 'Make the tone warmer and more direct.' } });
    fireEvent.click(screen.getByRole('button', { name: /create new version/i }));

    await waitFor(() =>
      expect(refineMock).toHaveBeenCalledWith(
        api,
        'session-1',
        'draft-1',
        expect.objectContaining({
          baseVersionId: 'version-1',
          instruction: expect.stringContaining('Make the tone warmer and more direct.'),
        }),
      ),
    );
  });

  it('single-recipient regeneration (Edit with Meri on one card) does not touch other drafts — only the targeted draft ID is passed', async () => {
    renderWorkspace('drafts');

    fireEvent.click(await screen.findByRole('button', { name: /read all/i }));
    fireEvent.click(await screen.findByRole('button', { name: /open draft/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit with meri/i }));
    fireEvent.change(await screen.findByPlaceholderText(/make the opening more personal/i), {
      target: { value: 'Shorten this.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create new version/i }));

    await waitFor(() => expect(refineMock).toHaveBeenCalledTimes(1));
    // The only draft id that appears anywhere in the call is draft-1 — there
    // is no bulk/"all drafts" parameter smuggled through.
    const [, , draftIdArg] = refineMock.mock.calls[0]!;
    expect(draftIdArg).toBe('draft-1');
  });

  it('test send calls createOutreachV3TestSend with a fresh request key and the selected recipient, and does not touch final-send state', async () => {
    renderWorkspace('send');
    await screen.findByText(/send one to yourself first/i);
    fireEvent.click(screen.getByRole('button', { name: /send a test to me/i }));

    await waitFor(() => expect(testSendMock).toHaveBeenCalledTimes(1));
    const call = testSendMock.mock.calls[0]!;
    const testInput = call[2] as { testGenerationKey: string; requestKey: string };
    expect(testInput).toMatchObject({ testGenerationKey: 'd1' });
    expect(typeof testInput.requestKey).toBe('string');
    expect(testInput.requestKey).not.toBe('');
    // Test send must never call the final-send mutation.
    expect(createSendIntentMock).not.toHaveBeenCalled();
  });

  it('two separate test sends use two different request keys (each test send is its own idempotent operation, not a shared one)', async () => {
    renderWorkspace('send');
    await screen.findByText(/send one to yourself first/i);

    fireEvent.click(screen.getByRole('button', { name: /send a test to me/i }));
    await waitFor(() => expect(testSendMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /send (a test to me|another test)/i }));
    await waitFor(() => expect(testSendMock).toHaveBeenCalledTimes(2));

    const firstCall = testSendMock.mock.calls[0]!;
    const secondCall = testSendMock.mock.calls[1]!;
    const firstKey = (firstCall[2] as { requestKey: string }).requestKey;
    const secondKey = (secondCall[2] as { requestKey: string }).requestKey;
    expect(firstKey).not.toBe(secondKey);
  });

  it('final send requires the confirmation dialog — clicking "Send" alone does not call createOutreachV3SendIntent', async () => {
    renderWorkspace('send');
    await screen.findByText(/send one to yourself first/i);

    // Run preflight so the send button becomes eligible (canSend requires
    // preflight.eligible).
    fireEvent.click(screen.getByRole('button', { name: /run the checks/i }));
    await waitFor(() => expect(runPreflightMock).toHaveBeenCalledTimes(1));
    // Wait for the preflight RESULT to actually land in component state
    // (not just for the mock to have been called) — the button label
    // flips to "Run them again" only once setPreflight has run.
    await screen.findByRole('button', { name: /run them again/i });

    // The primary send button opens the confirmation dialog — it must NOT
    // call the real-send mutation directly.
    const sendButton = await screen.findByRole('button', { name: /^send \d+ emails?$/i });
    fireEvent.click(sendButton);

    expect(createSendIntentMock).not.toHaveBeenCalled();
    // The confirmation dialog is now open with its own explicit trigger.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/final confirmation/i)).toBeInTheDocument();
  });

  it('final send, once confirmed, calls createOutreachV3SendIntent exactly once with the durable per-session request key', async () => {
    renderWorkspace('send');
    await screen.findByText(/send one to yourself first/i);

    fireEvent.click(screen.getByRole('button', { name: /run the checks/i }));
    await waitFor(() => expect(runPreflightMock).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: /run them again/i });

    const sendButton = await screen.findByRole('button', { name: /^send \d+ emails?$/i });
    fireEvent.click(sendButton);
    const dialog = await screen.findByRole('dialog');

    const keyBeforeConfirm = window.sessionStorage.getItem(
      'outreach-v3:session-1:phase1-send-request',
    );
    expect(keyBeforeConfirm).toBeTruthy();

    // The dialog's own send button is the one and only real-send trigger.
    fireEvent.click(within(dialog).getByRole('button', { name: /^send \d+ emails?$/i }));

    await waitFor(() => expect(createSendIntentMock).toHaveBeenCalledTimes(1));
    const sendCall = createSendIntentMock.mock.calls[0]!;
    const sendInput = sendCall[2] as { requestKey: string };
    // The request key sent to the server is the SAME durable key that was
    // already persisted before confirmation — proving it's a stable
    // idempotency key for this session, not freshly minted per attempt.
    expect(sendInput.requestKey).toBe(keyBeforeConfirm);
  });

  it('manual edit shows a save confirmation instead of silently closing, and surfaces a save failure inside the still-open dialog', async () => {
    renderWorkspace('drafts');

    fireEvent.click(await screen.findByRole('button', { name: /read all/i }));
    fireEvent.click(await screen.findByRole('button', { name: /open draft/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit text/i }));

    // Failure path first: the dialog must show the error INSIDE itself,
    // next to the fields, and must stay open so the user's typed edits are
    // not lost.
    reviseMock.mockRejectedValueOnce({
      response: { data: { message: 'A newer version already exists.' } },
    });
    fireEvent.change(await screen.findByDisplayValue('Original subject'), {
      target: { value: 'Edited subject' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save V2/i }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/newer version already exists/i),
    );
    // Still open — the user has not lost their edit.
    expect(screen.getByDisplayValue('Edited subject')).toBeInTheDocument();

    // Success path: saving now must give a real, visible confirmation (the
    // reported bug was "I can't tell if it's saving the edits") rather than
    // just silently closing the dialog.
    fireEvent.click(screen.getByRole('button', { name: /Save V2/i }));
    await waitFor(() => expect(reviseMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await screen.findByText(/saved as v2/i);
  });

  it('draft history lets you view an older version and restore it as the new current version', async () => {
    listDraftsMock.mockImplementation(async () => [
      draftFixture({
        history: [
          { id: 'version-1', version: 1, generationStatus: 'ready', auditStatus: 'pass', approvalStatus: 'unapproved', createdAt: '2026-08-21T12:00:00.000Z' },
          { id: 'version-2', version: 2, generationStatus: 'ready', auditStatus: 'pass', approvalStatus: 'unapproved', createdAt: '2026-08-21T13:00:00.000Z' },
        ],
      }),
    ]);
    renderWorkspace('drafts');

    fireEvent.click(await screen.findByRole('button', { name: /read all/i }));
    fireEvent.click(await screen.findByRole('button', { name: /open draft/i }));
    // Scoped to the draft card specifically: OutreachConversation's Meri chat
    // panel also has an unrelated "History" toggle (chat turns), so an
    // unscoped query would match two different "History" buttons.
    const card = document.querySelector('.ov3p1-draft-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /^history/i }));

    // V1 is the non-current row here (current is V2, since currentVer…
    // in the base fixture would be inconsistent — history entries drive this,
    // and the fixture's `current.id` is 'version-1', so V1 is current and V2
    // is the one we can restore).
    const v2Row = screen.getByText(/V2 ·/i);
    fireEvent.click(v2Row);

    await waitFor(() => expect(getDraftVersionMock).toHaveBeenCalledWith(api, 'session-1', 'version-2'));
    await waitFor(() => expect(screen.getAllByText('Original subject')).toHaveLength(2));

    const restoreButton = await screen.findByRole('button', { name: /make this the current version/i });
    fireEvent.click(restoreButton);

    await waitFor(() =>
      expect(reviseMock).toHaveBeenCalledWith(
        api,
        'session-1',
        'draft-1',
        expect.objectContaining({
          baseVersionId: 'version-1',
          editKind: 'revert',
        }),
      ),
    );
    await screen.findByText(/restored v2/i);
  });

  it('saving the sending identity shows a visible confirmation, since a successful save looks identical to a silent failure otherwise', async () => {
    renderWorkspace('send');

    const saveButton = await screen.findByRole('button', { name: 'Save sending identity' });
    fireEvent.click(saveButton);

    await waitFor(() => expect(saveSendSettingsMock).toHaveBeenCalledTimes(1));
    expect(saveSendSettingsMock).toHaveBeenCalledWith(
      api,
      'session-1',
      expect.objectContaining({ senderConnectionId: 'conn-1' }),
    );

    // Two independent confirmations: the inline "Saved" chip next to the
    // button (survives even if the toast is missed/dismissed) and the
    // toast itself (matches the manual-edit "Saved as V{n}" convention
    // from the draft-review-ux fix).
    await screen.findByText('Identity saved');
    await screen.findByText('Sending identity saved.');
  });
});
