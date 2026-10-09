/**
 * Lane A1 request-path REPRODUCTION spec (provider-free).
 *
 * This spec enters the normal assistant request pipeline —
 * `MeriV3ManagedMcpAssistantService.run` -> `MeriV3AssistantService.runTurn`
 * -> `executeFunctionCalls` admission -> `invokeTool` — with:
 *   - a fake `OpenAiResponsesClient` transport (`{ complete }`) that returns one
 *     advertised managed `function_call` and then a final text answer;
 *   - the current request credential store (`RequestCredentialsStore.run`);
 *   - the real `ApiManagedMcpRepo` owner bridge driven by a routed `global.fetch`
 *     (native schema catalog, managed schema catalog, managed owner call);
 *   - the real `MeriRunBudget`/execution-control (never stubbed here).
 *
 * It deliberately does NOT call `fetchToolSchemas`/`invokeTool`/
 * `executeFunctionCalls` directly and does NOT patch them to skip admission.
 * The managed unit spec (`meriv3-managed-mcp-assistant.service.spec.ts`) calls
 * those internals directly and therefore cannot prove or disprove admission.
 *
 * Scope note (Lane A / A1): ordinary-chat only. No `researchRun`,
 * `researchPlanExecution` or governed procedure is supplied, so the run proves
 * the ordinary path independently of any research durable-receipt widening.
 * Nothing here widens research `allowedReadCapabilities`, procedure admission,
 * actor scope or connector scope. Controller authentication and served HTTP
 * reachability require separate qualification. The negatives below keep the managed
 * namespace narrow (advertised metadata, not name prefix alone).
 *
 * Current-base expectation:
 *   - "admits and runs an advertised managed read" FAILS on the base commit at
 *     the native membership admission guard
 *     (`meriv3-assistant.service.ts` L3211-3244,
 *      detail L3223 "no longer available under the current governed tool
 *      policy"): an `mcp__*` name has no `registry.get()` /
 *      `MERI_CAPABILITY_REGISTRY` membership, so it is blocked before
 *      `invokeTool`/`ApiManagedMcpRepo.executeRead`.
 *   - The native-read control, the unadvertised-name negative and the catalog
 *     outage characterization must pass on the base commit.
 */

import type { MeriContext, ToolRegistry } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import type { MeriV3ChatResult, MeriV3ChatStreamEvent } from './meriv3.types.js';

const ADVERTISED_MANAGED = 'mcp__meriv3_hubspot__search_contacts';
const UNADVERTISED_MANAGED = 'mcp__meriv3_hubspot__delete_contacts';
const NATIVE_READ = 'search_memory';

const CLIENT_ID = '30000000-0000-4000-8000-000000000001';
const RECORD_ID = '50000000-0000-4000-8000-000000000001';

const context = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  firmMemory: null,
  userVoice: null,
  clientSteering: null,
  clientRoster: [],
} as unknown as MeriContext;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function providerResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1',
    status: 'completed',
    output: [],
    outputText: 'Final answer.',
    functionCalls: [],
    usage,
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

function functionCall(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: 'function_call' as const,
    call_id: id,
    name,
    arguments: JSON.stringify(input),
    status: 'completed',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function nativeSchema(name: string) {
  return {
    name,
    description: name,
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  };
}

/** API-managed catalog schema contract: source + appId + appName + readOnly. */
function managedSchema() {
  return {
    name: ADVERTISED_MANAGED,
    description: 'Search HubSpot contacts',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    source: 'managed_mcp',
    appId: 'hubspot',
    appName: 'HubSpot',
    readOnly: true,
  };
}

/** Owner payload that yields a citation (records[].payload shape) + a marker. */
function hubspotOwnerPayload() {
  return {
    generatedAt: '2026-10-08T00:00:00Z',
    records: [
      {
        recordId: RECORD_ID,
        domain: 'clients',
        payload: { title: 'Jane Finder', name: 'Jane Finder' },
      },
    ],
  };
}

function memoryOwnerPayload() {
  return {
    generatedAt: '2026-10-08T00:00:00Z',
    records: [
      {
        recordId: RECORD_ID,
        domain: 'institutional_knowledge',
        payload: {
          sourceKind: 'governed_memory',
          title: 'Kestrel commitment',
          value: 'Approved commitment fact',
          clientId: CLIENT_ID,
          content: { hash: 'approved-v1' },
        },
      },
    ],
  };
}

function registry(
  definitions: Array<{ name: string; readOnly: boolean }>,
  invoke = jest.fn(),
): ToolRegistry {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return {
    list: () => definitions.map((definition) => definition.name),
    get: (name: string) => byName.get(name),
    executionMetadata: (name: string) => {
      const definition = byName.get(name);
      return definition
        ? {
            name,
            readOnly: definition.readOnly,
            executionMode: definition.readOnly ? 'read' : 'approval_required',
            externalEffect: definition.readOnly ? 'none' : 'external_send',
            reversible: definition.readOnly,
            riskTier: definition.readOnly ? 'low' : 'high',
            displayVerb: name,
          }
        : undefined;
    },
    invoke,
  } as unknown as ToolRegistry;
}

function config(values: Record<string, string | undefined> = {}) {
  return {
    get: jest.fn((key: string) =>
      key === 'MERIV2_API_BASE_URL' ? 'http://api.test' : values[key],
    ),
  };
}

function prisma() {
  return {
    withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({
        aiUsageEvent: { create: jest.fn(async () => ({})) },
        meriAuditLedger: { create: jest.fn(async () => ({})) },
      }),
    ),
  };
}

/**
 * Minimal managed-subclass harness. Mirrors the `build()` pattern of
 * `meriv3-assistant.service.spec.ts` (fake registry + fake transport +
 * RequestCredentialsStore + `global.fetch`) without importing that file-local
 * helper and without copying its suite. The budget/execution control is the
 * real one created inside `run`.
 */
function buildManaged(
  complete: jest.Mock,
  options: { registry?: ToolRegistry } = {},
): { service: MeriV3ManagedMcpAssistantService } {
  const registryService = {
    registry: options.registry ?? registry([]),
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
  const cfg = config();
  const service = new MeriV3ManagedMcpAssistantService(
    registryService as never,
    { complete } as never,
    { create: jest.fn() } as never,
    prisma() as never,
    cfg as never,
    new ApiManagedMcpRepo(cfg as never),
    {
      available: jest.fn(async () => false),
      execute: jest.fn(async () => ({})),
      discard: jest.fn(async () => undefined),
    } as never,
  );
  return { service };
}

/** Routes the orchestrator's real HTTP owner boundary by URL. */
function fetchRouter(routes: {
  native?: () => Response;
  managed?: () => Response;
  owner?: (url: string) => Response;
}): jest.Mock {
  return jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/clio/v3/mcp-tool-schemas')) {
      return routes.managed ? routes.managed() : jsonResponse({ schemas: [] });
    }
    if (url.includes('/api/clio/v3/mcp-tools/')) {
      return routes.owner ? routes.owner(url) : jsonResponse({ records: [] });
    }
    if (url.includes('/api/clio/tool-schemas')) {
      return routes.native ? routes.native() : jsonResponse({ schemas: [] });
    }
    if (url.includes('/api/clio/tools/')) {
      return jsonResponse({ records: [] });
    }
    void init;
    return jsonResponse({});
  });
}

function toolsOnCall(complete: jest.Mock, callIndex: number): string[] {
  const tools = complete.mock.calls[callIndex]?.[0]?.tools as
    | Array<{ name: string }>
    | undefined;
  return (tools ?? []).map((tool) => tool.name);
}

/** Provider input bodies sent AFTER the first (tool-emitting) round. */
function fedBackInput(complete: jest.Mock): string {
  return JSON.stringify(complete.mock.calls.slice(1).map((call) => call[0]?.input));
}

function managedOwnerPosts(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/clio/v3/mcp-tools/'));
}

const originalFetch = global.fetch;

describe('MeriV3 managed MCP request path (Lane A1 reproduction)', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('admits and runs an advertised managed read once, feeding the owner result into the next provider input', async () => {
    const call = functionCall('managed-call', ADVERTISED_MANAGED, { query: 'Jane Finder' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(providerResult({ outputText: 'Jane Finder is a HubSpot contact.' }))
      .mockResolvedValue(providerResult({ outputText: 'Jane Finder is a HubSpot contact.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse(hubspotOwnerPayload()),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const events: MeriV3ChatStreamEvent[] = [];
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(
          context,
          {
            conversationId: 'managed-thread',
            messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
          },
          { onEvent: (event) => events.push(event) },
        ),
    );

    // The advertised managed tool reached the model.
    expect(toolsOnCall(complete, 0)).toContain(ADVERTISED_MANAGED);

    // It executed exactly once through the real API-managed owner bridge.
    const ownerPosts = managedOwnerPosts(fetchMock);
    expect(ownerPosts).toHaveLength(1);
    expect(ownerPosts[0]).toContain(encodeURIComponent(ADVERTISED_MANAGED));

    // The owner result and the evidence ledger fed the next provider input,
    // and no native-policy block was emitted for the managed call.
    const fedBack = fedBackInput(complete);
    expect(fedBack).toContain('Jane Finder');
    expect(fedBack).toContain(`[Tool result from "${ADVERTISED_MANAGED}"`);
    expect(fedBack).not.toContain('no longer available under the current governed tool policy');

    // The existing citation receipt / evidence manifest is present.
    expect(result.citations?.some((citation) => citation.tool === ADVERTISED_MANAGED)).toBe(true);
    expect(
      result.evidenceManifest?.sources.some((source) => source.tool === ADVERTISED_MANAGED),
    ).toBe(true);
    expect(result.reply).toContain('Jane Finder');
  });

  test('native advertised read control executes once through the registry dispatch (must pass on base)', async () => {
    const call = functionCall('native-call', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(providerResult({ outputText: 'Kestrel commitment noted.' }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted.' }));
    const invoke = jest.fn(
      async (..._args: Parameters<ToolRegistry['invoke']>) => memoryOwnerPayload(),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
    });

    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [] }),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'native-thread',
          messages: [{ role: 'user', text: 'What do we know about Kestrel?' }],
        }),
    );

    expect(toolsOnCall(complete, 0)).toContain(NATIVE_READ);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe(NATIVE_READ);
    expect(fedBackInput(complete)).toContain(`[Tool result from "${NATIVE_READ}"`);
    expect(result.citations?.some((citation) => citation.tool === NATIVE_READ)).toBe(true);
  });

  test('an unadvertised managed-prefixed name stays blocked and never reaches the managed bridge', async () => {
    // Same reviewed server prefix as the advertised tool, but never advertised:
    // this proves admission cannot be reduced to the name prefix alone.
    const call = functionCall('unadvertised-call', UNADVERTISED_MANAGED, { query: 'delete' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(providerResult({ outputText: 'I did not run that request.' }))
      .mockResolvedValue(providerResult({ outputText: 'I did not run that request.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      // Only the reviewed tool is advertised by the managed catalog.
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'unadvertised-thread',
          messages: [{ role: 'user', text: 'Delete every HubSpot contact.' }],
        }),
    );

    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    expect(fedBackInput(complete)).toContain('An unavailable tool request was blocked.');
    expect(result.reply).toContain('I did not run that request.');
  });

  test('catalog outage characterization: a schema fetch failure yields an empty catalog and no owner dispatch', async () => {
    // Characterization of CURRENT behavior (not a correctness requirement):
    // both catalogs 5xx -> silent empty catalog, run continues, no owner call.
    const complete = jest
      .fn()
      .mockResolvedValue(providerResult({ outputText: 'No tools were available.' }));
    const invoke = jest.fn();
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
    });

    const fetchMock = jest.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response('upstream unavailable', { status: 500 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'outage-thread',
          messages: [{ role: 'user', text: 'Summarize Kestrel.' }],
        }),
    );

    expect(toolsOnCall(complete, 0)).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/api/clio/tools/'))).toBe(false);
    expect(urls.some((url) => url.includes('/api/clio/v3/mcp-tools/'))).toBe(false);
    expect(result.reply).toContain('No tools were available.');
  });
});
