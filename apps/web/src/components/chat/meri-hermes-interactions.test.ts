import { describe, expect, it } from 'vitest';
import {
  hermesActiveConversationUrl,
  hermesApprovalBlockedReason,
  hermesApprovalCardFromFrame,
  hermesApprovalUrl,
  hermesClarifyCardFromFrame,
  hermesClarificationUrl,
  hermesInteractionCardFromActive,
  hermesInteractionCardFromProjection,
  hermesRunEventsUrl,
  hermesRunIsGenerating,
  hermesRunStatusLabel,
  hermesRunUrl,
  hermesStopUrl,
  isHermesInteractionExpired,
  isHermesRunTerminal,
  markHermesRunTerminal,
  mergeHermesInteractionsFromActive,
  mergeHermesInteractionsFromProjection,
  outstandingHermesInteractions,
  readHermesActiveConversation,
  readHermesRunProjection,
  resolveHermesInteraction,
  upsertHermesInteraction,
  type MeriHermesApprovalCard,
  type MeriHermesInteractionCard,
  type RawHermesProjectedInteraction,
} from './meri-hermes-interactions.js';

describe('isHermesRunTerminal', () => {
  it('treats completed/cancelled/failed/interrupted/expired as terminal', () => {
    for (const status of ['completed', 'cancelled', 'failed', 'interrupted', 'expired']) {
      expect(isHermesRunTerminal(status)).toBe(true);
    }
  });
  it('treats queued/provisioning/running/waiting_for_*/cancelling as non-terminal', () => {
    for (const status of [
      'queued',
      'provisioning',
      'running',
      'waiting_for_approval',
      'waiting_for_clarification',
      'cancelling',
    ]) {
      expect(isHermesRunTerminal(status)).toBe(false);
    }
  });
  it('treats an unknown or missing status as non-terminal', () => {
    expect(isHermesRunTerminal('bogus')).toBe(false);
    expect(isHermesRunTerminal(null)).toBe(false);
    expect(isHermesRunTerminal(undefined)).toBe(false);
  });
});

describe('hermesRunStatusLabel', () => {
  it('labels every documented status', () => {
    expect(hermesRunStatusLabel('queued')).toBe('Queued');
    expect(hermesRunStatusLabel('waiting_for_approval')).toBe('Waiting for your approval');
    expect(hermesRunStatusLabel('waiting_for_clarification')).toBe('Waiting for your answer');
    expect(hermesRunStatusLabel('cancelling')).toBe('Stopping…');
    expect(hermesRunStatusLabel('interrupted')).toBe('Interrupted');
  });
  it('falls back to a neutral label for an unrecognized status', () => {
    expect(hermesRunStatusLabel('made-up')).toBe('Working');
  });
});

describe('hermesApprovalCardFromFrame', () => {
  const frame = {
    type: 'pending_approval' as const,
    runtime: 'hermes',
    tool: 'terminal',
    label: 'Run: rm -rf build/',
    proposalId: 'hermes:run-1:req-1',
    reason: 'Run: rm -rf build/',
    expiresAt: '2026-09-19T00:05:00.000Z',
    preview: { fields: { command: 'rm -rf build/' } },
    interaction: { requestId: 'req-1', choices: ['once', 'deny'], continuation: 'live_process' as const },
  };

  it('parses a native Hermes approval frame into a card', () => {
    const card = hermesApprovalCardFromFrame(frame, 'run-1', '2026-09-19T00:00:00.000Z');
    expect(card).toEqual({
      kind: 'approval',
      runId: 'run-1',
      requestId: 'req-1',
      proposalId: 'hermes:run-1:req-1',
      label: 'Run: rm -rf build/',
      command: 'rm -rf build/',
      choices: ['once', 'deny'],
      createdAt: '2026-09-19T00:00:00.000Z',
      expiresAt: '2026-09-19T00:05:00.000Z',
      resolution: null,
    });
  });

  it('returns null for a business-action approval (no runtime:"hermes")', () => {
    const { runtime, ...businessFrame } = frame;
    void runtime;
    expect(hermesApprovalCardFromFrame(businessFrame, 'run-1')).toBeNull();
  });

  it('returns null when the frame is missing interaction.requestId', () => {
    expect(hermesApprovalCardFromFrame({ ...frame, interaction: null }, 'run-1')).toBeNull();
  });

  it('defaults choices to once/deny and derives a proposalId when absent', () => {
    const card = hermesApprovalCardFromFrame(
      { runtime: 'hermes', reason: 'Guarded command', interaction: { requestId: 'req-2' } },
      'run-9',
    );
    expect(card?.choices).toEqual(['once', 'deny']);
    expect(card?.proposalId).toBe('hermes:run-9:req-2');
    expect(card?.command).toBeNull();
  });
});

describe('hermesClarifyCardFromFrame', () => {
  const frame = {
    type: 'clarify' as const,
    runtime: 'hermes',
    requestId: 'clar-1',
    questions: [{ id: 'clar-1', question: 'Which client?', choices: ['Acme', 'Globex'], multiSelect: false }],
    continuation: 'durable_continuation' as const,
  };

  it('parses a durable clarification frame into a card', () => {
    const card = hermesClarifyCardFromFrame(frame, 'run-1', '2026-09-19T00:00:00.000Z');
    expect(card).toEqual({
      kind: 'clarification',
      runId: 'run-1',
      requestId: 'clar-1',
      question: 'Which client?',
      choices: ['Acme', 'Globex'],
      multiSelect: false,
      createdAt: '2026-09-19T00:00:00.000Z',
      resolution: null,
    });
  });

  it('returns null for a non-Hermes frame or a missing question', () => {
    const { runtime, ...noRuntime } = frame;
    void runtime;
    expect(hermesClarifyCardFromFrame(noRuntime, 'run-1')).toBeNull();
    expect(hermesClarifyCardFromFrame({ runtime: 'hermes', questions: [] }, 'run-1')).toBeNull();
  });
});

describe('upsertHermesInteraction / resolveHermesInteraction / outstandingHermesInteractions', () => {
  const approval: MeriHermesApprovalCard = {
    kind: 'approval',
    runId: 'run-1',
    requestId: 'req-1',
    proposalId: 'hermes:run-1:req-1',
    label: 'Guarded command',
    command: 'rm file',
    choices: ['once', 'deny'],
    createdAt: '2026-09-19T00:00:00.000Z',
    expiresAt: '2026-09-19T00:05:00.000Z',
    resolution: null,
  };

  it('appends a new card and replaces an existing one by requestId (pure)', () => {
    const first = upsertHermesInteraction([], approval);
    expect(first).toHaveLength(1);
    const updated: MeriHermesApprovalCard = { ...approval, label: 'Updated label' };
    const second = upsertHermesInteraction(first, updated);
    expect(second).toHaveLength(1);
    expect((second[0] as MeriHermesApprovalCard)?.label).toBe('Updated label');
    // pure: the input array is untouched
    expect((first[0] as MeriHermesApprovalCard)?.label).toBe('Guarded command');
  });

  it('never un-resolves a card a later still-pending copy arrives for (no double-apply)', () => {
    // A duplicate frame, or a discovery read taken before the server saw the
    // answer, must not offer the user a second decision on a spent request.
    const answered = upsertHermesInteraction([], {
      ...approval,
      resolution: { decision: 'deny', at: '2026-09-19T00:01:00.000Z' },
    });
    const restated = upsertHermesInteraction(answered, approval);
    expect(restated[0]?.resolution).toEqual({ decision: 'deny', at: '2026-09-19T00:01:00.000Z' });
    expect(outstandingHermesInteractions(restated)).toEqual([]);
  });

  it('never un-marks a run that has ended', () => {
    const ended = upsertHermesInteraction([], { ...approval, runTerminal: true });
    expect(upsertHermesInteraction(ended, approval)[0]?.runTerminal).toBe(true);
  });

  it('resolves a card by requestId without touching others', () => {
    const other: MeriHermesInteractionCard = { ...approval, requestId: 'req-2' };
    const list = [approval, other];
    const resolved = resolveHermesInteraction(list, 'req-1', {
      decision: 'approve_once',
      at: '2026-09-19T00:01:00.000Z',
    });
    expect(resolved[0]?.resolution).toEqual({ decision: 'approve_once', at: '2026-09-19T00:01:00.000Z' });
    expect(resolved[1]?.resolution).toBeNull();
  });

  it('outstanding excludes resolved cards', () => {
    const resolved = { ...approval, resolution: { decision: 'deny' as const, at: '2026-09-19T00:01:00.000Z' } };
    expect(outstandingHermesInteractions([resolved])).toEqual([]);
    expect(outstandingHermesInteractions([approval])).toEqual([approval]);
  });
});

describe('isHermesInteractionExpired', () => {
  const approval: MeriHermesInteractionCard = {
    kind: 'approval',
    runId: 'run-1',
    requestId: 'req-1',
    proposalId: 'hermes:run-1:req-1',
    label: 'Guarded command',
    command: null,
    choices: ['once', 'deny'],
    createdAt: '2026-09-19T00:00:00.000Z',
    expiresAt: '2026-09-19T00:05:00.000Z',
    resolution: null,
  };

  it('is expired once now passes expiresAt', () => {
    const before = Date.parse('2026-09-19T00:04:59.000Z');
    const after = Date.parse('2026-09-19T00:05:01.000Z');
    expect(isHermesInteractionExpired(approval, before)).toBe(false);
    expect(isHermesInteractionExpired(approval, after)).toBe(true);
  });

  it('clarification cards never expire client-side (durable continuation)', () => {
    const clarify: MeriHermesInteractionCard = {
      kind: 'clarification',
      runId: 'run-1',
      requestId: 'clar-1',
      question: 'Which client?',
      choices: [],
      multiSelect: false,
      createdAt: '2026-09-19T00:00:00.000Z',
      resolution: null,
    };
    expect(isHermesInteractionExpired(clarify, Date.parse('2099-01-01T00:00:00.000Z'))).toBe(false);
  });
});

describe('readHermesRunProjection / hermesInteractionCardFromProjection / mergeHermesInteractionsFromProjection', () => {
  const rawInteraction: RawHermesProjectedInteraction = {
    requestId: 'req-1',
    kind: 'approval',
    prompt: 'Run: rm -rf build/',
    choices: ['once', 'deny'],
    multiSelect: false,
    continuation: 'live_process',
    createdAt: '2026-09-19T00:00:00.000Z',
    expiresAt: '2026-09-19T00:05:00.000Z',
    resolved: false,
    decision: null,
  };

  it('parses a valid run projection, including unresolved and resolved interactions', () => {
    const projection = readHermesRunProjection({
      runId: 'run-1',
      status: 'waiting_for_approval',
      finishReason: null,
      partial: false,
      error: null,
      lastSeq: 12,
      pendingInteractions: [rawInteraction],
    });
    expect(projection?.status).toBe('waiting_for_approval');
    expect(projection?.lastSeq).toBe(12);
    expect(projection?.pendingInteractions).toEqual([rawInteraction]);
  });

  it('carries the output snapshot and its seq — the cursor reconnect resumes from', () => {
    const projection = readHermesRunProjection({
      runId: 'run-1',
      status: 'running',
      lastSeq: 1240,
      outputSnapshot: 'assistant text so far',
      outputSeq: 1234,
      pendingInteractions: [],
    });
    expect(projection?.outputSnapshot).toBe('assistant text so far');
    expect(projection?.outputSeq).toBe(1234);
  });

  it('defaults a missing/invalid snapshot cursor to empty text at seq 0', () => {
    const projection = readHermesRunProjection({ runId: 'run-1', status: 'running' });
    expect(projection?.outputSnapshot).toBe('');
    expect(projection?.outputSeq).toBe(0);
    expect(readHermesRunProjection({ runId: 'r', status: 'running', outputSeq: -4 })?.outputSeq).toBe(0);
  });

  it('returns null for a malformed or unrecognized-status projection', () => {
    expect(readHermesRunProjection(null)).toBeNull();
    expect(readHermesRunProjection({ runId: 'run-1', status: 'not-a-status' })).toBeNull();
  });

  it('converts a resolved approval interaction into a resolved card', () => {
    const card = hermesInteractionCardFromProjection(
      { ...rawInteraction, resolved: true, decision: 'deny' },
      'run-1',
    );
    expect(card.kind).toBe('approval');
    expect(card.resolution).toEqual({ decision: 'deny', at: rawInteraction.createdAt });
  });

  it('converts a clarification interaction into a clarify card', () => {
    const card = hermesInteractionCardFromProjection(
      {
        ...rawInteraction,
        kind: 'clarification',
        prompt: 'Which client?',
        choices: ['Acme', 'Globex'],
        continuation: 'durable_continuation',
      },
      'run-1',
    );
    expect(card).toMatchObject({ kind: 'clarification', question: 'Which client?', choices: ['Acme', 'Globex'] });
  });

  it('merges projected interactions into the existing list, upserting by requestId and never dropping local rows', () => {
    const localOnly: MeriHermesInteractionCard = {
      kind: 'clarification',
      runId: 'run-1',
      requestId: 'clar-local',
      question: 'Locally known question',
      choices: [],
      multiSelect: false,
      createdAt: '2026-09-19T00:00:00.000Z',
      resolution: null,
    };
    const merged = mergeHermesInteractionsFromProjection([localOnly], [rawInteraction], 'run-1');
    expect(merged.map((c) => c.requestId).sort()).toEqual(['clar-local', 'req-1']);
  });
});

describe('readHermesActiveConversation (discovery)', () => {
  const payload = {
    run: {
      runId: 'run-9',
      status: 'running',
      finishReason: null,
      partial: false,
      detached: false,
      outputSnapshot: 'assistant text so far',
      outputSeq: 1234,
      lastSeq: 1240,
      hermesRunId: 'hermes-run-9',
      hermesSessionId: 'hermes-session-9',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:01:00.000Z',
      finishedAt: null,
    },
    pendingInteractions: [
      {
        runId: 'run-9',
        requestId: 'clar_1',
        kind: 'clarification',
        continuation: 'durable_continuation',
        prompt: 'Which client?',
        choices: ['Acme', 'Globex'],
        multiSelect: false,
        createdAt: '2026-09-19T00:00:30.000Z',
        expiresAt: null,
      },
    ],
  };

  it('parses the active run and its pending interactions', () => {
    const active = readHermesActiveConversation(payload);
    expect(active?.run).toMatchObject({
      runId: 'run-9',
      status: 'running',
      outputSnapshot: 'assistant text so far',
      outputSeq: 1234,
      lastSeq: 1240,
    });
    expect(active?.pendingInteractions).toHaveLength(1);
    expect(active?.pendingInteractions[0]).toMatchObject({ requestId: 'clar_1', runId: 'run-9' });
  });

  it('parses "no active run, but a question still outstanding" — the case a per-tab pointer could never represent', () => {
    const active = readHermesActiveConversation({
      run: null,
      pendingInteractions: [{ ...payload.pendingInteractions[0], runId: 'run-finished' }],
    });
    expect(active?.run).toBeNull();
    expect(active?.pendingInteractions).toHaveLength(1);
  });

  it('drops malformed rows instead of rejecting the whole payload', () => {
    const active = readHermesActiveConversation({
      run: { runId: 'run-9', status: 'not-a-status' },
      pendingInteractions: [{ requestId: 'x' }, { runId: 'r', requestId: 'y', kind: 'nope' }, payload.pendingInteractions[0]],
    });
    expect(active?.run).toBeNull();
    expect(active?.pendingInteractions.map((i) => i.requestId)).toEqual(['clar_1']);
  });

  it('returns null only for a non-object payload', () => {
    expect(readHermesActiveConversation(null)).toBeNull();
    expect(readHermesActiveConversation('nope')).toBeNull();
    expect(readHermesActiveConversation({})).toEqual({ run: null, pendingInteractions: [] });
  });
});

describe('hermesInteractionCardFromActive / mergeHermesInteractionsFromActive', () => {
  const clarification = {
    runId: 'run-finished',
    requestId: 'clar_1',
    kind: 'clarification' as const,
    continuation: 'durable_continuation' as const,
    prompt: 'Which client?',
    choices: ['Acme'],
    multiSelect: false,
    createdAt: '2026-09-19T00:00:30.000Z',
    expiresAt: null,
  };

  it('marks an interaction whose run is no longer the active one as run-terminal', () => {
    const card = hermesInteractionCardFromActive(clarification, 'run-live');
    expect(card).toMatchObject({ kind: 'clarification', runId: 'run-finished', runTerminal: true });
    // …and it is still unresolved, i.e. still answerable.
    expect(card.resolution).toBeNull();
  });

  it('leaves an interaction belonging to the active run actionable', () => {
    const card = hermesInteractionCardFromActive({ ...clarification, runId: 'run-live' }, 'run-live');
    expect(card.runTerminal).toBe(false);
  });

  it('treats every interaction as run-terminal when there is no active run at all', () => {
    const merged = mergeHermesInteractionsFromActive([], {
      run: null,
      pendingInteractions: [clarification, { ...clarification, requestId: 'req_2', kind: 'approval' as const }],
    });
    expect(merged).toHaveLength(2);
    expect(merged.every((c) => c.runTerminal)).toBe(true);
  });
});

describe('markHermesRunTerminal', () => {
  const clarify: MeriHermesInteractionCard = {
    kind: 'clarification',
    runId: 'run-1',
    requestId: 'clar-1',
    question: 'Which client?',
    choices: [],
    multiSelect: false,
    createdAt: '2026-09-19T00:00:00.000Z',
    resolution: null,
  };

  it('marks only the named run and leaves the card answerable', () => {
    const other: MeriHermesInteractionCard = { ...clarify, runId: 'run-2', requestId: 'clar-2' };
    const marked = markHermesRunTerminal([clarify, other], 'run-1');
    expect(marked[0]?.runTerminal).toBe(true);
    expect(marked[0]?.resolution).toBeNull();
    expect(marked[1]?.runTerminal).toBeUndefined();
  });

  it('returns the same array when nothing changes (stable identity for React)', () => {
    const list = [clarify];
    expect(markHermesRunTerminal(list, 'run-404')).toBe(list);
  });
});

describe('hermesApprovalBlockedReason', () => {
  const approval: MeriHermesApprovalCard = {
    kind: 'approval',
    runId: 'run-1',
    requestId: 'req-1',
    proposalId: 'hermes:run-1:req-1',
    label: 'Guarded command',
    command: null,
    choices: ['once', 'deny'],
    createdAt: '2026-09-19T00:00:00.000Z',
    expiresAt: '2026-09-19T00:05:00.000Z',
    resolution: null,
  };
  const before = Date.parse('2026-09-19T00:01:00.000Z');

  it('is unblocked while live, unexpired and unanswered', () => {
    expect(hermesApprovalBlockedReason(approval, before)).toBeNull();
  });

  it('blocks a duplicate response on an already-answered request', () => {
    const resolved = { ...approval, resolution: { decision: 'deny' as const, at: '2026-09-19T00:02:00.000Z' } };
    expect(hermesApprovalBlockedReason(resolved, before)).toBe('resolved');
  });

  it('blocks a native approval whose run has ended — the backend refuses it', () => {
    expect(hermesApprovalBlockedReason({ ...approval, runTerminal: true }, before)).toBe('run_ended');
  });

  it('blocks an expired approval', () => {
    expect(hermesApprovalBlockedReason(approval, Date.parse('2026-09-19T00:06:00.000Z'))).toBe('expired');
  });
});

describe('hermesRunIsGenerating', () => {
  it('is true only while the run is actually producing output', () => {
    for (const status of ['queued', 'provisioning', 'running', 'waiting_for_approval', 'cancelling']) {
      expect(hermesRunIsGenerating(status)).toBe(true);
    }
  });

  it('is false for a run that ended its turn awaiting a durable clarification', () => {
    // Otherwise the composer stays disabled and the question cannot be answered.
    expect(hermesRunIsGenerating('waiting_for_clarification')).toBe(false);
  });

  it('is false for every terminal status and for nonsense', () => {
    for (const status of ['completed', 'cancelled', 'failed', 'interrupted', 'expired']) {
      expect(hermesRunIsGenerating(status)).toBe(false);
    }
    expect(hermesRunIsGenerating(null)).toBe(false);
  });
});

describe('control-surface URL builders', () => {
  const base = 'https://api.test';
  it('build every documented route (contracts.md §5)', () => {
    expect(hermesRunUrl(base, 'run 1')).toBe('https://api.test/api/clio/hermes/runs/run%201');
    expect(hermesRunEventsUrl(base, 'run-1')).toBe(
      'https://api.test/api/clio/hermes/runs/run-1/events?after=0',
    );
    expect(hermesRunEventsUrl(base, 'run-1', 42)).toBe(
      'https://api.test/api/clio/hermes/runs/run-1/events?after=42',
    );
    expect(hermesRunEventsUrl(base, 'run-1', -5)).toBe(
      'https://api.test/api/clio/hermes/runs/run-1/events?after=0',
    );
    expect(hermesActiveConversationUrl(base, 'conv 1')).toBe(
      'https://api.test/api/clio/hermes/conversations/conv%201/active',
    );
    expect(hermesStopUrl(base, 'run-1')).toBe('https://api.test/api/clio/hermes/runs/run-1/stop');
    expect(hermesApprovalUrl(base, 'run-1')).toBe('https://api.test/api/clio/hermes/runs/run-1/approval');
    expect(hermesClarificationUrl(base, 'run-1')).toBe(
      'https://api.test/api/clio/hermes/runs/run-1/clarification',
    );
  });
});
