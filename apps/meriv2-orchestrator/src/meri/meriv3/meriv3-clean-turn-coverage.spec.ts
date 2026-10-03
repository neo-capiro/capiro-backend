import { EventEmitter } from 'node:events';
import { attestMeriGovernedContext, type MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { MeriV3CleanAssistantService } from './meriv3-clean-assistant.service.js';
import { MeriV3Controller } from './meriv3.controller.js';

const actor = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
};
const dto = {
  conversationId: 'conversation-1',
  clientId: 'client-1',
  toolPolicy: 'read-only' as const,
  messages: [{ role: 'user', text: 'Read the client context and the approved client preference.' }],
};

function governed(): MeriGovernedTurnContext {
  return {
    version: 1,
    operationId: 'meri.chat',
    prompt: 'Use approved evidence and disclose gaps.',
    contextPacket: {
      packetId: 'packet-1',
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: true,
    },
    retrieval: {
      plan: {
        version: 1,
        queryClass: 'lookup',
        subjectScope: 'client',
        targetHint: null,
        recipeTool: null,
        requireCompleteCoverage: true,
        requiredDomains: ['institutional_knowledge'],
        timeWindow: null,
      },
      coverage: {
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
          {
            source: 'institutional_knowledge',
            status: 'error',
            detail: 'adapter_execution_failed',
          },
        ],
        unavailableSources: [
          { source: 'institutional_knowledge', reason: 'adapter_execution_failed' },
        ],
        toolsInvoked: [],
        stopReason: 'source_error',
      },
    },
    evidence: {
      version: 1,
      tenantId: actor.tenantId,
      userId: actor.userId,
      packetId: 'packet-1',
      sourceRecordCount: 0,
      projectedRecordCount: 0,
      truncated: false,
      records: [],
    },
  };
}

function response(extra: Record<string, unknown>) {
  return {
    id: 'response-1',
    status: 'completed',
    output: [],
    outputText: '',
    functionCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    model: 'test-provider',
    usedTenantKey: false,
    incompleteReason: null,
    telemetry: {
      requestedModel: 'test-provider',
      effectiveModel: 'test-provider',
      requestedReasoningEffort: 'medium',
      effectiveReasoningEffort: 'medium',
      reasoningFallbackReasons: [],
      finishReason: 'completed',
      partial: false,
    },
    ...extra,
  };
}

describe('clean runtime completed-turn source coverage', () => {
  const originalFetch = global.fetch;
  const priorSecret = process.env.INTERNAL_SERVICE_SECRET;
  const coverageKeys = [
    'MERI_COVERAGE_RETRIEVAL_MODE',
    'MERI_COVERAGE_RETRIEVAL_TENANTS',
    'MERI_COVERAGE_RETRIEVAL_SURFACES',
  ] as const;
  const priorCoverage = Object.fromEntries(coverageKeys.map((key) => [key, process.env[key]]));
  afterEach(() => {
    global.fetch = originalFetch;
    if (priorSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = priorSecret;
    for (const key of coverageKeys) {
      if (priorCoverage[key] === undefined) delete process.env[key];
      else process.env[key] = priorCoverage[key];
    }
  });

  it.each(['json', 'stream'])(
    'distinguishes a procedural tool prohibition from factual coverage at %s completion',
    async (transport) => {
      process.env.INTERNAL_SERVICE_SECRET = 'clean-coverage-test-secret';
      process.env.MERI_COVERAGE_RETRIEVAL_MODE = 'enforce';
      process.env.MERI_COVERAGE_RETRIEVAL_TENANTS = actor.tenantId;
      process.env.MERI_COVERAGE_RETRIEVAL_SURFACES = 'chat';
      const concise =
        '- Research: explain topics.\n- Drafting: refine text.\n- Tasks: organize work.';
      for (const [request, reply, needsEvidence] of [
        [
          'C1 final verification: In exactly three short bullets, describe how you can help with research, drafting, and task organization. Use no tools.',
          concise,
          false,
        ],
        [
          'List all awards for Aster. Use no tools.',
          'I cannot establish the complete award list.',
          true,
        ],
        [
          'Who is the current committee chair? Use no tools.',
          'I cannot establish the current chair.',
          true,
        ],
        [
          'The manual says "For this procedure, use no tools. The installation ends here." Verify that instruction.',
          'I cannot verify the quoted instruction without the source.',
          true,
        ],
        [
          'The manual says "Follow this procedure. Use no tools. The installation ends here." Verify that instruction.',
          'I cannot verify the quoted instruction without the source.',
          true,
        ],
      ] as const) {
        const complete = jest.fn().mockResolvedValue(response({ outputText: reply }));
        const invoke = jest.fn();
        const retrieval = {
          currentPlan: jest.fn(() => null),
          recordModelTool: jest.fn(),
          observe: jest.fn(),
          run: jest.fn(),
        };
        global.fetch = jest.fn(
          async () => new Response(JSON.stringify({ schemas: [] })),
        ) as typeof fetch;
        const assistant = new MeriV3CleanAssistantService(
          { registry: { list: () => [], get: () => undefined, invoke } } as never,
          { complete } as never,
          { create: jest.fn() } as never,
          {
            withTenant: jest.fn(async (_tenant: string, fn: (tx: unknown) => unknown) =>
              fn({
                aiUsageEvent: { create: jest.fn(async () => ({})) },
                meriAuditLedger: { create: jest.fn(async () => ({})) },
              }),
            ),
          } as never,
          {
            get: (name: string) => (name === 'MERIV2_API_BASE_URL' ? 'http://api.test' : undefined),
          } as never,
          { schemas: async () => [] } as never,
          { available: async () => false, discard: jest.fn() } as never,
          retrieval as never,
        );
        const controller = new MeriV3Controller(
          { isAllowed: async () => true } as never,
          {
            resolveIdentity: async () => ({
              ...actor,
              firmMemory: null,
              userVoice: null,
              clientSteering: null,
              clientRoster: [],
            }),
          } as never,
          assistant,
        );
        const turn = { ...dto, messages: [{ role: 'user', text: request }] };
        const initial = governed();
        // No retrieval was requested or attempted in this fixture. The factual
        // cases must still disclose missing evidence despite this healthy frame.
        initial.contextPacket.degraded = false;
        initial.retrieval = {
          plan: {
            ...initial.retrieval.plan,
            subjectScope: 'general',
            requireCompleteCoverage: false,
            requiredDomains: [],
          },
          coverage: {
            version: 1,
            complete: true,
            requestedDomains: [],
            searchedDomains: [],
            missingDomains: [],
            partialDomains: [],
            requestedEntityCount: 0,
            searchedEntityCount: 0,
            recordsReturned: 0,
            recordsEvaluated: 0,
            paginationComplete: true,
            truncated: false,
            sourceHealth: [],
            unavailableSources: [],
            toolsInvoked: [],
            stopReason: 'not_required',
          },
        };
        const input = {
          ...turn,
          governedContext: attestMeriGovernedContext(
            initial,
            turn,
            process.env.INTERNAL_SERVICE_SECRET,
          ),
        };
        let result: { reply: string; steps?: unknown[] } | undefined;
        if (transport === 'json') {
          result = await controller.run(input, actor, {
            headers: { authorization: 'Bearer test' },
          } as never);
        } else {
          const events: Array<{ type?: string; reply: string; steps?: unknown[] }> = [];
          const req = Object.assign(new EventEmitter(), {
            headers: { authorization: 'Bearer test' },
            aborted: false,
          });
          const res = Object.assign(new EventEmitter(), {
            writableEnded: false,
            destroyed: false,
            setHeader: jest.fn(),
            write: (value: string) => {
              if (value.startsWith('data: ')) events.push(JSON.parse(value.slice(6)));
            },
            end() {
              this.writableEnded = true;
            },
          });
          await controller.stream(input, actor, req as never, res as never);
          result = events.find((event) => event.type === 'done');
        }
        expect(result?.steps ?? []).toEqual([]);
        expect(invoke).not.toHaveBeenCalled();
        expect(retrieval.run).not.toHaveBeenCalled();
        if (needsEvidence) expect(result?.reply).toContain('Evidence limitation');
        else expect(result?.reply).toBe(reply);
      }
    },
  );

  it.each(['json', 'stream'])(
    'retains native tool receipts through clean runtime inheritance and %s controller completion',
    async (transport) => {
      process.env.INTERNAL_SERVICE_SECRET = 'clean-coverage-test-secret';
      const calls = ['search_memory', 'get_client_context'].map((name, index) => ({
        type: 'function_call',
        call_id: `read-${index}`,
        name,
        arguments: '{}',
      }));
      const complete = jest
        .fn()
        .mockResolvedValueOnce(response({ output: calls, functionCalls: calls }))
        .mockResolvedValueOnce(
          response({
            outputText:
              'The client prefers a virtual briefing [1]. Client context remains unavailable.',
          }),
        );
      const invoke = jest.fn(async (name: string) =>
        name === 'search_memory'
          ? {
              data: [{ id: 'approved-preference', text: 'The client prefers a virtual briefing.' }],
              coverage: {
                sources: [
                  {
                    domain: 'institutional_knowledge',
                    sourceStatus: 'healthy',
                    returned: 1,
                    recordsEvaluated: 404,
                    hasMore: true,
                    paginationComplete: false,
                  },
                ],
              },
            }
          : { error: 'Client context unavailable' },
      );
      const registry = {
        list: () => ['search_memory', 'get_client_context'],
        get: (name: string) => ({ name, readOnly: true }),
        invoke,
      };
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemas: calls.map(({ name }) => ({
                name,
                description: 'Read authorized client evidence',
                input_schema: { type: 'object', properties: {} },
              })),
            }),
          ),
      ) as typeof fetch;
      const retrieval = {
        currentPlan: jest.fn(() => null),
        recordModelTool: jest.fn(),
        observe: jest.fn(),
        run: jest.fn(),
      };
      const assistant = new MeriV3CleanAssistantService(
        { registry } as never,
        { complete } as never,
        { create: jest.fn() } as never,
        {
          withTenant: jest.fn(async (_tenant: string, fn: (tx: unknown) => unknown) =>
            fn({
              aiUsageEvent: { create: jest.fn(async () => ({})) },
              meriAuditLedger: { create: jest.fn(async () => ({})) },
            }),
          ),
        } as never,
        {
          get: (name: string) => (name === 'MERIV2_API_BASE_URL' ? 'http://api.test' : undefined),
        } as never,
        { schemas: async () => [] } as never,
        { available: async () => false, discard: jest.fn() } as never,
        retrieval as never,
      );
      const controller = new MeriV3Controller(
        { isAllowed: async () => true } as never,
        {
          resolveIdentity: async () => ({
            ...actor,
            firmMemory: null,
            userVoice: null,
            clientSteering: null,
            clientRoster: [],
          }),
        } as never,
        assistant,
      );
      const initial = governed();
      const input = {
        ...dto,
        governedContext: attestMeriGovernedContext(
          initial,
          dto,
          process.env.INTERNAL_SERVICE_SECRET,
        ),
      };
      let result: { retrieval?: { coverage: unknown } } | undefined;
      if (transport === 'json') {
        result = await controller.run(input, actor, {
          headers: { authorization: 'Bearer test' },
        } as never);
      } else {
        const events: Array<{ type?: string; tool?: string; retrieval?: { coverage: unknown } }> =
          [];
        const req = Object.assign(new EventEmitter(), {
          headers: { authorization: 'Bearer test' },
          aborted: false,
        });
        const res = Object.assign(new EventEmitter(), {
          writableEnded: false,
          destroyed: false,
          setHeader: jest.fn(),
          write: (value: string) => {
            if (value.startsWith('data: ')) events.push(JSON.parse(value.slice(6)));
          },
          end() {
            this.writableEnded = true;
          },
        });
        await controller.stream(input, actor, req as never, res as never);
        result = events.find((event) => event.type === 'done')!;
        expect(
          events.some((event) => event.type === 'tool_done' && event.tool === 'search_memory'),
        ).toBe(true);
      }
      expect(result?.retrieval?.coverage).toMatchObject({
        phase: 'turn',
        complete: false,
        missingDomains: [],
        restoredSources: ['institutional_knowledge'],
        partialDomains: ['institutional_knowledge'],
        recordsReturned: 250,
        recordsEvaluated: 2020,
        sourceHealth: [{ source: 'institutional_knowledge', status: 'partial' }],
        unavailableSources: [{ source: 'clients', reason: 'subsequent_read:source_read_failed' }],
        toolReads: [
          {
            source: 'institutional_knowledge',
            recordsReturned: 1,
            recordsEvaluated: 404,
            status: 'partial',
          },
          { source: 'clients', status: 'error' },
        ],
        initialContext: { sourceHealth: [{ status: 'error', detail: 'adapter_execution_failed' }] },
      });
      expect(retrieval.run).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(2);
      expect(complete.mock.calls[0]![0].tools.map((tool: { name: string }) => tool.name)).toEqual([
        'search_memory',
        'get_client_context',
      ]);
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );
});
