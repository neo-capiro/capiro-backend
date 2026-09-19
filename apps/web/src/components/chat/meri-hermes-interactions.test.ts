import { describe, expect, it } from 'vitest';
import {
  clearHermesRunPointer,
  hermesApprovalCardFromFrame,
  hermesApprovalUrl,
  hermesClarifyCardFromFrame,
  hermesClarificationUrl,
  hermesInteractionCardFromProjection,
  hermesRunEventsUrl,
  hermesRunStatusLabel,
  hermesRunUrl,
  hermesStopUrl,
  isHermesInteractionExpired,
  isHermesRunTerminal,
  mergeHermesInteractionsFromProjection,
  outstandingHermesInteractions,
  readHermesRunPointer,
  readHermesRunProjection,
  resolveHermesInteraction,
  upsertHermesInteraction,
  writeHermesRunPointer,
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

describe('sessionStorage-backed run pointer', () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  }

  it('round-trips a pointer for a conversation', () => {
    const storage = memoryStorage();
    expect(readHermesRunPointer(storage, 'conv-1')).toBeNull();
    writeHermesRunPointer(storage, 'conv-1', { runId: 'run-1' });
    expect(readHermesRunPointer(storage, 'conv-1')).toEqual({ runId: 'run-1' });
    clearHermesRunPointer(storage, 'conv-1');
    expect(readHermesRunPointer(storage, 'conv-1')).toBeNull();
  });

  it('keeps pointers for different conversations independent', () => {
    const storage = memoryStorage();
    writeHermesRunPointer(storage, 'conv-1', { runId: 'run-1' });
    writeHermesRunPointer(storage, 'conv-2', { runId: 'run-2' });
    expect(readHermesRunPointer(storage, 'conv-1')?.runId).toBe('run-1');
    expect(readHermesRunPointer(storage, 'conv-2')?.runId).toBe('run-2');
  });

  it('is inert without a conversation id or storage (never throws)', () => {
    expect(readHermesRunPointer(null, 'conv-1')).toBeNull();
    expect(readHermesRunPointer({} as never, '')).toBeNull();
    expect(() => writeHermesRunPointer(null, 'conv-1', { runId: 'run-1' })).not.toThrow();
    expect(() => clearHermesRunPointer(null, 'conv-1')).not.toThrow();
  });

  it('never throws on malformed stored JSON', () => {
    const storage = memoryStorage();
    storage.setItem('meri-hermes-run:conv-1', '{not json');
    expect(readHermesRunPointer(storage, 'conv-1')).toBeNull();
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
    expect(hermesStopUrl(base, 'run-1')).toBe('https://api.test/api/clio/hermes/runs/run-1/stop');
    expect(hermesApprovalUrl(base, 'run-1')).toBe('https://api.test/api/clio/hermes/runs/run-1/approval');
    expect(hermesClarificationUrl(base, 'run-1')).toBe(
      'https://api.test/api/clio/hermes/runs/run-1/clarification',
    );
  });
});
