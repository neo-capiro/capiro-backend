import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { currentMeriGovernedRuntime } from './meri-context-plane-runtime.js';
import { createMeriRuntimeService } from './meriv3-runtime.proxy.js';

jest.mock('./meri-context-plane-runtime.js', () => ({
  currentMeriGovernedRuntime: jest.fn(),
}));

const initial = {
  version: 1,
  complete: false,
  requestedDomains: ['institutional_knowledge'],
  searchedDomains: ['institutional_knowledge'],
  missingDomains: ['institutional_knowledge'],
  partialDomains: [],
  requestedEntityCount: 1,
  searchedEntityCount: 0,
  recordsReturned: 250,
  recordsEvaluated: 2020,
  paginationComplete: false,
  truncated: false,
  sourceHealth: [
    { source: 'institutional_knowledge', status: 'error', detail: 'adapter_execution_failed' },
  ],
  unavailableSources: [
    { source: 'institutional_knowledge', reason: 'adapter_execution_failed' },
  ],
  toolsInvoked: ['retrieval-v2:institutional_knowledge'],
  stopReason: 'source_error',
} as const;

function fixture() {
  const governed = {
    contextPacket: { packetId: 'signed-packet', items: [], exclusions: [] },
    retrieval: {
      plan: { subjectScope: 'client', requiredDomains: ['institutional_knowledge'] },
      coverage: initial,
    },
  } as unknown as MeriGovernedTurnContext;
  jest.mocked(currentMeriGovernedRuntime).mockReturnValue({ context: governed, activeClient: null });
  const raw = {
    orchestrateContext: jest.fn(),
    loadRelevantMemories: jest.fn(),
    meriV2Chat: { streamChat: jest.fn() },
    clientKb: { buildSnapshot: jest.fn() },
  };
  const streamChat = jest.fn(async ({ onEvent }: { onEvent: (event: unknown) => void }) => {
    onEvent(upstream);
  });
  const v3 = { client: { streamChat }, clientKb: { buildSnapshot: jest.fn() } };
  let upstream: Record<string, unknown>;
  createMeriRuntimeService(raw as never, v3 as never, {} as never, {} as never);
  return {
    governed,
    async receive(event: Record<string, unknown>) {
      upstream = event;
      const onEvent = jest.fn();
      await v3.client.streamChat({ input: {}, onEvent } as never);
      expect(streamChat).toHaveBeenLastCalledWith(expect.objectContaining({
        input: { governedContext: governed },
      }));
      return onEvent.mock.calls[0]![0];
    },
  };
}

describe('governed Meri stream completion coverage', () => {
  afterEach(() => jest.clearAllMocks());

  it('passes later-read reconciliation to persistence and SSE without losing the signed initial failure', async () => {
    const { governed, receive } = fixture();
    const coverage = {
      ...initial,
      phase: 'turn',
      missingDomains: [],
      partialDomains: ['institutional_knowledge'],
      restoredSources: ['institutional_knowledge'],
      unavailableSources: [],
      initialContext: initial,
      sourceHealth: [{
        source: 'institutional_knowledge', status: 'partial',
        detail: 'source_access_restored_coverage_unproven',
      }],
      toolReads: [{
        source: 'institutional_knowledge', tool: 'search_memory', status: 'partial',
        recordsReturned: 3, recordsEvaluated: 404, paginationComplete: false,
        truncated: false,
      }],
      stopReason: 'turn_coverage_partial',
    };
    const received = await receive({
      type: 'done', reply: 'Approved fact [1].',
      contextPacket: { packetId: 'upstream-copy' },
      retrieval: { plan: governed.retrieval.plan, coverage },
    });
    expect(received.retrieval.coverage).toEqual(coverage);
    expect(received.retrieval.coverage.initialContext).toBe(governed.retrieval.coverage);
    expect(received.contextPacket).toBe(governed.contextPacket);
    expect(received.contextPacketId).toBe('signed-packet');
    expect(JSON.parse(JSON.stringify(received)).retrieval.coverage).toEqual(coverage);
    expect(governed.retrieval.coverage.missingDomains).toEqual(['institutional_knowledge']);
  });

  it.each([undefined, null, { coverage: { complete: true } }, {
    coverage: { phase: 'turn', complete: true, toolReads: 'malformed' },
  }])('keeps governed initial coverage when no completed-turn receipts exist (%p)', async (retrieval) => {
    const { governed, receive } = fixture();
    const received = await receive({ type: 'done', retrieval });
    expect(received.retrieval).toBe(governed.retrieval);
  });

  it('passes tool and progress events through unchanged', async () => {
    const { receive } = fixture();
    const event = { type: 'tool_done', tool: 'search_memory', status: 'done' };
    expect(await receive(event)).toBe(event);
  });
});
