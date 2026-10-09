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
 * Scope note (Lane A / A1): ordinary-chat managed reads plus explicit governed
 * negatives. The positive path and ordinary negatives run without any governed
 * context; dedicated governed negatives supply a valid ordinary
 * `meri.chat`/`general` context (client/portfolio/external scope, non-chat
 * operations) and prove the managed read is neither advertised nor dispatched,
 * with zero owner POST. Research execution / governed procedure denial and
 * malformed governed authority are proven at the admission seam. Nothing here
 * widens research `allowedReadCapabilities`, procedure admission, actor scope or
 * connector scope. Controller authentication and served HTTP reachability
 * require separate qualification. The negatives keep the managed namespace
 * narrow (validated advertised metadata, not name prefix alone).
 *
 * The positive owner wire is the REAL managed read shape returned by
 * `MeriV3SettingsController.executeManagedMcpRead` ->
 * `MeriManagedMcpService.executeRead` -> `MeriMcpService.executeBridged`:
 * `{ tool, server, untrusted: true, content }`, with no `structuredRead` on that
 * endpoint. No fabricated citations, contact records, source ids, facts or
 * structuredRead adapter are asserted: the opaque ledger receipt is distinct
 * from structured owner facts, which remain separately qualified.
 */

import type {
  MeriContext,
  MeriFixtureSemanticClock,
  MeriGovernedArtifactCapturePolicy,
  MeriGovernedTurnContext,
  ToolRegistry,
} from '@capiro/meriv2-core';
import {
  attestMeriGovernedContext,
  MERI_CASE46,
  MERI_FIXTURE_SEMANTIC_INSTANT,
  MERI_FIXTURE_SEMANTIC_ZONE,
  resolveMeriGovernedSemanticClock,
  validateMeriGovernedArtifactPolicy,
  verifyMeriGovernedContext,
} from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3-managed-mcp-assistant.service.js';
import type { MeriV3ChatResult, MeriV3ChatStreamEvent } from './meriv3.types.js';

/** The ACTUAL API-owned HubSpot read name (current managed read allowlist). */
const MANAGED_READ = 'mcp__meriv3_hubspot__search_crm_objects';
const UNADVERTISED_MANAGED = 'mcp__meriv3_hubspot__delete_contacts';
const NATIVE_READ = 'search_memory';

/**
 * The CURRENT API-owned Krisp read names under catalogId `meriv3-krisp`
 * (apps/api/src/meri/meri-managed-mcp.helpers.ts MANAGED_MCP_APPS.krisp). The
 * orchestrator bridge namespace is `mcp__meriv3_krisp__`.
 */
const KRISP_READS = [
  'mcp__meriv3_krisp__search_meetings',
  'mcp__meriv3_krisp__get_multiple_documents',
  'mcp__meriv3_krisp__list_folders',
] as const;
const KRISP_READ = KRISP_READS[0];

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

/** A current API-owned Krisp managed schema/owner wire (catalogId `meriv3-krisp`). */
function krispManagedSchema(overrides: Record<string, unknown> = {}) {
  return {
    name: KRISP_READ,
    description: 'Search Krisp meetings',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    source: 'managed_mcp',
    appId: 'krisp',
    appName: 'Krisp',
    readOnly: true,
    ...overrides,
  };
}

function krispOwnerWire(content: string, tool: (typeof KRISP_READS)[number] = KRISP_READ) {
  return { tool, server: 'meriv3-krisp', untrusted: true, content };
}

/**
 * A real inherited `read_client_documents` observation, exactly the shape the
 * API attests into `MeriGovernedTurnContext.inheritedDocumentEvidence` and that
 * `extractCitationsFromToolResult` produces (`source` locator + `documentEvidence`
 * page observation). Both `source.clientId` and `documentEvidence.clientId` are
 * authenticated client bindings; the evidence is real, not synthetic.
 */
function inheritedDocumentCitation(
  overrides: {
    source?: Record<string, unknown>;
    documentEvidence?: Record<string, unknown> | null;
  } = {},
) {
  const base = {
    n: 9,
    type: 'document',
    id: 'page-3',
    title: 'Master services agreement, page 3',
    url: null,
    snippet: 'Term: 24 months from the effective date.',
    tool: 'read_client_documents',
    source: {
      kind: 'document',
      recordId: 'page-3',
      clientId: CLIENT_ID,
      observedAt: '2026-09-01T00:00:00Z',
    },
    documentEvidence: {
      clientId: CLIENT_ID,
      documentId: 'doc-1',
      contentHash: 'hash-1',
      record: { recordId: 'page-3', text: 'Term: 24 months from the effective date.' },
      coverage: { truncated: false },
      observedAt: '2026-09-01T00:00:00Z',
    },
  };
  return {
    ...base,
    ...(overrides.source !== undefined ? { source: overrides.source } : {}),
    ...(overrides.documentEvidence !== undefined
      ? overrides.documentEvidence === null
        ? {}
        : { documentEvidence: overrides.documentEvidence }
      : {}),
  };
}

/**
 * A real authenticated server-readonly capture policy (see
 * packages/meriv2-core/src/context/server-readonly-capture.ts). It carries the
 * literal `dynamicMcpAllowed: false`; its `clientId` may legitimately be null.
 */
function serverReadonlyCapturePolicy(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    kind: 'server_readonly_acceptance_capture' as const,
    policyId: 'policy-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    turnId: null,
    caseId: null,
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: 'tenant-1',
    tenantSlug: 'meri-foundation-20260928-t1',
    actorUserId: 'user-1',
    conversationId: 'governed-thread',
    clientId: null,
    issuedAt: 0,
    expiresAt: 0,
    toolAuthority: 'shared_static_registry_read_only' as const,
    toolCatalogSha256: 'a'.repeat(64),
    dynamicMcpAllowed: false as const,
    incidentalWriters: 'suppressed' as const,
    expectedCaptureWrites: [] as const,
    ...overrides,
  };
}

/**
 * A COMPLETE, currently-valid governed-artifact capture policy (Case 46; see
 * packages/meriv2-core/src/context/governed-artifact-capture.ts). It is built
 * only from the canonical fixture-owner constants (`MERI_CASE46`) — tenant,
 * actor and client are the current owner's, never invented identifiers — and it
 * carries the full canonical source receipt, `allowedTool: 'create_word'`, the
 * canonical-current-user approval and the exact max effect counts. The issuance
 * window is real wall-clock, so `issuedAt <= now + 30s`, `expiresAt > now` and
 * `expiresAt - issuedAt <= 15m` hold for the sub-second span of one test.
 */
const CASE46_CAPTURE_RUN_ID = '11111111-1111-4111-8111-111111111111';
/** The artifact policy's current-verify digest; the semantic clock binds it. */
const CASE46_CURRENT_VERIFY_SHA256 = 'a'.repeat(64);
/**
 * Provider-free fixture signing secret. Used only to exercise the existing
 * `attestMeriGovernedContext`/`verifyMeriGovernedContext` pair against the Case
 * 46 fixture before `.run`; it is not a live service secret and mints no served
 * authority.
 */
const CAPTURE_FIXTURE_SECRET = 'capture-fixture-secret';

function governedArtifactCapturePolicy(
  now = Date.now(),
): MeriGovernedArtifactCapturePolicy {
  return {
    version: 1,
    kind: 'governed_artifact_acceptance_capture',
    caseId: '46',
    fixtureNamespace: MERI_CASE46.namespace,
    tenantId: MERI_CASE46.tenantId,
    tenantSlug: MERI_CASE46.tenantSlug,
    actorUserId: MERI_CASE46.actorUserId,
    clientId: MERI_CASE46.clientId,
    conversationId: CASE46_CAPTURE_RUN_ID,
    captureRunId: CASE46_CAPTURE_RUN_ID,
    policyId: CASE46_CAPTURE_RUN_ID,
    requestId: 'case46-request-1',
    traceId: 'case46-trace-1',
    turnId: CASE46_CAPTURE_RUN_ID,
    source: {
      owner: 'engagement_attachment',
      logicalId: MERI_CASE46.sourceLogicalId,
      physicalId: CASE46_CAPTURE_RUN_ID,
      rowVersion: '1',
      ownershipSha256: 'b'.repeat(64),
      contentSha256: MERI_CASE46.sha256,
      byteLength: MERI_CASE46.byteLength,
    },
    currentVerifySha256: CASE46_CURRENT_VERIFY_SHA256,
    qualificationSha256: 'c'.repeat(64),
    issuedAt: now,
    expiresAt: now + 60_000,
    allowedTool: 'create_word',
    approval: 'canonical_current_user_required',
    maximumProposals: 1,
    maximumArtifactEffects: 1,
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
      'provider_budget_ledger',
      'canonical_action_proposal',
      'approved_text_artifact',
    ],
  };
}

/**
 * The matching qualified fixture semantic clock for the Case 46 policy above.
 * `observedAt` must equal the policy `issuedAt` (validateMeriFixtureSemanticClock)
 * and `currentVerifySha256` must equal the policy's, so the real
 * `resolveMeriGovernedSemanticClock` accepts the bound authority and rejects any
 * mismatched clock. Nothing here mints authority: the API remains the only
 * current canonical owner that may produce this clock.
 */
function governedArtifactSemanticClock(issuedAt: number): MeriFixtureSemanticClock {
  return {
    version: 1,
    kind: 'qualified_original_fixture_semantic_clock',
    instant: MERI_FIXTURE_SEMANTIC_INSTANT,
    timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
    caseId: '46',
    captureRunId: CASE46_CAPTURE_RUN_ID,
    currentVerifySha256: CASE46_CURRENT_VERIFY_SHA256,
    observedAt: issuedAt,
  };
}

/**
 * A complete governed Case 46 turn projection: the capture policy, its matching
 * semantic clock, the current fixture-owner evidence envelope (so the resolver's
 * tenant/actor agreement holds) and the compiler `clockUse` agreeing on
 * instant/timeZone with a real `eligibilityAt`. The context packet client and the
 * retrieval subject scope are the policy's authenticated MERI_CASE46 client —
 * the canonical capture is client-scoped, not a general/null-client
 * approximation. Built per call so the wall-clock issuance window is fresh when
 * the real `.run` executes.
 */
function governedArtifactTurn(now = Date.now()): Record<string, unknown> {
  const policy = governedArtifactCapturePolicy(now);
  const base = governedTurn('client', MERI_CASE46.clientId);
  return {
    governedArtifactCapturePolicy: policy,
    semanticClock: governedArtifactSemanticClock(policy.issuedAt),
    evidence: {
      version: 1,
      tenantId: MERI_CASE46.tenantId,
      userId: MERI_CASE46.actorUserId,
      packetId: null,
      sourceRecordCount: 0,
      projectedRecordCount: 0,
      truncated: false,
      records: [],
    },
    contextPacket: {
      ...base.contextPacket,
      clockUse: {
        instant: MERI_FIXTURE_SEMANTIC_INSTANT,
        timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
        eligibilityAt: new Date(policy.issuedAt).toISOString(),
        scoring: 'used' as const,
      },
    },
    retrieval: base.retrieval,
  };
}

/** Merge typed overrides onto a valid ordinary `meri.chat`/`general` envelope. */
function governedWith(overrides: Record<string, unknown>): MeriGovernedTurnContext {
  return {
    ...(governedTurn('general', null) as unknown as Record<string, unknown>),
    ...overrides,
  } as unknown as MeriGovernedTurnContext;
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
    /** Optional action-proposal owner mock (defaults to an inert jest.fn()). */
    actionProposalCreate?: jest.Mock;
    /** Optional visual-analysis owner mock (defaults to available:false). */
    visualAnalysis?: {
      available: jest.Mock;
      execute: jest.Mock;
      discard: jest.Mock;
    };
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
    (options.actionProposalCreate
      ? { create: options.actionProposalCreate }
      : { create: jest.fn() }) as never,
    prisma() as never,
    cfg as never,
    new ApiManagedMcpRepo(cfg as never),
    (options.visualAnalysis ?? {
      available: jest.fn(async () => false),
      execute: jest.fn(async () => ({})),
      discard: jest.fn(async () => undefined),
    }) as never,
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

/**
 * Every managed catalog discovery request (`GET /api/clio/v3/mcp-tool-schemas`).
 * A governed capture/client turn must issue ZERO of these — the API discovery
 * hardens rows and the registry discovery writes lastSync/error metadata, so
 * absence of the request (not merely of the owner POST) is the property under
 * test.
 */
function managedSchemaGets(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/clio/v3/mcp-tool-schemas'));
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
  operationId = 'meri.chat',
): MeriGovernedTurnContext {
  return {
    version: 1,
    operationId,
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

  const malformedManagedSchemas: Array<[string, Record<string, unknown>]> = [
    ['an array input schema', { type: 'array', items: { type: 'string' } }],
    ['an input schema with no type', { properties: { query: { type: 'string' } } }],
    ['a scalar input schema type', { type: 'string' }],
  ];
  test.each(malformedManagedSchemas)(
    'a malformed non-object managed schema (%s) is never advertised or executed',
    async (_label, malformed) => {
      const call = functionCall('malformed-schema', MANAGED_READ, { query: 'Jane' });
      const complete = jest
        .fn()
        .mockResolvedValueOnce(
          providerResult({ output: [call], outputText: '', functionCalls: [call] }),
        )
        .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
      const { service } = buildManaged(complete);

      const fetchMock = fetchRouter({
        native: () => jsonResponse({ schemas: [] }),
        managed: () => jsonResponse({ schemas: [managedSchema({ input_schema: malformed })] }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        service.run(context, {
          conversationId: 'malformed-schema-thread',
          messages: [{ role: 'user', text: 'Find Jane.' }],
        }),
      );

      // Not model-callable: never advertised, and the model's call is blocked
      // before any owner I/O.
      expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
      expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    },
  );

  test.each(['meri.research', 'research.generate-report', 'workspace.generate'])(
    'a governed non-chat operation (%s) never exposes or dispatches a managed read',
    async (operationId) => {
      const call = functionCall('non-chat', MANAGED_READ, { query: 'Jane' });
      const complete = jest
        .fn()
        .mockResolvedValueOnce(
          providerResult({ output: [call], outputText: '', functionCalls: [call] }),
        )
        .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
      const { service } = buildManaged(complete);

      const fetchMock = fetchRouter({
        native: () => jsonResponse({ schemas: [] }),
        managed: () => jsonResponse({ schemas: [managedSchema()] }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        runWithGovernedMeriContext(governedTurn('general', null, operationId), () =>
          service.run(context, {
            conversationId: `non-chat-${operationId}`,
            messages: [{ role: 'user', text: 'Find Jane.' }],
          }),
        ),
      );

      expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
      expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    },
  );

  const governedScopeTurns: Array<['client' | 'portfolio' | 'external_entity', string | null]> = [
    ['client', CLIENT_ID],
    ['portfolio', null],
    ['external_entity', null],
  ];
  test.each(governedScopeTurns)(
    'a governed %s turn never exposes or dispatches a managed read through .run',
    async (subjectScope, clientId) => {
      const call = functionCall('governed-scope', MANAGED_READ, { query: 'Jane' });
      const complete = jest
        .fn()
        .mockResolvedValueOnce(
          providerResult({ output: [call], outputText: '', functionCalls: [call] }),
        )
        .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
      const { service } = buildManaged(complete);

      const fetchMock = fetchRouter({
        native: () => jsonResponse({ schemas: [] }),
        managed: () => jsonResponse({ schemas: [managedSchema()] }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        runWithGovernedMeriContext(governedTurn(subjectScope, clientId), () =>
          service.run(context, {
            conversationId: `governed-${subjectScope}`,
            messages: [{ role: 'user', text: 'Find Jane.' }],
          }),
        ),
      );

      expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
      expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    },
  );

  test('research execution and governed procedure requests resolve no managed authority at the admission seam', async () => {
    const { service } = buildManaged(jest.fn());
    const seam = service as unknown as {
      resolveCapabilityAuthority: (name: string, schema: unknown, dto: unknown) => unknown;
    };

    // A research execution request (durable lease or admitted plan envelope) is
    // never an ordinary personal NONCLIENT turn.
    expect(
      seam.resolveCapabilityAuthority(MANAGED_READ, managedSchema(), {
        researchRun: { sessionId: 'session-1', runId: 'run-1', leaseEpoch: 1 },
      }),
    ).toBeNull();
    expect(
      seam.resolveCapabilityAuthority(MANAGED_READ, managedSchema(), {
        researchPlanExecution: { scope: {} },
      }),
    ).toBeNull();
    // A governed procedure binding is not an ordinary personal turn.
    await runWithGovernedMeriContext(
      {
        ...governedTurn('general'),
        procedure: { version: 1 },
      } as unknown as MeriGovernedTurnContext,
      async () => {
        expect(seam.resolveCapabilityAuthority(MANAGED_READ, managedSchema(), {})).toBeNull();
      },
    );
    // Malformed/incomplete governed authority (missing operationId) must not be
    // treated as an ordinary personal turn either.
    await runWithGovernedMeriContext(
      { retrieval: { plan: { subjectScope: 'general' } } } as unknown as MeriGovernedTurnContext,
      async () => {
        expect(seam.resolveCapabilityAuthority(MANAGED_READ, managedSchema(), {})).toBeNull();
      },
    );
  });

  // ── Lane A1 typed NONCLIENT scope (governed personal admission) ──────────

  test('a valid governed personal meri.chat/general turn still admits one reviewed managed read and an opaque owner receipt', async () => {
    const content =
      'Untrusted external data from MCP server "meriv3-hubspot".\n[{"id":"1"}]';
    const call = functionCall('governed-personal', MANAGED_READ, { query: 'Jane Finder' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Jane Finder is a HubSpot contact.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse(managedOwnerWire(content)),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        runWithGovernedMeriContext(governedTurn('general', null), () =>
          service.run(context, {
            conversationId: 'governed-personal-thread',
            toolPolicy: 'read-only',
            messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
          }),
        ),
    );

    expect(toolsOnCall(complete, 0)).toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(1);
    const ledger = (result.ledgerEntries ?? []).find((entry) => entry.tool === MANAGED_READ);
    expect(ledger?.result).toMatchObject({
      tool: MANAGED_READ,
      server: 'meriv3-hubspot',
      untrusted: true,
    });
    expect(ledger?.serialized).toContain(`[Tool result from \"${MANAGED_READ}\"`);
    // Opaque receipt only: no fabricated structured citation from wrapped content.
    expect((result.citations ?? []).some((citation) => citation.tool === MANAGED_READ)).toBe(false);
  });

  test('a governed meri.chat/general turn carrying a source.clientId document binding never advertises or dispatches a managed read', async () => {
    const call = functionCall('inherited-source-client', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [call], outputText: '', functionCalls: [call] }),
      )
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    // Real read_client_documents observation with an authenticated clientId on
    // its exact source locator (documentEvidence omitted -> source-only binding).
    const governed = governedWith({
      inheritedDocumentEvidence: [
        inheritedDocumentCitation({
          source: {
            kind: 'document',
            recordId: 'page-3',
            clientId: CLIENT_ID,
            observedAt: '2026-09-01T00:00:00Z',
          },
          documentEvidence: null,
        }),
      ],
    });

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      runWithGovernedMeriContext(governed, () =>
        service.run(context, {
          conversationId: 'inherited-source-thread',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: 'Find Jane.' }],
        }),
      ),
    );

    expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  test('a governed meri.chat/general turn carrying a documentEvidence.clientId observation blocks the managed read and preserves the inherited source/ledger', async () => {
    const call = functionCall('inherited-doc-client', MANAGED_READ, { query: 'Jane' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [call], outputText: '', functionCalls: [call] }),
      )
      .mockResolvedValue(
        providerResult({ outputText: 'Term is 24 months from the effective date [9].' }),
      );
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const governed = governedWith({
      inheritedDocumentEvidence: [inheritedDocumentCitation()],
    });

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        runWithGovernedMeriContext(governed, () =>
          service.run(context, {
            conversationId: 'inherited-document-thread',
            toolPolicy: 'read-only',
            messages: [{ role: 'user', text: 'What is the term in the agreement?' }],
          }),
        ),
    );

    // Client-bound turn: no managed advertisement, no owner I/O.
    expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);

    // The inherited read_client_documents source/ledger integrity is preserved:
    // the real observation is still citable and still carries its clientId.
    const inheritedCitation = (result.citations ?? []).find(
      (citation) => citation.tool === 'read_client_documents' && citation.id === 'page-3',
    );
    expect(inheritedCitation).toMatchObject({ n: 9, tool: 'read_client_documents', id: 'page-3' });
    const inheritedLedger = (result.ledgerEntries ?? []).find(
      (entry) => entry.tool === 'read_client_documents',
    );
    expect(inheritedLedger?.result).toMatchObject({
      tool: 'read_client_documents',
      origin: 'conversation',
      clientId: CLIENT_ID,
      document: { id: 'doc-1', contentHash: 'hash-1' },
    });
  });

  /**
   * Per-row run binding: the actor MeriContext the request actually runs as and
   * the request DTO (conversationId/messages, optional client focus) the
   * governed context is bound to. The canonical Case 46 row runs as the real
   * MERI_CASE46 owner identities on the policy conversation/client, while the
   * independent server-readonly row stays a generic meri.chat/general
   * null-client capture on its own thread.
   */
  type GovernedCaptureRun = {
    context: MeriContext;
    actor: { tenantId: string; userId: string };
    dto: {
      conversationId: string;
      clientId?: string;
      messages: Array<{ role: 'user'; text: string }>;
    };
  };

  /** The actual Case 46 request: MERI_CASE46 actor, policy conversation/client. */
  const case46CaptureRun = (): GovernedCaptureRun => ({
    context: {
      tenantId: MERI_CASE46.tenantId,
      userId: MERI_CASE46.actorUserId,
      firmMemory: null,
      userVoice: null,
      clientSteering: null,
      clientRoster: [],
    } as unknown as MeriContext,
    actor: { tenantId: MERI_CASE46.tenantId, userId: MERI_CASE46.actorUserId },
    dto: {
      conversationId: CASE46_CAPTURE_RUN_ID,
      clientId: MERI_CASE46.clientId,
      messages: [{ role: 'user', text: MERI_CASE46.prompt }],
    },
  });

  /** The independent server-readonly null-client capture: generic actor/thread. */
  const serverReadonlyCaptureRun = (): GovernedCaptureRun => ({
    context,
    actor: { tenantId: context.tenantId, userId: context.userId },
    dto: {
      conversationId: 'capture-scope-thread',
      messages: [{ role: 'user', text: 'Find Jane.' }],
    },
  });

  const governedCaptureTurns: Array<
    [string, () => Record<string, unknown>, () => GovernedCaptureRun]
  > = [
    [
      'server-readonly null-client capture (meri.chat/general)',
      () => ({ serverReadonlyCapturePolicy: serverReadonlyCapturePolicy() }),
      serverReadonlyCaptureRun,
    ],
    [
      'governed-artifact capture (meri.chat/client — actual Case 46 MERI_CASE46 client scope)',
      // Built per test so the Case 46 policy/clock issuance window is current.
      () => governedArtifactTurn(),
      case46CaptureRun,
    ],
  ];
  test.each(governedCaptureTurns)(
    'a governed turn under %s never advertises or dispatches a managed read',
    async (_label, makeOverrides, makeRun) => {
      const call = functionCall('capture-scope', MANAGED_READ, { query: 'Jane' });
      const complete = jest
        .fn()
        .mockResolvedValueOnce(
          providerResult({ output: [call], outputText: '', functionCalls: [call] }),
        )
        .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
      const { service } = buildManaged(complete);

      const fetchMock = fetchRouter({
        native: () => jsonResponse({ schemas: [] }),
        managed: () => jsonResponse({ schemas: [managedSchema()] }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      // The capture policies carry the literal dynamicMcpAllowed:false; a null
      // (server-readonly) capture client never relaxes the dynamic-read denial.
      const overrides = makeOverrides();
      const governed = governedWith({
        contextPacket: { ...governedTurn('general', null).contextPacket, clientId: null },
        ...overrides,
      });
      const run = makeRun();

      // Independently exercise the EXISTING canonical validators/resolver and the
      // real attest/verify pair on this fixture: the authority and the exact
      // request binding are checked, not assumed, before the real `.run`.
      const artifactPolicy = overrides.governedArtifactCapturePolicy as
        | MeriGovernedArtifactCapturePolicy
        | undefined;
      let effectiveGoverned: MeriGovernedTurnContext = governed;
      if (artifactPolicy) {
        expect(() =>
          validateMeriGovernedArtifactPolicy(artifactPolicy, {
            tenantId: MERI_CASE46.tenantId,
            actorUserId: MERI_CASE46.actorUserId,
            conversationId: CASE46_CAPTURE_RUN_ID,
            clientId: MERI_CASE46.clientId,
          }),
        ).not.toThrow();
        // The REAL semantic-clock resolver accepts the policy-bound clock...
        expect(resolveMeriGovernedSemanticClock(governed)).toBeDefined();
        // ...and still rejects a clock bound to a different current-verify digest,
        // proving the guard rejects a mismatched clock rather than being bypassed.
        const mismatched = governedWith({
          ...overrides,
          semanticClock: {
            ...(overrides.semanticClock as MeriFixtureSemanticClock),
            currentVerifySha256: 'd'.repeat(64),
          },
        });
        expect(() => resolveMeriGovernedSemanticClock(mismatched)).toThrow(
          'meri_fixture_semantic_clock_context_mismatch',
        );

        // Provider-free fixture validation with the EXISTING attest/verify pair,
        // using the EXACT DTO binding and actor the request is about to run as.
        // This is not a mock/fake success and not a cast of an incomplete
        // policy: it proves the authenticated request binding and bearer actor
        // agree with the real policy/clock/evidence. It is a fixture check — not
        // live issuance, production auth, or served acceptance.
        const binding = {
          conversationId: run.dto.conversationId,
          clientId: run.dto.clientId,
          messages: run.dto.messages,
        };
        const attested = attestMeriGovernedContext(
          governed,
          binding,
          CAPTURE_FIXTURE_SECRET,
        );
        expect(() =>
          verifyMeriGovernedContext(attested, binding, run.actor, CAPTURE_FIXTURE_SECRET),
        ).not.toThrow();
        // A bearer actor that disagrees with the evidence identity never
        // authenticates the same fixture.
        expect(() =>
          verifyMeriGovernedContext(
            attested,
            binding,
            { tenantId: run.actor.tenantId, userId: 'not-the-case46-actor' },
            CAPTURE_FIXTURE_SECRET,
          ),
        ).toThrow();
        effectiveGoverned = attested;
      }

      await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        runWithGovernedMeriContext(effectiveGoverned, () =>
          service.run(run.context, run.dto),
        ),
      );

      // Zero managed tools on the provider input, ZERO managed owner POST, and
      // — the new pre-discovery property — ZERO managed catalog GET. The API
      // discovery would otherwise harden rows and write registry metadata even
      // though the owner read is denied.
      expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
      expect(toolsOnCall(complete, 0).some((name) => name.startsWith('mcp__'))).toBe(false);
      expect(managedSchemaGets(fetchMock)).toHaveLength(0);
      expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    },
  );

  /**
   * Retained native static-read control in a valid typed capture turn. The
   * capture policy's `dynamicMcpAllowed: false` forbids dynamic managed
   * discovery; it does not remove the static read-only registry surface
   * (`toolAuthority: 'shared_static_registry_read_only'`). This proves the
   * pre-discovery refusal is narrow: the real native `search_memory` catalog and
   * tool remain callable through the REAL RequestCredentialsStore / ApiManagedMcpRepo
   * / routed fetch, and its canonical receipt/ledger is preserved, while managed
   * discovery is never issued.
   */
  test('a valid typed capture turn still advertises and runs the retained native search_memory read (with its real receipt/ledger) while managed discovery is forbidden', async () => {
    const call = functionCall('capture-native-call', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [call], outputText: '', functionCalls: [call] }),
      )
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted [1].' }));
    const invoke = jest.fn(
      async (..._args: Parameters<ToolRegistry['invoke']>) => memoryOwnerPayload(),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
    });

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      // A managed catalog is registered so a regression that STILL fetches it is
      // observable, but the capture authority must forbid the fetch entirely.
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse(managedOwnerWire('should-not-run')),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const governed = governedWith({
      serverReadonlyCapturePolicy: serverReadonlyCapturePolicy(),
    });

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        runWithGovernedMeriContext(governed, () =>
          service.run(context, {
            conversationId: 'capture-native-thread',
            messages: [{ role: 'user', text: 'What do we know about Kestrel?' }],
          }),
        ),
    );

    // The native static read is advertised and executed exactly once through
    // the real registry dispatch (not a helper/direct invoke).
    expect(toolsOnCall(complete, 0)).toContain(NATIVE_READ);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe(NATIVE_READ);
    expect(fedBackInput(complete)).toContain(`[Tool result from \"${NATIVE_READ}\"`);

    // Its real canonical citation and evidence source are preserved with exact
    // identity — the capture turn is not silently emptied of native reads.
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

    // Managed discovery and dispatch remain forbidden on the same turn.
    expect(managedSchemaGets(fetchMock)).toHaveLength(0);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    expect(toolsOnCall(complete, 0).some((name) => name.startsWith('mcp__'))).toBe(false);
  });

  const governedMissingScopeTurns: Array<[string, Record<string, unknown>]> = [
    ['a missing retrieval block', { retrieval: undefined }],
    ['a retrieval block without a plan', { retrieval: { coverage: {} } }],
    [
      'a plan without a subject scope',
      { retrieval: { plan: { version: 1, queryClass: 'general' } } },
    ],
  ];
  test.each(governedMissingScopeTurns)(
    'a governed meri.chat turn with %s never advertises or dispatches a managed read',
    async (_label, overrides) => {
      const call = functionCall('missing-scope', MANAGED_READ, { query: 'Jane' });
      const complete = jest
        .fn()
        .mockResolvedValueOnce(
          providerResult({ output: [call], outputText: '', functionCalls: [call] }),
        )
        .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
      const { service } = buildManaged(complete);

      const fetchMock = fetchRouter({
        native: () => jsonResponse({ schemas: [] }),
        managed: () => jsonResponse({ schemas: [managedSchema()] }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      // Absence of a retrieval plan / explicit subject scope is incomplete
      // authority: it is never treated as an ordinary personal turn.
      await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        runWithGovernedMeriContext(governedWith(overrides), () =>
          service.run(context, {
            conversationId: 'missing-scope-thread',
            messages: [{ role: 'user', text: 'Find Jane.' }],
          }),
        ),
      );

      expect(toolsOnCall(complete, 0)).not.toContain(MANAGED_READ);
      expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    },
  );

  test('a malformed governed contextPacket is refused by the existing entry guard and the supplementary final admission seam with zero provider/owner I/O', async () => {
    const complete = jest.fn();
    const { service } = buildManaged(complete);
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse(managedOwnerWire('should-not-run')),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const SECRET = 'governed-entry-secret';
    const actor = { tenantId: 'tenant-1', userId: 'user-1' };
    const withoutPacket = {
      ...governedWith({
        evidence: {
          version: 1,
          tenantId: actor.tenantId,
          userId: actor.userId,
          packetId: null,
          sourceRecordCount: 0,
          projectedRecordCount: 0,
          truncated: false,
          records: [],
        },
      }),
    } as Record<string, unknown>;
    delete withoutPacket.contextPacket;
    const malformed = withoutPacket as unknown as MeriGovernedTurnContext;

    // The EXISTING entry guard dereferences contextPacket.packetId and rejects a
    // malformed (missing) governed context packet before any normal run begins.
    // (Signed so the reject is genuinely the packet defect, not a missing proof.)
    const signed = attestMeriGovernedContext(
      malformed,
      { conversationId: 'malformed-thread' },
      SECRET,
      Date.now(),
    );
    expect(() =>
      verifyMeriGovernedContext(
        signed,
        { conversationId: 'malformed-thread' },
        actor,
        SECRET,
        Date.now(),
      ),
    ).toThrow();

    // The SUPPLEMENTARY final admission seam refuses the same malformed context
    // (no authenticated packet -> fail closed) with no managed authority.
    const seam = service as unknown as {
      resolveCapabilityAuthority: (name: string, schema: unknown, dto: unknown) => unknown;
    };
    await runWithGovernedMeriContext(malformed, async () => {
      expect(seam.resolveCapabilityAuthority(MANAGED_READ, managedSchema(), {})).toBeNull();
    });

    // No provider turn ran and no owner I/O was attempted.
    expect(complete).not.toHaveBeenCalled();
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  // ── Current API-owned Krisp parity (catalogId meriv3-krisp) ─────────────

  test.each(KRISP_READS)(
    'the gated advertised Krisp read %s reaches the model and dispatches once through the real owner bridge',
    async (name) => {
      const content =
        'Untrusted external data from MCP server "meriv3-krisp".\n[{"id":"meeting-1"}]';
      const call = functionCall('krisp-call', name, { query: 'budget sync' });
      const complete = jest
        .fn()
        .mockResolvedValueOnce(
          providerResult({ output: [call], outputText: '', functionCalls: [call] }),
        )
        .mockResolvedValue(providerResult({ outputText: 'Meeting noted.' }));
      const { service } = buildManaged(complete, {
        configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
      });

      const fetchMock = fetchRouter({
        native: () => jsonResponse({ schemas: [] }),
        managed: () => jsonResponse({ schemas: [krispManagedSchema({ name })] }),
        owner: () => jsonResponse(krispOwnerWire(content, name)),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result: MeriV3ChatResult = await RequestCredentialsStore.run(
        { bearerToken: 'bearer' },
        () =>
          service.run(
            context,
            {
              conversationId: 'krisp-thread',
              toolPolicy: 'read-only',
              messages: [{ role: 'user', text: 'Search my Krisp meetings.' }],
            },
          ),
      );

      expect(toolsOnCall(complete, 0)).toContain(name);
      const ownerPosts = managedOwnerPosts(fetchMock);
      expect(ownerPosts).toHaveLength(1);
      expect(ownerPosts[0]).toContain(encodeURIComponent(name));
      const init = managedOwnerInit(fetchMock);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer bearer',
        'x-internal-service-secret': 'service-secret',
        'content-type': 'application/json',
      });
      // Opaque owner receipt retains the real Krisp wire; no fabricated citation.
      const ledger = (result.ledgerEntries ?? []).find((entry) => entry.tool === name);
      expect(ledger?.result).toMatchObject({ tool: name, server: 'meriv3-krisp', untrusted: true });
      expect((result.citations ?? []).some((citation) => citation.tool === name)).toBe(false);
    },
  );

  const krispDeniedMetadata: Array<[string, Record<string, unknown>]> = [
    ['missing source/manifest metadata', { source: undefined, appId: undefined }],
    ['a mismatched appId/server mapping', { appId: 'hubspot' }],
    ['an advertised write marker', { readOnly: false }],
  ];
  test.each(krispDeniedMetadata)(
    'a Krisp read with %s is never advertised and stays blocked',
    async (_label, overrides) => {
      const call = functionCall('krisp-denied', KRISP_READ, { query: 'meetings' });
      const complete = jest
        .fn()
        .mockResolvedValueOnce(
          providerResult({ output: [call], outputText: '', functionCalls: [call] }),
        )
        .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
      const { service } = buildManaged(complete);

      const schema = krispManagedSchema(overrides);
      const fetchMock = fetchRouter({
        native: () => jsonResponse({ schemas: [] }),
        managed: () => jsonResponse({ schemas: [schema] }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        service.run(context, {
          conversationId: 'krisp-denied-thread',
          messages: [{ role: 'user', text: 'Search my Krisp meetings.' }],
        }),
      );

      expect(toolsOnCall(complete, 0)).not.toContain(KRISP_READ);
      expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    },
  );

  // ── Lane A1 authenticated governed single-client target ──────────────────
  //
  // These exercise the REAL `.run` pipeline (admission + `executeFunctionCalls`
  // + `invokeTool`) with a valid governed `client` subject: the authenticated
  // context packet resolves one client (Beta) while the interface selection
  // (the original DTO client) is a different client (Acme). A canonical native
  // read is re-targeted to the authenticated client; an explicit different
  // client, a bound effect/artifact, and a governed turn with no single
  // authorized client are refused before any owner I/O, replay, dedup or
  // persistence. No managed authority is invented and no UI client is used as a
  // fallback.

  const UI_ACME = '30000000-0000-4000-8000-0000000000ac';
  const AUTH_BETA = '30000000-0000-4000-8000-0000000000be';
  const CLIENT_READ = 'get_client_context';

  /** A native read schema whose owner input is scoped by a Capiro client id. */
  function clientScopedNativeSchema(name: string) {
    return {
      name,
      description: name,
      input_schema: {
        type: 'object',
        properties: { clientId: { type: 'string' }, query: { type: 'string' } },
      },
    };
  }

  /** A minimal, honest `get_client_context` owner receipt (no invented facts). */
  function getClientContextOwnerPayload(clientId: string) {
    return { tool: CLIENT_READ, client: { id: clientId } };
  }

  function clientSubjectTurn(): MeriGovernedTurnContext {
    return governedTurn('client', AUTH_BETA);
  }

  test('a client-scoped governed turn re-targets an omitted native read to the authenticated packet client', async () => {
    const call = functionCall('governed-read', CLIENT_READ, {});
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Beta profile returned.' }));
    const invoke = jest.fn(async (_name: string, input: Record<string, unknown>) =>
      getClientContextOwnerPayload(String(input.clientId)),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
    });
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ)] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      runWithGovernedMeriContext(clientSubjectTurn(), () =>
        service.run(context, {
          clientId: UI_ACME,
          conversationId: 'governed-target-thread',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: 'Summarize the client.' }],
        }),
      ),
    );

    // The owner received the AUTHENTICATED client (Beta), never the interface
    // selection (Acme).
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe(CLIENT_READ);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ clientId: AUTH_BETA });
    expect(fedBackInput(complete)).toContain(CLIENT_READ);
  });

  test('a client-scoped governed turn keeps an explicit governed-client native read pinned to that client', async () => {
    const call = functionCall('governed-read-beta', CLIENT_READ, { clientId: AUTH_BETA });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Beta profile returned.' }));
    const invoke = jest.fn(async (_name: string, input: Record<string, unknown>) =>
      getClientContextOwnerPayload(String(input.clientId)),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ)] }),
    }) as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      runWithGovernedMeriContext(clientSubjectTurn(), () =>
        service.run(context, {
          clientId: UI_ACME,
          conversationId: 'governed-target-explicit-thread',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: 'Summarize the client.' }],
        }),
      ),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ clientId: AUTH_BETA });
  });

  test('a client-scoped governed turn refuses an explicit interface-client native read with zero dispatch', async () => {
    const call = functionCall('governed-read-acme', CLIENT_READ, { clientId: UI_ACME });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'I did not run the cross-client request.' }));
    const invoke = jest.fn();
    const { service } = buildManaged(complete, {
      registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
    });
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ)] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        runWithGovernedMeriContext(clientSubjectTurn(), () =>
          service.run(context, {
            clientId: UI_ACME,
            conversationId: 'governed-target-acme-thread',
            toolPolicy: 'read-only',
            messages: [{ role: 'user', text: 'Summarize the client.' }],
          }),
        ),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(result.steps).toEqual([
      expect.objectContaining({ tool: CLIENT_READ, status: 'blocked' }),
    ]);
    expect(fedBackInput(complete)).toContain('different client');
  });

  test.each(['portfolio', 'external_entity', 'general'] as const)(
    'a governed %s turn never falls back to the interface client for a client-bearing native read',
    async (subjectScope) => {
      const call = functionCall('governed-read-nofallback', CLIENT_READ, {});
      const complete = jest
        .fn()
        .mockResolvedValueOnce(
          providerResult({ output: [call], outputText: '', functionCalls: [call] }),
        )
        .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
      const invoke = jest.fn();
      const { service } = buildManaged(complete, {
        registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
      });
      global.fetch = fetchRouter({
        native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ)] }),
      }) as unknown as typeof fetch;

      const result: MeriV3ChatResult = await RequestCredentialsStore.run(
        { bearerToken: 'bearer' },
        () =>
          runWithGovernedMeriContext(governedTurn(subjectScope, null), () =>
            service.run(context, {
              clientId: UI_ACME,
              conversationId: `governed-nofallback-${subjectScope}`,
              toolPolicy: 'read-only',
              messages: [{ role: 'user', text: 'Summarize the client.' }],
            }),
          ),
      );

      expect(invoke).not.toHaveBeenCalled();
      expect(result.steps).toEqual([
        expect.objectContaining({ tool: CLIENT_READ, status: 'blocked' }),
      ]);
    },
  );

  test('a client-scoped governed turn with no authenticated packet client refuses a client-bearing native read (missing single authority)', async () => {
    const call = functionCall('governed-read-missing', CLIENT_READ, {});
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const invoke = jest.fn();
    const { service } = buildManaged(complete, {
      registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ)] }),
    }) as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      // subjectScope 'client' but the authenticated packet carries no client id.
      runWithGovernedMeriContext(governedTurn('client', null), () =>
        service.run(context, {
          clientId: UI_ACME,
          conversationId: 'governed-missing-thread',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: 'Summarize the client.' }],
        }),
      ),
    );

    expect(invoke).not.toHaveBeenCalled();
  });

  test('an omitted mail read stays personal in a client-scoped governed turn while an explicit mail client respects the authenticated target', async () => {
    // Omitted -> personal mailbox omission is preserved (no injected client).
    const omitted = functionCall('mail-omitted', 'list_emails', {
      withinDays: 14,
      folder: 'inbox',
    });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [omitted], outputText: '', functionCalls: [omitted] }),
      )
      .mockResolvedValue(providerResult({ outputText: 'Your inbox.' }));
    const invoke = jest.fn(async () => ({ messages: [] }));
    const { service } = buildManaged(complete, {
      registry: registry([{ name: 'list_emails', readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema('list_emails')] }),
    }) as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      runWithGovernedMeriContext(clientSubjectTurn(), () =>
        service.run(context, {
          clientId: UI_ACME,
          conversationId: 'governed-mail-omitted-thread',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: 'My inbox the last two weeks.' }],
        }),
      ),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ withinDays: 14, folder: 'inbox' });

    // Explicit authenticated client -> pinned to the authenticated target.
    const explicitBeta = functionCall('mail-beta', 'list_emails', {
      clientId: AUTH_BETA,
      withinDays: 14,
    });
    const completeBeta = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [explicitBeta], outputText: '', functionCalls: [explicitBeta] }),
      )
      .mockResolvedValue(providerResult({ outputText: 'Client mail.' }));
    const invokeBeta = jest.fn(async () => ({ messages: [] }));
    const { service: serviceBeta } = buildManaged(completeBeta, {
      registry: registry([{ name: 'list_emails', readOnly: true }], invokeBeta),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema('list_emails')] }),
    }) as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      runWithGovernedMeriContext(clientSubjectTurn(), () =>
        serviceBeta.run(context, {
          clientId: UI_ACME,
          conversationId: 'governed-mail-explicit-thread',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: "Read Beta's mail." }],
        }),
      ),
    );
    expect(invokeBeta).toHaveBeenCalledTimes(1);
    expect(invokeBeta.mock.calls[0]?.[1]).toEqual({ clientId: AUTH_BETA, withinDays: 14 });
  });

  test('an interface-client mismatch blocks save_memory before any proposal or persistence', async () => {
    const call = functionCall('save-memory', 'save_memory', {
      content: 'Briefs include the program office.',
      scope: 'client',
    });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const invoke = jest.fn();
    const proposal = jest.fn();
    const { service } = buildManaged(complete, {
      registry: registry([{ name: 'save_memory', readOnly: false }], invoke),
      actionProposalCreate: proposal,
    });
    global.fetch = fetchRouter({
      native: () =>
        jsonResponse({
          schemas: [
            {
              name: 'save_memory',
              description: 'Save memory.',
              input_schema: {
                type: 'object',
                properties: { content: { type: 'string' }, scope: { type: 'string' } },
              },
            },
          ],
        }),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        runWithGovernedMeriContext(clientSubjectTurn(), () =>
          service.run(context, {
            clientId: UI_ACME,
            conversationId: 'governed-save-memory-thread',
            messages: [{ role: 'user', text: 'Remember that briefs include the program office.' }],
          }),
        ),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(proposal).not.toHaveBeenCalled();
    expect(result.pendingApprovals ?? []).toEqual([]);
    expect(result.steps).toEqual([
      expect.objectContaining({ tool: 'save_memory', status: 'blocked' }),
    ]);
  });

  test('an interface-client mismatch blocks create_word before any proposal or artifact', async () => {
    const call = functionCall('create-word', 'create_word', { title: 'Briefing' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const invoke = jest.fn();
    const proposal = jest.fn();
    const { service } = buildManaged(complete, {
      registry: registry([{ name: 'create_word', readOnly: false }], invoke),
      actionProposalCreate: proposal,
    });
    global.fetch = fetchRouter({
      native: () =>
        jsonResponse({
          schemas: [
            {
              name: 'create_word',
              description: 'Create a Word document.',
              input_schema: { type: 'object', properties: { title: { type: 'string' } } },
            },
          ],
        }),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        runWithGovernedMeriContext(clientSubjectTurn(), () =>
          service.run(context, {
            clientId: UI_ACME,
            conversationId: 'governed-create-word-thread',
            messages: [{ role: 'user', text: 'Create a Word briefing.' }],
          }),
        ),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(proposal).not.toHaveBeenCalled();
    expect(result.artifacts ?? []).toEqual([]);
    expect(result.steps).toEqual([
      expect.objectContaining({ tool: 'create_word', status: 'blocked' }),
    ]);
  });

  test('an interface-client mismatch suppresses the run_analysis owner POST before any persistence', async () => {
    const call = functionCall('run-analysis', 'run_analysis', { purpose: 'Rank results' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const invoke = jest.fn();
    const visual = {
      available: jest.fn(async () => true),
      execute: jest.fn(async () => ({})),
      discard: jest.fn(async () => undefined),
    };
    const { service } = buildManaged(complete, {
      registry: registry([{ name: 'run_analysis', readOnly: true }], invoke),
      visualAnalysis: visual,
    });
    const fetchMock = fetchRouter({
      native: () =>
        jsonResponse({
          schemas: [
            {
              name: 'run_analysis',
              description: 'Execute Python.',
              input_schema: { type: 'object', properties: { purpose: { type: 'string' } } },
            },
          ],
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        runWithGovernedMeriContext(clientSubjectTurn(), () =>
          service.run(context, {
            clientId: UI_ACME,
            conversationId: 'governed-run-analysis-thread',
            messages: [{ role: 'user', text: 'Chart the ranking.' }],
          }),
        ),
    );

    expect(visual.execute).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((entry) => String(entry[0])).some((url) => url.includes('visual-analysis'))).toBe(false);
    expect(result.artifacts ?? []).toEqual([]);
    expect(result.steps).toEqual([
      expect.objectContaining({ tool: 'run_analysis', status: 'blocked' }),
    ]);
  });

  test('an ordinary ungoverned turn still pins a native read to the selected client (legacy control)', async () => {
    const call = functionCall('legacy-read', CLIENT_READ, {});
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Legacy profile.' }));
    const invoke = jest.fn(async (_name: string, input: Record<string, unknown>) =>
      getClientContextOwnerPayload(String(input.clientId)),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ)] }),
    }) as unknown as typeof fetch;

    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        clientId: UI_ACME,
        conversationId: 'legacy-control-thread',
        toolPolicy: 'read-only',
        messages: [{ role: 'user', text: 'Summarize the client.' }],
      }),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ clientId: UI_ACME });
  });
});
