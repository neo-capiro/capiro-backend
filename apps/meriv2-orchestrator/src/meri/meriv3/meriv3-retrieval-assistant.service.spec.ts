import type { MeriContext } from '@capiro/meriv2-core';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { MeriRetrievalCoordinator } from '../retrieval/meri-retrieval-coordinator.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import { MeriV3RetrievalAssistantService } from './meriv3-retrieval-assistant.service.js';
import {
  catalogAvailabilityObserverOf,
  createMeriCatalogAvailabilityObserver,
  type MeriCatalogAvailabilityControl,
} from './meriv3-catalog-availability.js';
import type { MeriV3ChatResult, MeriV3ChatStreamEvent } from './meriv3.types.js';

const result: MeriV3ChatResult = {
  reply: 'ok',
  runtime: 'meriv3',
  model: 'gpt-test',
  reasoningMode: 'standard',
  reasoningEffort: 'medium',
};

function make(managedSchemas: unknown[] = []) {
  const registryService = { registry: { list: () => [], get: () => undefined } };
  const config = { get: jest.fn(() => 'http://api.test') };
  return new MeriV3RetrievalAssistantService(
    registryService as never,
    {} as never,
    {} as never,
    {} as never,
    config as never,
    { schemas: jest.fn(async () => managedSchemas) } as never,
    { available: jest.fn(async () => false) } as never,
    new MeriRetrievalCoordinator(),
  );
}

/**
 * A provider-free responses result for the REAL provider path (only the
 * external model transport is faked). Mirrors the managed request-path harness
 * shape so the current `MeriV3AssistantService.runTurn` reads real fields.
 */
function providerResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1',
    status: 'completed',
    output: [],
    outputText: 'Final answer.',
    functionCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    model: 'gpt-5.1',
    usedTenantKey: false,
    incompleteReason: null,
    telemetry: {
      requestedModel: 'gpt-5.1',
      effectiveModel: 'gpt-5.1',
      requestedReasoningEffort: 'medium',
      effectiveReasoningEffort: 'medium',
      reasoningFallbackReasons: [],
      finishReason: 'completed',
      partial: false,
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * The REAL retrieval subclass driven through the ACTUAL normal provider path
 * (its real `super.run` -> `MeriV3ManagedMcpAssistantService.run`), with the
 * current request credential store and the real `ApiManagedMcpRepo` owner
 * bridge routed through a fake `global.fetch`. Only the external HTTP/model
 * transport is mocked; the retrieval wrapper, plan/coverage engine and the run
 * pipeline are the real ones. This is the final-class proof the identity-forward
 * test alone cannot give.
 */
function buildRetrieval(complete: jest.Mock) {
  const registryService = {
    registry: { list: () => [], get: () => undefined, executionMetadata: () => undefined, invoke: jest.fn() },
    llm: {
      completeJson: jest.fn(),
      completeWithSchema: jest.fn(async () => ({
        input: { refuted: false, confidence: 'high', reason: 'Supported.' },
        usage: { inputTokens: 10, outputTokens: 2 },
      })),
      withProviderBudget(budget: { reserveModelAttempt: (phase: unknown) => void }, phase: unknown) {
        return {
          completeJson: (...args: unknown[]) => {
            budget.reserveModelAttempt(phase);
            return this.completeJson(...args);
          },
          completeWithSchema: (...args: unknown[]) => {
            budget.reserveModelAttempt(phase);
            return (this.completeWithSchema as jest.Mock)(...args);
          },
        };
      },
    },
  };
  const cfg = { get: jest.fn((key: string) => (key === 'MERIV2_API_BASE_URL' ? 'http://api.test' : undefined)) };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({
        aiUsageEvent: { create: jest.fn(async () => ({})) },
        meriAuditLedger: { create: jest.fn(async () => ({})) },
      }),
    ),
  };
  return new MeriV3RetrievalAssistantService(
    registryService as never,
    { complete } as never,
    { create: jest.fn() } as never,
    prisma as never,
    cfg as never,
    new ApiManagedMcpRepo(cfg as never),
    {
      available: jest.fn(async () => false),
      execute: jest.fn(async () => ({})),
      discard: jest.fn(async () => undefined),
    } as never,
    new MeriRetrievalCoordinator(),
  );
}

function fetchRouter(routes: {
  native?: () => Response;
  managed?: () => Response;
}): jest.Mock {
  return jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/clio/v3/mcp-tool-schemas')) {
      return routes.managed ? routes.managed() : jsonResponse({ schemas: [] });
    }
    if (url.includes('/api/clio/tool-schemas')) {
      return routes.native ? routes.native() : jsonResponse({ schemas: [] });
    }
    return jsonResponse({});
  });
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
    expect(output.reply).toContain('**Coverage note:**');
    expect(output.reply).toContain('incomplete');
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

  test('uses governed monday evidence for audits while preserving other managed-monday requests', async () => {
    // Current real API managed-catalog metadata: the schema is a validated
    // managed read (source/appId/readOnly + object input schema), not a bare
    // name-prefix fixture. The retrieval monday filter must remove it only when
    // the governed coverage requests the monday domain.
    const schema = {
      name: 'mcp__meriv3_monday__get_board_items_page',
      appId: 'monday',
      appName: 'monday.com',
      readOnly: true,
      source: 'managed_mcp',
      description: 'Read board items',
      input_schema: { type: 'object' },
    };
    jest
      .spyOn(MeriV3AssistantService.prototype as never, 'fetchToolSchemas' as never)
      .mockResolvedValue([] as never);
    const service = make([schema]) as unknown as {
      fetchToolSchemas: () => Promise<Array<{ name: string }>>;
    };
    // Valid ordinary governed meri.chat/general turn: an audit that requests the
    // monday domain must consume monday evidence only through the Context Plane,
    // so the raw personal-provider monday read is withheld.
    const governed = {
      version: 1,
      operationId: 'meri.chat',
      prompt: 'Governed context.',
      contextPacket: {
        packetId: null,
        items: [],
        exclusions: [],
        unauthorizedCount: 0,
        degraded: false,
        clientId: null,
      },
      retrieval: {
        plan: {
          version: 1,
          queryClass: 'general',
          subjectScope: 'general',
          targetHint: null,
          recipeTool: null,
          requireCompleteCoverage: false,
          requiredDomains: [],
          timeWindow: null,
        },
        coverage: { requestedDomains: ['monday'] },
      },
    } as unknown as MeriGovernedTurnContext;
    await expect(
      runWithGovernedMeriContext(governed, () => service.fetchToolSchemas()),
    ).resolves.toEqual([]);
    // An unrelated (non-monday) governed request must still expose the valid
    // personal monday managed read.
    governed.retrieval.coverage.requestedDomains = ['clients'];
    await expect(
      runWithGovernedMeriContext(governed, () => service.fetchToolSchemas()),
    ).resolves.toEqual([expect.objectContaining({ name: schema.name })]);
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
    expect(output.reply).toContain('**Coverage note:**');
  });

  test('forwards the SAME request-local control, so the catalog observer survives the retrieval wrapper', async () => {
    const baseFetch = jest
      .spyOn(
        MeriV3AssistantService.prototype as unknown as {
          fetchToolSchemas: (c?: unknown) => Promise<unknown[]>;
        },
        'fetchToolSchemas',
      )
      .mockResolvedValue([
        { name: 'search_memory', description: 'Search memory', input_schema: { type: 'object' } },
      ]);
    const service = make();
    const observer = createMeriCatalogAvailabilityObserver();
    const control: MeriCatalogAvailabilityControl = { catalogAvailability: observer };
    const internals = service as unknown as {
      fetchToolSchemas: (c?: MeriCatalogAvailabilityControl) => Promise<Array<{ name: string }>>;
    };

    const schemas = await internals.fetchToolSchemas(control);

    // The retrieval wrapper installs one-argument `fetchToolSchemas` and forwards
    // the SAME control object it received into the native + managed fetch, so the
    // request-local observer is retained without any second argument or retrieval
    // production edit.
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls[0]?.[0]).toBe(control);
    expect(catalogAvailabilityObserverOf(baseFetch.mock.calls[0]?.[0])).toBe(observer);
    expect(schemas.some((schema) => schema.name === 'search_memory')).toBe(true);
  });

  test('the real normal.run provider path releases the truthful catalog limitation through the retrieval wrapper', async () => {
    const originalFetch = global.fetch;
    const complete = jest.fn().mockResolvedValue(providerResult({ outputText: 'Here is the answer.' }));
    const service = buildRetrieval(complete);
    global.fetch = fetchRouter({
      native: () => jsonResponse({ error: 'native down' }, 500),
      managed: () => jsonResponse({ schemas: [] }),
    }) as unknown as typeof fetch;
    try {
      const output = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        service.run(context, {
          conversationId: 'retrieval-real-path',
          messages: [{ role: 'user', text: 'Look up our client records.' }],
        }),
      );

      // The REAL super provider path ran (not a mocked superclass.run nor a
      // fetch identity assertion): exactly one provider round and a real
      // retrieval plan/coverage produced by the wrapper's own normal.run.
      expect(complete).toHaveBeenCalledTimes(1);
      expect(output.retrieval?.plan).toBeDefined();

      // The wrapper delivered the final truthful status: the bounded limitation
      // is on the released reply and the unsupported provider prose is not.
      expect(output.reply).toContain('Source note:');
      expect(output.reply).toContain('not consulted');
      expect(output.reply).not.toContain('Here is the answer.');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
