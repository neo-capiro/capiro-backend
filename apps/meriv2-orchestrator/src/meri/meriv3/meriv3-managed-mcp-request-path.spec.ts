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
 * `researchPlanExecution` or governed procedure is supplied to the positive or
 * ordinary negatives, so the run proves the ordinary path independently of any
 * research durable-receipt widening. Nothing here widens research
 * `allowedReadCapabilities`, procedure admission, actor scope or connector
 * scope. Controller authentication and served HTTP reachability require
 * separate qualification. The negatives keep the managed namespace narrow
 * (validated advertised metadata, not name prefix alone).
 *
 * The positive owner wire is the REAL managed read shape returned by
 * `MeriV3SettingsController.executeManagedMcpRead` ->
 * `MeriManagedMcpService.executeRead` -> `MeriMcpService.executeBridged`:
 * `{ tool, server, untrusted: true, content }`, with no `structuredRead` on that
 * endpoint. No fabricated citations, contact records, source ids, facts or
 * structuredRead adapter are asserted: the opaque ledger receipt is distinct
 * from structured owner facts, which remain separately qualified.
 */

import type { MeriContext, MeriGovernedTurnContext, ToolRegistry } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import type { MeriV3ChatResult, MeriV3ChatStreamEvent } from './meriv3.types.js';

/** The ACTUAL API-owned HubSpot read name (current managed read allowlist). */
const MANAGED_READ = 'mcp__meriv3_hubspot__search_crm_objects';
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

/**
 * API-managed catalog schema contract: source + appId + appName + readOnly.
 * The real owner bridge returns exactly these authority fields on the managed
 * catalog (`MeriManagedMcpService.schemasForMeriV3`).
 */
function managedSchema(overrides: Record<string, unknown> = {}) {
  return {
    name: MANAGED_READ,
    description: 'Search HubSpot CRM objects',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    source: 'managed_mcp',
    appId: 'hubspot',
    appName: 'HubSpot',
    readOnly: true,
    ...overrides,
  };
}

/** The real managed read wire from `MeriMcpService.executeBridged`. */
function managedOwnerWire(content: string) {
  return {
    tool: MANAGED_READ,
    server: 'meriv3-hubspot',
    untrusted: true,
    content,
  };
}

/**
 * Genuine `search_memory` owner result envelope for an ordinary governed-memory
 * read (model answer cites it as source [1]). Mirrors the canonical owner
 * contract validated by `classifyApiToolReadOutcome('search_memory', …)` and
 * read by `extractCitationsFromToolResult('search_memory', …)` to produce one
 * citable memory source (title, id, clientId, content hash).
 */
function memoryOwnerPayload() {
  return {
    tool: 'search_memory',
    generatedAt: '2026-10-08T00:00:00Z',
    coverage: {
      requestedDomains: ['institutional_knowledge'],
      searchedDomains: ['institutional_knowledge'],
      requestedEntityCount: 0,
      searchedEntityCount: 0,
      recordsEvaluated: 1,
      recordsReturned: 1,
      paginationComplete: true,
      unavailableSources: [],
      complete: true,
      stopReason: 'complete',
      sources: [
        {
          domain: 'institutional_knowledge',
          sourceStatus: 'healthy',
          returned: 1,
          recordsEvaluated: 1,
          requestedEntityCount: 0,
          searchedEntityCount: 0,
          pagesRead: 1,
          hasMore: false,
          truncated: false,
          paginationComplete: true,
          coverageComplete: true,
          stopReason: 'governed_memory_scan_complete',
        },
      ],
    },
    factContentUnavailableCount: 0,
    contentStatus: 'available',
    contentTruncated: false,
    nextCursor: null,
    results: [
      {
        id: RECORD_ID,
        memoryItemId: RECORD_ID,
        title: 'Kestrel commitment',
        clientId: CLIENT_ID,
        relevance: null,
      },
    ],
    records: [
      {
        domain: 'institutional_knowledge',
        recordId: RECORD_ID,
        payload: {
          sourceKind: 'governed_memory',
          memoryItemId: RECORD_ID,
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
  options: {
    registry?: ToolRegistry;
    configValues?: Record<string, string | undefined>;
  } = {},
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
  const cfg = config(options.configValues);
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

/** A responses-API input item after the first round; only outputs are read. */
type ProviderInputItem = { type?: string; output?: unknown };

/** Flattens a responses-API `input` payload into its ordered items. */
function providerInputItems(input: unknown): ProviderInputItem[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) =>
    Array.isArray(entry) ? providerInputItems(entry) : [entry as ProviderInputItem],
  );
}

/**
 * The actual tool-result payloads fed to the model AFTER the first
 * (tool-emitting) round, joined from the real `function_call_output.output`
 * strings. It reads the embedded strings directly, not `JSON.stringify(input)`,
 * so assertions stay tied to the payload the model actually receives.
 */
function fedBackInput(complete: jest.Mock): string {
  return complete.mock.calls
    .slice(1)
    .flatMap((call) => providerInputItems(call[0]?.input))
    .filter((item) => item.type === 'function_call_output')
    .map((item) => (typeof item.output === 'string' ? item.output : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

function managedOwnerPosts(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/clio/v3/mcp-tools/'));
}

function managedOwnerInit(fetchMock: jest.Mock): RequestInit | undefined {
  const call = fetchMock.mock.calls.find((candidate) =>
    String(candidate[0]).includes('/api/clio/v3/mcp-tools/'),
  );
  return call?.[1] as RequestInit | undefined;
}

function governedTurn(
  subjectScope: 'client' | 'portfolio' | 'external_entity' | 'general',
  clientId: string | null = null,
): MeriGovernedTurnContext {
  return {
    version: 1,
    operationId: 'meri.chat',
    prompt: 'Governed context.',
    contextPacket: {
      packetId: null,
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
      clientId,
    },
    retrieval: {
      plan: {
        version: 1,
        queryClass: 'general',
        subjectScope,
        targetHint: null,
        recipeTool: null,
        requireCompleteCoverage: false,
        requiredDomains: [],
        timeWindow: null,
      },
      coverage: {
        version: 1,
        complete: true,
        requestedDomains: [],
        searchedDomains: [],
        missingDomains: [],
        partialDomains: [],
        requestedEntityCount: null,
        searchedEntityCount: null,
        recordsEvaluated: 0,
        recordsReturned: 0,
        paginationComplete: true,
        truncated: false,
        sourceHealth: [],
        unavailableSources: [],
        toolsInvoked: [],
        stopReason: 'complete',
      },
    },
  } as unknown as MeriGovernedTurnContext;
}

const originalFetch = global.fetch;

describe('MeriV3 managed MCP request path (Lane A1 reproduction)', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('admits and runs an advertised managed read once, feeding the real owner wire into the next provider input', async () => {
    const content = 'Untrusted external data from MCP server "meriv3-hubspot".\n[{"id":"1","properties":{"firstname":"Jane Finder"}}]';
    const call = functionCall('managed-call', MANAGED_READ, { query: 'Jane Finder' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(providerResult({ outputText: 'Jane Finder is a HubSpot contact.' }))
      .mockResolvedValue(providerResult({ outputText: 'Jane Finder is a HubSpot contact.' }));
    const { service } = buildManaged(complete, {
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse(managedOwnerWire(content)),
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
            toolPolicy: 'read-only',
            messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
          },
          { onEvent: (event) => events.push(event) },
        ),
    );

    // The advertised managed tool reached the model.
    expect(toolsOnCall(complete, 0)).toContain(MANAGED_READ);

    // It executed exactly once through the real API-managed owner bridge.
    const ownerPosts = managedOwnerPosts(fetchMock);
    expect(ownerPosts).toHaveLength(1);
    expect(ownerPosts[0]).toContain(encodeURIComponent(MANAGED_READ));

    // Exactly one ownerPOST with the correct forwarded auth/service identity,
    // and the vendor input is unchanged.
    const init = managedOwnerInit(fetchMock);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer bearer',
      'x-internal-service-secret': 'service-secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({ query: 'Jane Finder' });

    // The existing result.ledgerEntries receipt (exposed under read-only policy)
    // carries the real owner wire and the exact serialized wrapper.
    const ledger = (result.ledgerEntries ?? []).find((entry) => entry.tool === MANAGED_READ);
    expect(ledger).toBeDefined();
    // The receipt retains the real owner wire authority fields (opaque read
    // receipt, not fabricated structured facts).
    expect(ledger?.result).toMatchObject({
      tool: MANAGED_READ,
      server: 'meriv3-hubspot',
      untrusted: true,
    });
    expect(JSON.stringify(ledger?.result)).toContain('Jane Finder');
    expect(ledger?.serialized).toContain(`[Tool result from "${MANAGED_READ}"`);
    expect(ledger?.serialized).toContain('Jane Finder');

    // The next provider function_call_output is exactly that serialized receipt.
    const fedBack = fedBackInput(complete);
    expect(fedBack).toContain(ledger!.serialized);
    expect(fedBack).toContain(`[Tool result from "${MANAGED_READ}"`);
    expect(fedBack).not.toContain('no longer available under the current governed tool policy');

    // An opaque external read receipt is NOT a structured owner citation.
    expect((result.citations ?? []).some((citation) => citation.tool === MANAGED_READ)).toBe(false);
    expect(
      result.evidenceManifest?.sources.some((source) => source.tool === MANAGED_READ) ?? false,
    ).toBe(false);

    expect(result.reply).toContain('Jane Finder is a HubSpot contact.');
  });

  test('native advertised read control executes once through the registry dispatch (must stay green)', async () => {
    const call = functionCall('native-call', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(providerResult({ outputText: 'Kestrel commitment noted [1].' }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted [1].' }));
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

    // The extracted source is retained with its exact identity (number, record
    // id, tool and title) and surfaces in the evidence manifest: this is the real
    // canonical citation for the [1] marker in the final answer.
    const nativeCitation = result.citations?.find((citation) => citation.tool === NATIVE_READ);
    expect(nativeCitation).toMatchObject({
      n: 1,
      id: RECORD_ID,
      tool: NATIVE_READ,
      title: 'Kestrel commitment',
    });
    expect(
      result.evidenceManifest?.sources.some(
        (source) => source.tool === NATIVE_READ && source.id === RECORD_ID,
      ),
    ).toBe(true);
  });

  test('an unadvertised managed-prefixed name stays blocked and never reaches the managed bridge', async () => {
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

  test('a managed schema missing its authority metadata is never advertised and stays blocked', async () => {
    const call = functionCall('missing-meta', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const { service } = buildManaged(complete);

    const { source: _source, ...withoutSource } = managedSchema();
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [withoutSource] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        conversationId: 'missing-meta-thread',
        messages: [{ role: 'user', text: 'Find Jane.' }],
      }),
    );

    expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  test('an advertised managed write marker is never advertised and stays blocked', async () => {
    const call = functionCall('write-marker', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema({ readOnly: false })] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        conversationId: 'write-marker-thread',
        messages: [{ role: 'user', text: 'Find Jane.' }],
      }),
    );

    expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  test('a mismatched appId/server mapping is never advertised and stays blocked', async () => {
    const call = functionCall('mismatch', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      // appId says airtable, name says hubspot: mapping must be exact.
      managed: () => jsonResponse({ schemas: [managedSchema({ appId: 'airtable' })] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        conversationId: 'mismatch-thread',
        messages: [{ role: 'user', text: 'Find Jane.' }],
      }),
    );

    expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  test('a catalog revocation after the first advertisement leaves the managed read blocked before owner I/O', async () => {
    const call = functionCall('revoked', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(providerResult({ outputText: 'Blocked.' }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const { service } = buildManaged(complete);

    let managedCalls = 0;
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => {
        managedCalls += 1;
        // Advertised once (exposure); revoked on the pre-I/O revalidation.
        return jsonResponse({ schemas: managedCalls === 1 ? [managedSchema()] : [] });
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        conversationId: 'revoked-thread',
        messages: [{ role: 'user', text: 'Find Jane.' }],
      }),
    );

    expect(toolsOnCall(complete, 0)).toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    expect(fedBackInput(complete)).toContain('Connected-app tool is no longer available.');
  });

  test('a changed input schema on revalidation leaves the managed read blocked before owner I/O', async () => {
    const call = functionCall('changed-schema', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(providerResult({ outputText: 'Blocked.' }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const { service } = buildManaged(complete);

    let managedCalls = 0;
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => {
        managedCalls += 1;
        return jsonResponse({
          schemas:
            managedCalls === 1
              ? [managedSchema()]
              : [
                  managedSchema({
                    input_schema: {
                      type: 'object',
                      properties: { query: { type: 'string' }, limit: { type: 'number' } },
                    },
                  }),
                ],
        });
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        conversationId: 'changed-schema-thread',
        messages: [{ role: 'user', text: 'Find Jane.' }],
      }),
    );

    expect(toolsOnCall(complete, 0)).toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    expect(fedBackInput(complete)).toContain('Connected-app tool is no longer available.');
  });

  test('a request-scoped client never exposes or dispatches a managed read', async () => {
    const call = functionCall('client-scope', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        conversationId: 'client-scope-thread',
        clientId: CLIENT_ID,
        messages: [{ role: 'user', text: 'Find Jane.' }],
      }),
    );

    expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  test('governed client/portfolio scope resolves no managed authority at the admission seam', async () => {
    const { service } = buildManaged(jest.fn());
    const seam = service as unknown as {
      resolveCapabilityAuthority: (
        name: string,
        schema: unknown,
        dto: unknown,
      ) => unknown;
    };

    // Authenticated governed client.
    await runWithGovernedMeriContext(governedTurn('general', CLIENT_ID), async () => {
      expect(seam.resolveCapabilityAuthority(MANAGED_READ, managedSchema(), {})).toBeNull();
    });
    // Portfolio scope.
    await runWithGovernedMeriContext(governedTurn('portfolio'), async () => {
      expect(seam.resolveCapabilityAuthority(MANAGED_READ, managedSchema(), {})).toBeNull();
    });
    // Governed external ambiguity must not masquerade as personal.
    await runWithGovernedMeriContext(governedTurn('external_entity'), async () => {
      expect(seam.resolveCapabilityAuthority(MANAGED_READ, managedSchema(), {})).toBeNull();
    });
    // Ordinary personal NONCLIENT still resolves the managed read.
    expect(seam.resolveCapabilityAuthority(MANAGED_READ, managedSchema(), {})).not.toBeNull();
  });

  test('toolPolicy none blocks every managed read', async () => {
    const call = functionCall('none-policy', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        conversationId: 'none-policy-thread',
        toolPolicy: 'none',
        messages: [{ role: 'user', text: 'Find Jane.' }],
      }),
    );

    expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  test('a stop before dispatch leaves the managed read unexecuted', async () => {
    const controller = new AbortController();
    const call = functionCall('stopped', MANAGED_READ, { query: 'Jane' });
    const complete = jest.fn(async () => {
      controller.abort(new DOMException('Turn cancelled', 'AbortError'));
      return providerResult({ output: [call], outputText: '', functionCalls: [call] });
    });
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(
        context,
        {
          conversationId: 'stopped-thread',
          messages: [{ role: 'user', text: 'Find Jane.' }],
        },
        { signal: controller.signal },
      ),
    );

    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    expect(fedBackInput(complete)).not.toContain(`[Tool result from "${MANAGED_READ}"`);
  });

  test('a repeated identical managed read executes once and is answered with a pointer', async () => {
    const first = functionCall('dup-1', MANAGED_READ, { query: 'Jane' });
    const second = functionCall('dup-2', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [first, second], outputText: '', functionCalls: [first, second] }),
      )
      .mockResolvedValueOnce(providerResult({ outputText: 'Done.' }))
      .mockResolvedValue(providerResult({ outputText: 'Done.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse(managedOwnerWire('Untrusted external data.')),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        conversationId: 'dedupe-thread',
        messages: [{ role: 'user', text: 'Find Jane.' }],
      }),
    );

    expect(managedOwnerPosts(fetchMock)).toHaveLength(1);
    expect(fedBackInput(complete)).toContain('Identical to an earlier call in this turn');
  });

  test('catalog outage characterization: a schema fetch failure yields an empty catalog and no owner dispatch', async () => {
    // Characterization of CURRENT behavior (not a correctness requirement):
    // both catalogs 5xx -> silent empty catalog, run continues, no owner call.
    // Overall catalog-outage semantics remain a following bounded slice.
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
