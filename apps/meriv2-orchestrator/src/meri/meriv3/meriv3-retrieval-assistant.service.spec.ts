import type { MeriContext } from '@capiro/meriv2-core';
import { MeriRetrievalCoordinator } from '../retrieval/meri-retrieval-coordinator.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import { MeriV3RetrievalAssistantService } from './meriv3-retrieval-assistant.service.js';
import type { MeriV3ChatResult, MeriV3ChatStreamEvent } from './meriv3.types.js';

const result: MeriV3ChatResult = {
  reply: 'ok',
  runtime: 'meriv3',
  model: 'gpt-test',
  reasoningMode: 'standard',
  reasoningEffort: 'medium',
};

function make() {
  const registryService = { registry: { list: () => [], get: () => undefined } };
  const config = { get: jest.fn(() => 'http://api.test') };
  return new MeriV3RetrievalAssistantService(
    registryService as never,
    {} as never,
    {} as never,
    {} as never,
    config as never,
    {} as never,
    {} as never,
    new MeriRetrievalCoordinator(),
  );
}

const context = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clientSteering: {
    soul: 'Selected-client private steering',
  },
  contextPacket: {
    packetId: 'selected-client-packet',
    clientId: 'legistorm-client-id',
    items: [
      {
        id: 'client-memory-1',
        label: 'Legistorm private context',
        type: 'client_memory',
        scope: 'client',
        authority: 'human-authored',
        clientName: 'Legistorm',
        selection: 'automatic',
      },
    ],
    exclusions: [],
    unauthorizedCount: 0,
    degraded: false,
  },
  clientRoster: [
    { name: 'Legistorm', status: 'active' },
    { name: 'Aperture Defense Systems', status: 'active' },
  ],
} as unknown as MeriContext;

describe('MeriV3RetrievalAssistantService', () => {
  afterEach(() => jest.restoreAllMocks());

  test('removes every stale selected-client input from a named external relationship brief', async () => {
    const downstream = jest
      .spyOn(MeriV3ManagedMcpAssistantService.prototype, 'run')
      .mockResolvedValue(result);
    const service = make();

    const output = await service.run(context, {
      clientId: 'legistorm-client-id',
      clientKbSnapshot: 'Legistorm private profile',
      memoryContext: ['Legistorm private memory'],
      skillAddendum: 'Firm-authored guidance',
      messages: [
        {
          role: 'user',
          text: 'Give me a summary of my emails from Powers Interactive',
        },
      ],
    });

    const [scopedCtx, scopedDto] = downstream.mock.calls[0] ?? [];
    expect(scopedCtx).toEqual(
      expect.objectContaining({
        clientSteering: undefined,
        contextPacket: undefined,
      }),
    );
    expect(scopedDto).toEqual(
      expect.objectContaining({
        clientId: undefined,
        clientKbSnapshot: undefined,
        memoryContext: undefined,
      }),
    );
    expect(scopedDto?.skillAddendum).toContain('Firm-authored guidance');
    expect(scopedDto?.skillAddendum).toContain('Subject scope: external_entity.');
    expect(scopedDto?.skillAddendum).toContain('it is NOT the subject');
    expect(scopedDto?.skillAddendum).toContain(
      'search_research_sources is broad INTERNAL discovery',
    );
    expect(scopedDto?.skillAddendum).toContain('Call query_relationship_brief FIRST.');
    expect(output.retrieval?.plan.recipeTool).toBe('query_relationship_brief');
    expect(output.retrieval?.coverage.complete).toBe(false);
    expect(output.reply).toContain('### Retrieval coverage');
    expect(output.reply).toContain('Coverage is partial');
  });

  test('removes a single selected-client pin from a portfolio change request', async () => {
    const downstream = jest
      .spyOn(MeriV3ManagedMcpAssistantService.prototype, 'run')
      .mockResolvedValue(result);
    const service = make();

    const output = await service.run(context, {
      clientId: 'legistorm-client-id',
      clientKbSnapshot: 'Legistorm private profile',
      memoryContext: ['Legistorm private memory'],
      messages: [{ role: 'user', text: 'What changed across my clients this week?' }],
    });

    const [scopedCtx, scopedDto] = downstream.mock.calls[0] ?? [];
    expect(scopedCtx?.contextPacket).toBeUndefined();
    expect(scopedDto?.clientId).toBeUndefined();
    expect(scopedDto?.clientKbSnapshot).toBeUndefined();
    expect(scopedDto?.memoryContext).toBeUndefined();
    expect(scopedDto?.skillAddendum).toContain('Subject scope: portfolio.');
    expect(scopedDto?.skillAddendum).toContain('Enumerate the authorized client roster');
    expect(scopedDto?.skillAddendum).toContain('Zero matches are not proof of absence');
    expect(scopedDto?.skillAddendum).toContain('Call query_portfolio_changes FIRST.');
    expect(scopedDto?.skillAddendum).toContain('Authorized active client count: 2.');
    expect(output.retrieval?.plan.timeWindow).toEqual({ expression: 'this week', withinDays: 7 });
    expect(output.retrieval?.plan.recipeTool).toBe('query_portfolio_changes');
  });

  test('preserves selected-client context for a true client-scoped question', async () => {
    const downstream = jest
      .spyOn(MeriV3ManagedMcpAssistantService.prototype, 'run')
      .mockResolvedValue(result);
    const service = make();

    const output = await service.run(context, {
      clientId: 'client-a',
      clientKbSnapshot: 'Client A profile',
      memoryContext: ['Client A memory'],
      messages: [
        {
          role: 'user',
          text: "What are this client's active congressional priorities?",
        },
      ],
    });

    const [scopedCtx, scopedDto] = downstream.mock.calls[0] ?? [];
    expect(scopedCtx).toBe(context);
    expect(scopedDto?.clientId).toBe('client-a');
    expect(scopedDto?.clientKbSnapshot).toBe('Client A profile');
    expect(scopedDto?.memoryContext).toEqual(['Client A memory']);
    expect(scopedDto?.skillAddendum).toContain('Subject scope: client.');
    expect(output.retrieval?.plan.recipeTool).toBeNull();
    expect(output.retrieval?.coverage.complete).toBe(true);
    expect(output.reply).toBe('ok');
  });

  test('preserves the selected client as a deliberate comparison anchor', async () => {
    const downstream = jest
      .spyOn(MeriV3ManagedMcpAssistantService.prototype, 'run')
      .mockResolvedValue(result);
    const service = make();

    const output = await service.run(context, {
      clientId: 'client-a',
      clientKbSnapshot: 'Client A profile',
      memoryContext: ['Client A memory'],
      messages: [{ role: 'user', text: 'Compare my client with Shield AI' }],
    });

    const [scopedCtx, scopedDto] = downstream.mock.calls[0] ?? [];
    expect(scopedCtx).toBe(context);
    expect(scopedDto?.clientId).toBe('client-a');
    expect(scopedDto?.clientKbSnapshot).toBe('Client A profile');
    expect(scopedDto?.memoryContext).toEqual(['Client A memory']);
    expect(scopedDto?.skillAddendum).toContain('comparison anchor');
    expect(scopedDto?.skillAddendum).toContain('Subject scope: external_entity.');
    expect(output.retrieval?.plan.recipeTool).toBe('research_external_company');
  });

  test('retains the prior researched company for a terse Search across clients follow-up', async () => {
    const downstream = jest
      .spyOn(MeriV3ManagedMcpAssistantService.prototype, 'run')
      .mockResolvedValue(result);
    const service = make();

    const output = await service.run(context, {
      messages: [
        {
          role: 'user',
          text: 'Give me a comprehensive strategy on Kinetic Industries Inc.',
        },
        {
          role: 'assistant',
          text: 'Kinetic Industries is a logistics consulting company.',
        },
        { role: 'user', text: 'Search across clients' },
      ],
    });

    const [, scopedDto] = downstream.mock.calls[0] ?? [];
    expect(output.retrieval?.plan.recipeTool).toBe('query_portfolio_overlap');
    expect(output.retrieval?.plan.targetHint).toBe('Kinetic Industries Inc');
    expect(scopedDto?.skillAddendum).toContain('Resolved subject hint: Kinetic Industries Inc.');
    expect(scopedDto?.skillAddendum).toContain('Call query_portfolio_overlap FIRST.');
  });

  test('emits one final text event that exactly matches the coverage-aware reply', async () => {
    const downstream = jest
      .spyOn(MeriV3ManagedMcpAssistantService.prototype, 'run')
      .mockImplementation(async (_ctx, _dto, opts) => {
        opts?.onEvent?.({ type: 'text', text: 'raw model reply' });
        return { ...result, reply: 'raw model reply' };
      });
    const service = make();
    const events: MeriV3ChatStreamEvent[] = [];

    const output = await service.run(
      context,
      {
        messages: [{ role: 'user', text: 'Tell me everything I should know about Victory Six' }],
      },
      { onEvent: (event) => events.push(event) },
    );

    const textEvents = events.filter(
      (event): event is Extract<MeriV3ChatStreamEvent, { type: 'text' }> => event.type === 'text',
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]?.text).toBe(output.reply);
    expect(output.reply).toContain('### Retrieval coverage');
  });
});
