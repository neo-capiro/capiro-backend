import { describe, it, expect, jest } from '@jest/globals';
import {
  NativeGenerationBridge,
  NativeGenerationRefusal,
  nativeGenerationRequestId,
  parseNativeGenerationIntent,
  type NativeGenerationAdmissionInput,
  type NativeGenerationProposalOwner,
  type NativeGenerationTurnOutcome,
  type NativeGenerationTurnPort,
} from './native-generation.bridge.js';
import { computeOutlineHash } from './document-agent-state.js';

// WS-22 native generation bridge: the approved greenfield owner replaces the
// legacy `WorkspaceReasoningGateway` / `GenerationService` seam for the five
// SUPPORTED generated phases. No network, model or database is touched here —
// the turn port and the proposal owner are plain recorders.
//
// `document-agent-state.ts` computes its hashes through `require('node:crypto')`
// (see that file), so the tests must not assume ESM-only hashing.

const agentState = (over: Partial<NativeGenerationAdmissionInput['state']> = {}) => ({
  schemaVersion: 1,
  revision: 7,
  phase: 'brief' as const,
  status: 'active' as const,
  documentType: { id: 'dt-1', label: 'Appropriations request', product: 'legislative' as const },
  blueprintPin: {
    blueprintId: 'bp-1',
    versionId: 'bpv-3',
    version: 3,
    definitionHash: 'b'.repeat(64),
  },
  theme: null,
  goal: { text: 'Increase federal research funding', createdAt: '2026-10-28T00:00:00.000Z' },
  brief: { assumptions: [], provenance: {}, objective: 'Secure $5M for the program' },
  contextPlan: { includedItemIds: ['ctx-1'], excludedItems: [], conflicts: [], coverage: { plannedClaims: 0, supportedClaims: 0, missingClaims: [] } },
  outline: { version: 1, sections: [{ id: 's1', title: 'Ask', purpose: 'state the ask' } as never] },
  generation: { mode: 'standard' as const },
  ...over,
}) as NativeGenerationAdmissionInput['state'];

const approved = () =>
  agentState({
    brief: { assumptions: [], provenance: {}, objective: 'Secure $5M', approvedAt: '2026-10-28T00:00:00.000Z' } as never,
    contextPlan: { includedItemIds: ['ctx-1'], excludedItems: [], conflicts: [], coverage: { plannedClaims: 0, supportedClaims: 0, missingClaims: [] }, approvedAt: '2026-10-28T00:00:00.000Z' } as never,
    outline: { version: 1, sections: [], approvedAt: '2026-10-28T00:00:00.000Z' } as never,
  });

type Recorders = {
  turn: jest.Mock;
  readTurn: jest.Mock;
  cancel: jest.Mock;
  createProposal: jest.Mock;
  port: NativeGenerationTurnPort;
  proposals: NativeGenerationProposalOwner;
  setOutcome: (outcome: NativeGenerationTurnOutcome) => void;
  setRead: (outcome: NativeGenerationTurnOutcome | null) => void;
};

function recorders(): Recorders {
  let next: NativeGenerationTurnOutcome = { status: 'unknown' } as never;
  let read: NativeGenerationTurnOutcome | null = null;
  const turn = jest.fn(async (request: unknown) => {
    const outcome = { ...(next as object) } as NativeGenerationTurnOutcome;
    if (outcome.status === 'unknown') return { status: 'unknown', requestId: (request as { requestId: string }).requestId } as NativeGenerationTurnOutcome;
    return outcome;
  });
  const readTurn = jest.fn(async () => read);
  const cancel = jest.fn(async () => undefined);
  const createProposal = jest.fn(async () => ({ proposalId: 'prop-1' }));
  return {
    turn,
    readTurn,
    cancel,
    createProposal,
    port: { turn, readTurn, cancel } as unknown as NativeGenerationTurnPort,
    proposals: { createProposal } as unknown as NativeGenerationProposalOwner,
    setOutcome: (outcome) => {
      next = outcome;
    },
    setRead: (outcome) => {
      read = outcome;
    },
  };
}

const intent = true;

function input(
  phase: NativeGenerationAdmissionInput['phase'],
  over: Partial<NativeGenerationAdmissionInput> = {},
): NativeGenerationAdmissionInput {
  return {
    state: agentState(),
    phase,
    tenantId: 'tenant-a',
    actorId: 'user_2abc',
    draftId: 'draft-9',
    clientId: 'client-4',
    expectedRevision: 7,
    sources: [
      { id: 'draft-9', kind: 'workspace-draft' },
      { id: 'ctx-1', kind: 'context-item' },
    ],
    intent,
    credential: 'session-credential',
    ...over,
  } as NativeGenerationAdmissionInput;
}

describe('native generation intent', () => {
  it('accepts only the truthful explicit paid intent', () => {
    expect(parseNativeGenerationIntent(true)).toEqual({ acknowledged: true });
    expect(() => parseNativeGenerationIntent(undefined)).toThrow(NativeGenerationRefusal);
    expect(() => parseNativeGenerationIntent('true')).toThrow(NativeGenerationRefusal);
    expect(() => parseNativeGenerationIntent({ acknowledged: true })).toThrow(NativeGenerationRefusal);
    expect(() => parseNativeGenerationIntent(false)).toThrow(NativeGenerationRefusal);
  });

  it('refuses a phase without the explicit intent before any turn', async () => {
    const r = recorders();
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    await expect(bridge.admit(input('brief', { intent: undefined }))).rejects.toMatchObject({ code: 'intent-required' });
    await expect(bridge.admit(input('brief', { intent: { acknowledged: false } as never }))).rejects.toMatchObject({ code: 'intent-required' });
    expect(r.turn).not.toHaveBeenCalled();
  });

  it('refuses a phase without the current session credential before any turn', async () => {
    const r = recorders();
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    await expect(bridge.admit(input('brief', { credential: undefined }))).rejects.toMatchObject({ code: 'credential-required' });
    await expect(bridge.cancel({ requestId: `wsgen:${'ab'.repeat(32)}`, tenantId: 'tenant-a', actorId: 'user_2abc', draftId: 'draft-9', clientId: 'client-4' }, '')).rejects.toMatchObject({ code: 'credential-required' });
    expect(r.turn).not.toHaveBeenCalled();
    expect(r.cancel).not.toHaveBeenCalled();
  });
});

describe('native generation admission', () => {
  it('issues exactly one turn with the exact identity, sources and paid flag', async () => {
    const r = recorders();
    r.setOutcome({
      status: 'complete',
      runId: 'run-1',
      result: { brief: { assumptions: [], provenance: {} } as never },
    } as NativeGenerationTurnOutcome);
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    const admission = await bridge.admit(input('brief'));

    expect(r.turn).toHaveBeenCalledTimes(1);
    const sent = r.turn.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      paidGeneration: true,
      phase: 'brief',
      tenantId: 'tenant-a',
      actorId: 'user_2abc',
      draftId: 'draft-9',
      clientId: 'client-4',
      expectedRevision: 7,
    });
    expect(sent.requestId).toBe(
      nativeGenerationRequestId({
        tenantId: 'tenant-a',
        actorId: 'user_2abc',
        draftId: 'draft-9',
        clientId: 'client-4',
        phase: 'brief',
        expectedRevision: 7,
        sources: input('brief').sources,
      }),
    );
    expect(admission.kind).toBe('result');
    // A brief is applied by the document-agent's own state owner, not a proposal.
    expect(r.createProposal).not.toHaveBeenCalled();
  });

  it('derives the same request identity for the same request and a different one for any scope change', async () => {
    const r = recorders();
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    const base = (await bridge.admit(input('brief'))).requestId;
    expect((await bridge.admit(input('brief'))).requestId).toBe(base);
    expect((await bridge.admit(input('brief', { sources: [...input('brief').sources].reverse() }))).requestId).toBe(base);
    for (const changed of [
      input('brief', { tenantId: 'tenant-b' }),
      input('brief', { actorId: 'user_other' }),
      input('brief', { clientId: 'client-5' }),
      input('brief', { draftId: 'draft-10' }),
      input('brief', { expectedRevision: 8 }),
      input('outline', { state: agentState() }),
    ])
      expect((await bridge.admit(changed)).requestId).not.toBe(base);
  });

  it('refuses a phase the current state does not admit', async () => {
    const r = recorders();
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    await expect(bridge.admit(input('brief', { state: agentState({ goal: null }) }))).rejects.toMatchObject({ code: 'phase-gate' });
    await expect(bridge.admit(input('outline', { state: agentState({ blueprintPin: null }) }))).rejects.toMatchObject({ code: 'phase-gate' });
    await expect(bridge.admit(input('document'))).rejects.toMatchObject({ code: 'phase-gate' });
    expect(r.turn).not.toHaveBeenCalled();
  });

  it('refuses explicitly when no approved owner is composed instead of falling back', async () => {
    const r = recorders();
    const bridge = new NativeGenerationBridge({ proposals: r.proposals });
    expect(bridge.available()).toBe(false);
    await expect(bridge.admit(input('brief'))).rejects.toBeInstanceOf(NativeGenerationRefusal);
    await expect(bridge.admit(input('brief'))).rejects.toMatchObject({ code: 'owner-unavailable' });
    expect(r.createProposal).not.toHaveBeenCalled();
  });

  it('admits an outline as a pending proposal with the accept path type and base hash', async () => {
    const r = recorders();
    const sections = [{ id: 's1', title: 'The ask', purpose: 'state it' }];
    r.setOutcome({ status: 'complete', runId: 'run-2', result: { outline: sections as never } } as NativeGenerationTurnOutcome);
    const state = agentState();
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    const admission = await bridge.admit(input('outline', { state, expectedRevision: 7 }));

    expect(admission.kind).toBe('proposed');
    expect(admission).toMatchObject({ proposalId: 'prop-1', runId: 'run-2' });
    const created = r.createProposal.mock.calls[0]![0] as Record<string, unknown>;
    expect(created).toMatchObject({
      tenantId: 'tenant-a',
      draftId: 'draft-9',
      createdById: 'user_2abc',
      type: 'outline_revision',
      baseRevision: 7,
    });
    // acceptProposal recomputes this hash; a different one would make every
    // acceptance stale.
    expect(created.baseHash).toBe(computeOutlineHash(state.outline.sections as never));
    expect((created.payload as { outlineSnapshot: unknown }).outlineSnapshot).toEqual(sections);
    // The outline itself is never written here.
    expect(state.outline.sections).toHaveLength(1);
  });

  it('never lets a complete document body through this bridge', async () => {
    const r = recorders();
    r.setOutcome({ status: 'complete', runId: 'run-3', result: {} } as NativeGenerationTurnOutcome);
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    // The document phase is now admitted by THIS bridge as a pending content
    // revision, but only after it verifies that the native body keys the
    // approved outline's sections exactly. A body that carries no document at
    // all is refused on that phase gate — the older `document-owner` code is no
    // longer thrown anywhere, so it can never be the observed refusal here.
    await expect(
      bridge.admit(input('document', { state: approved() })),
    ).rejects.toMatchObject({ code: 'phase-gate' });
    expect(r.createProposal).not.toHaveBeenCalled();
  });

  it('keeps the exact run and proposal ids on an approval-required document admission', async () => {
    const r = recorders();
    r.setOutcome({ status: 'approval_required', runId: 'run-4', proposalId: 'prop-4' } as NativeGenerationTurnOutcome);
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    await expect(bridge.admit(input('document', { state: approved() }))).resolves.toMatchObject({
      kind: 'approval-required',
      runId: 'run-4',
      proposalId: 'prop-4',
    });
  });
});

describe('UNKNOWN reconciliation and cancel', () => {
  it('reports the exact request id and reconciles by reading it, never by re-issuing a turn', async () => {
    const r = recorders();
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    const first = await bridge.admit(input('brief'));
    expect(first.kind).toBe('unknown');
    const expected = (r.turn.mock.calls[0]![0] as { requestId: string }).requestId;
    expect(first.requestId).toBe(expected);

    r.setRead({ status: 'complete', runId: 'run-5', result: { brief: { assumptions: [], provenance: {} } as never } } as NativeGenerationTurnOutcome);
    await expect(bridge.reconcile(input('brief'))).resolves.toMatchObject({ kind: 'result', requestId: expected });
    expect(r.readTurn).toHaveBeenCalledWith(expect.objectContaining({ requestId: expected }), 'session-credential');
    expect(r.turn).toHaveBeenCalledTimes(1);

    r.setRead(null);
    await expect(bridge.reconcile(input('brief'))).resolves.toMatchObject({ kind: 'unknown', requestId: expected });
    expect(r.turn).toHaveBeenCalledTimes(1);
  });

  it('cancels the exact retained request and refuses a forged identity', async () => {
    const r = recorders();
    const bridge = new NativeGenerationBridge({ turn: r.port, proposals: r.proposals });
    const admission = await bridge.admit(input('brief'));
    const subject = { requestId: admission.requestId, tenantId: 'tenant-a', actorId: 'user_2abc', draftId: 'draft-9', clientId: 'client-4' };
    await bridge.cancel(subject, 'session-credential');
    expect(r.cancel).toHaveBeenCalledWith(subject, 'session-credential');
    await expect(bridge.cancel({ ...subject, requestId: 'not-a-request-id' }, 'session-credential')).rejects.toMatchObject({ code: 'request-identity' });
    expect(r.cancel).toHaveBeenCalledTimes(1);
  });
});
