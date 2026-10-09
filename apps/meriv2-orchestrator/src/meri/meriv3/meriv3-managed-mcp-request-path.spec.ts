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
  createGetClientContextTool,
  createMeriResearchPlanExecutionEnvelope,
  InMemoryToolRegistry,
  MERI_CASE46,
  MERI_FIXTURE_SEMANTIC_INSTANT,
  MERI_FIXTURE_SEMANTIC_ZONE,
  registerDelegatedTools,
  resolveMeriGovernedSemanticClock,
  validateMeriGovernedArtifactPolicy,
  verifyMeriGovernedContext,
} from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { ApiClientContextRepo } from '../api-client-context.repo.js';
import { ApiToolExecutorRepo } from '../api-tool-executor.repo.js';
import { FULL_CHAT_READ_TOOLS } from '../full-chat-read-tools.catalog.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { ApiVisualAnalysisRepo } from './api-visual-analysis.repo.js';
import { resolveMeriV3ReasoningProfile } from './meriv3-reasoning.js';
import {
  CROSS_CLIENT_REFUSAL,
  GOVERNED_BOUND_EFFECT_REFUSAL,
  GOVERNED_NO_SINGLE_CLIENT_REFUSAL,
} from './meriv3-assistant.service.js';
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
/**
 * A DISTINCT identity for the SAME tool's LOGICAL failure. It must never be
 * restored into a published reply/citation, so each part is a distinctive
 * sentinel asserted absent below.
 */
const FAILED_RECORD_ID = '50000000-0000-4000-8000-0000000000ff';
const FAILED_TITLE = 'Beta revoked commitment';
const FAILED_SNIPPET = 'Revoked Beta owner snippet must never be published';

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
 * Interface client used by the governed single-client target fixtures. Declared
 * at module scope (not inside a single `describe`) because the request-local
 * catalog-availability describe also drives the same authenticated client
 * target; before this relocation the second describe could not see it (TS2304,
 * AA221 check receipt).
 */
const UI_ACME = '30000000-0000-4000-8000-0000000000ac';

/**
 * A native read schema whose owner input is scoped by a Capiro client id.
 * `required` mirrors the ACTUAL owner contract: `get_client_context` REQUIRES
 * clientId while `list_emails`/`search_memory` only expose it optionally.
 * Declared at module scope for the same reason as `UI_ACME` above.
 */
function clientScopedNativeSchema(name: string, required?: readonly string[]) {
  return {
    name,
    description: name,
    input_schema: {
      type: 'object',
      properties: { clientId: { type: 'string' }, query: { type: 'string' } },
      ...(required ? { required: [...required] } : {}),
    },
  };
}

/** Every native catalog discovery request (`GET /api/clio/tool-schemas`). */
function nativeSchemaGets(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/clio/tool-schemas'));
}

/**
 * Every native delegated owner POST (`POST /api/clio/tools/:name`). Distinct
 * from the managed owner bridge (`/api/clio/v3/mcp-tools/:name`).
 */
function nativeOwnerPosts(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/clio/tools/'));
}

function nativeOwnerInit(fetchMock: jest.Mock): RequestInit | undefined {
  const call = fetchMock.mock.calls.find((candidate) =>
    String(candidate[0]).includes('/api/clio/tools/'),
  );
  return call?.[1] as RequestInit | undefined;
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

/**
 * A LOGICAL owner failure for the SAME tool: a canonical `search_memory`
 * envelope whose coverage reports the memory content unavailable, carrying a
 * DISTINCT citable record (id/title/snippet). It is deliberately NOT an
 * `{ error }` transport body: `extractCitationsFromToolResult` returns [] for an
 * `error`, so this is the exact owner-shaped failure that can expose a
 * tool-name-only citation restoration. Its distinct identity must never appear
 * in the published reply or citations.
 */
function failedMemoryOwnerPayload() {
  return {
    ...memoryOwnerPayload(),
    contentStatus: 'unavailable',
    results: [
      {
        id: FAILED_RECORD_ID,
        memoryItemId: FAILED_RECORD_ID,
        title: FAILED_TITLE,
        clientId: CLIENT_ID,
        relevance: null,
      },
    ],
    records: [
      {
        domain: 'institutional_knowledge',
        recordId: FAILED_RECORD_ID,
        payload: {
          sourceKind: 'governed_memory',
          memoryItemId: FAILED_RECORD_ID,
          title: FAILED_TITLE,
          value: FAILED_SNIPPET,
          clientId: CLIENT_ID,
          content: { hash: 'failed-v1' },
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
    visualAnalysis?:
      | {
          available: jest.Mock;
          execute: jest.Mock;
          discard: jest.Mock;
        }
      | ApiVisualAnalysisRepo;
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
  capabilities?: () => Response;
  /**
   * The native delegated owner POST (`POST /api/clio/tools/:name`). When
   * omitted, the historical inert `{ records: [] }` is returned so every
   * existing case is unchanged. `init` is forwarded so a case can distinguish
   * two owner POSTs to the SAME tool by their request input (the real owner
   * contract never deduplicates distinct inputs).
   */
  nativeOwner?: (url: string, init?: RequestInit) => Response;
}): jest.Mock {
  return jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/clio/v3/mcp-tool-schemas')) {
      return routes.managed ? routes.managed() : jsonResponse({ schemas: [] });
    }
    if (url.includes('/api/clio/v3/mcp-tools/')) {
      return routes.owner ? routes.owner(url) : jsonResponse({ records: [] });
    }
    if (url.includes('/api/clio/v3/capabilities')) {
      return routes.capabilities ? routes.capabilities() : jsonResponse({});
    }
    if (url.includes('/api/clio/tool-schemas')) {
      return routes.native ? routes.native() : jsonResponse({ schemas: [] });
    }
    if (url.includes('/api/clio/tools/')) {
      return routes.nativeOwner ? routes.nativeOwner(url, init) : jsonResponse({ records: [] });
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

/**
 * Await until a synchronous predicate holds. The normal `.run` pipeline drives
 * the deferred native owner dispatch across several awaited microtasks, so the
 * request-path Stop/expiry fixtures poll for the actually in-flight owner call
 * before cancelling/expiring the outer parent.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

const originalFetch = global.fetch;

/**
 * Provider-free fixture signing secret for the governed request boundary.
 * IDENTICAL in value to the first-describe constant (which shadows this one);
 * not a live service secret and mints no served authority.
 */
const GOVERNED_FIXTURE_SECRET = 'governed-native-target-fixture-secret';

type GovernedRequestBinding = {
  conversationId: string;
  clientId?: string;
  messages: readonly { role?: unknown; text?: unknown }[];
};

/** The exact request binding the `.run` uses (same shape as the first describe). */
function servedGovernedBinding(dto: {
  conversationId: string;
  clientId?: string;
  messages: readonly { role?: unknown; text?: unknown }[];
}): GovernedRequestBinding {
  return {
    conversationId: dto.conversationId,
    ...(dto.clientId ? { clientId: dto.clientId } : {}),
    messages: dto.messages,
  };
}

/**
 * MAC-authenticate a SERVED governed turn with the EXISTING real
 * `attestMeriGovernedContext` / `verifyMeriGovernedContext` pair: no new
 * envelope, no weakened validator and no fabricated signature. The signature
 * binds the exact request conversation/client/messages plus the bearer
 * tenant/actor the `.run` uses — the same binding `chat.controller.ts` verifies
 * before `runWithGovernedMeriContext`. This is the common-scope form of the
 * first describe's `attestGovernedTurn` (whose full negative-binding battery
 * remains there intact and is not weakened).
 */
function attestServedGovernedTurn(
  governed: MeriGovernedTurnContext,
  binding: GovernedRequestBinding,
): MeriGovernedTurnContext {
  const withEvidence = {
    ...(governed as unknown as Record<string, unknown>),
    evidence: {
      version: 1,
      tenantId: context.tenantId,
      userId: context.userId,
      packetId: null,
      sourceRecordCount: 0,
      projectedRecordCount: 0,
      truncated: false,
      records: [],
    },
  } as unknown as MeriGovernedTurnContext;
  const attested = attestMeriGovernedContext(withEvidence, binding, GOVERNED_FIXTURE_SECRET);
  const actor = { tenantId: context.tenantId, userId: context.userId };
  expect(() =>
    verifyMeriGovernedContext(attested, binding, actor, GOVERNED_FIXTURE_SECRET),
  ).not.toThrow();
  return attested;
}

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

  // `UI_ACME` and `clientScopedNativeSchema` are declared at module scope
  // (above) because both describes use them; see the AA221 TS2304 note there.
  const AUTH_BETA = '30000000-0000-4000-8000-0000000000be';
  const CLIENT_READ = 'get_client_context';
  /**
   * Provider-free fixture signing secret for the ordinary governed request
   * boundary. Not a live service secret and mints no served authority.
   */
  const GOVERNED_FIXTURE_SECRET = 'governed-native-target-fixture-secret';

  /** A minimal, honest `get_client_context` owner receipt (no invented facts). */
  function getClientContextOwnerPayload(clientId: string) {
    return { tool: CLIENT_READ, client: { id: clientId } };
  }

  function clientSubjectTurn(): MeriGovernedTurnContext {
    return governedTurn('client', AUTH_BETA);
  }

  /**
   * The exact request binding the `.run` below uses. `clientId` is the ORIGINAL
   * DTO/interface client (Acme) — deliberately distinct from the AUTHENTICATED
   * context packet subject (Beta) that `clientSubjectTurn()` resolves.
   */
  function governedRequestBinding(dto: {
    conversationId: string;
    clientId?: string;
    messages: readonly { role?: unknown; text?: unknown }[];
  }): { conversationId: string; clientId?: string; messages: readonly { role?: unknown; text?: unknown }[] } {
    return {
      conversationId: dto.conversationId,
      ...(dto.clientId ? { clientId: dto.clientId } : {}),
      messages: dto.messages,
    };
  }

  /**
   * MAC-authenticate an ordinary governed turn with the EXISTING
   * `attestMeriGovernedContext` / `verifyMeriGovernedContext` pair (no new
   * envelope, no weakened validator). The signature binds the exact request
   * conversation/client/messages the `.run` uses; it does NOT require the
   * original UI client to equal the context-packet client, so the settled
   * Beta-vs-UI (or null-vs-Beta) distinction is represented without a
   * transported allowed-set. This is a provider-free fixture check — not live
   * issuance, production auth or served acceptance.
   */
  function attestGovernedTurn(
    governed: MeriGovernedTurnContext,
    binding: { conversationId: string; clientId?: string; messages: readonly { role?: unknown; text?: unknown }[] },
  ): MeriGovernedTurnContext {
    const withEvidence = {
      ...(governed as unknown as Record<string, unknown>),
      evidence: {
        version: 1,
        tenantId: context.tenantId,
        userId: context.userId,
        packetId: null,
        sourceRecordCount: 0,
        projectedRecordCount: 0,
        truncated: false,
        records: [],
      },
    } as unknown as MeriGovernedTurnContext;
    const attested = attestMeriGovernedContext(withEvidence, binding, GOVERNED_FIXTURE_SECRET);
    const actor = { tenantId: context.tenantId, userId: context.userId };
    // Prove the exact request binding + bearer actor agree with the fixture
    // before the real `.run`, and that every tampered dimension the existing
    // verifier binds is rejected — so the check is not a mock success.
    expect(() => verifyMeriGovernedContext(attested, binding, actor, GOVERNED_FIXTURE_SECRET)).not.toThrow();
    // Wrong actor (different user or different tenant) is rejected.
    expect(() =>
      verifyMeriGovernedContext(
        attested,
        binding,
        { tenantId: context.tenantId, userId: 'user-other' },
        GOVERNED_FIXTURE_SECRET,
      ),
    ).toThrow();
    expect(() =>
      verifyMeriGovernedContext(
        attested,
        binding,
        { tenantId: 'tenant-other', userId: context.userId },
        GOVERNED_FIXTURE_SECRET,
      ),
    ).toThrow();
    // The ORIGINAL conversation/messages are signed: tampering either is rejected.
    expect(() =>
      verifyMeriGovernedContext(
        attested,
        { ...binding, conversationId: 'tampered-thread' },
        actor,
        GOVERNED_FIXTURE_SECRET,
      ),
    ).toThrow();
    expect(() =>
      verifyMeriGovernedContext(
        attested,
        { ...binding, clientId: 'tampered-client' },
        actor,
        GOVERNED_FIXTURE_SECRET,
      ),
    ).toThrow();
    expect(() =>
      verifyMeriGovernedContext(
        attested,
        { ...binding, messages: [{ role: 'user', text: 'tampered message' }] },
        actor,
        GOVERNED_FIXTURE_SECRET,
      ),
    ).toThrow();
    // The authenticated contextPacket/subject is part of the signed content:
    // tampering its identity or resolved subject client is rejected.
    const tamperedPacket = {
      ...(attested as unknown as Record<string, unknown>),
      contextPacket: {
        ...attested.contextPacket,
        packetId: 'tampered-packet',
      },
    } as unknown as MeriGovernedTurnContext;
    expect(() =>
      verifyMeriGovernedContext(tamperedPacket, binding, actor, GOVERNED_FIXTURE_SECRET),
    ).toThrow();
    const tamperedSubject = {
      ...(attested as unknown as Record<string, unknown>),
      contextPacket: {
        ...attested.contextPacket,
        clientId: 'tampered-subject',
      },
    } as unknown as MeriGovernedTurnContext;
    expect(() =>
      verifyMeriGovernedContext(tamperedSubject, binding, actor, GOVERNED_FIXTURE_SECRET),
    ).toThrow();
    return attested;
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
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
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
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
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
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
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
      expect.objectContaining({
        tool: CLIENT_READ,
        status: 'blocked',
        detail: CROSS_CLIENT_REFUSAL,
      }),
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
        native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
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
        expect.objectContaining({
          tool: CLIENT_READ,
          status: 'blocked',
          detail: GOVERNED_NO_SINGLE_CLIENT_REFUSAL,
        }),
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
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
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

    expect(toolsOnCall(complete, 0)).toContain(CLIENT_READ);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.steps).toEqual([
      expect.objectContaining({
        tool: CLIENT_READ,
        status: 'blocked',
        detail: GOVERNED_NO_SINGLE_CLIENT_REFUSAL,
      }),
    ]);
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
    const invoke = jest.fn(
      async (..._args: Parameters<ToolRegistry['invoke']>) => ({ messages: [] }),
    );
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
    const invokeBeta = jest.fn(
      async (..._args: Parameters<ToolRegistry['invoke']>) => ({ messages: [] }),
    );
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

    expect(toolsOnCall(complete, 0)).toContain('save_memory');
    expect(invoke).not.toHaveBeenCalled();
    expect(proposal).not.toHaveBeenCalled();
    expect(result.pendingApprovals ?? []).toEqual([]);
    expect(result.steps).toEqual([
      expect.objectContaining({
        tool: 'save_memory',
        status: 'blocked',
        detail: GOVERNED_BOUND_EFFECT_REFUSAL,
      }),
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

    expect(toolsOnCall(complete, 0)).toContain('create_word');
    expect(invoke).not.toHaveBeenCalled();
    expect(proposal).not.toHaveBeenCalled();
    expect(result.artifacts ?? []).toEqual([]);
    expect(result.steps).toEqual([
      expect.objectContaining({
        tool: 'create_word',
        status: 'blocked',
        detail: GOVERNED_BOUND_EFFECT_REFUSAL,
      }),
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
      expect.objectContaining({
        tool: 'run_analysis',
        status: 'blocked',
        detail: GOVERNED_BOUND_EFFECT_REFUSAL,
      }),
    ]);
  });

  // ---------------------------------------------------------------------------
  // MAC-bound ordinary governed request boundary. Unlike the bare in-process
  // casts above (which prove only trusted dispatch), these sign the EXACT
  // conversation/client/messages binding with the existing
  // `attestMeriGovernedContext`/`verifyMeriGovernedContext` pair before the real
  // `.run`: the ORIGINAL DTO client is the interface hint (Acme) or null while
  // the AUTHENTICATED context packet resolves a different single client (Beta).
  // ---------------------------------------------------------------------------

  test('a MAC-bound governed client turn re-targets an omitted required native read to the authenticated packet client (Beta), not the UI hint (Acme)', async () => {
    const dto = {
      clientId: UI_ACME,
      conversationId: 'mac-governed-target-thread',
      toolPolicy: 'read-only' as const,
      messages: [{ role: 'user' as const, text: 'Summarize the client.' }],
    };
    const call = functionCall('mac-governed-read', CLIENT_READ, {});
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Beta profile returned.' }));
    const invoke = jest.fn(async (...args: Parameters<ToolRegistry['invoke']>) =>
      getClientContextOwnerPayload(String((args[1] as Record<string, unknown>).clientId)),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
    }) as unknown as typeof fetch;

    const governed = attestGovernedTurn(clientSubjectTurn(), governedRequestBinding(dto));
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ clientId: AUTH_BETA });
    expect((result.steps ?? []).some((step) => step.tool === CLIENT_READ && step.status === 'done')).toBe(
      true,
    );
  });

  test.each(['portfolio', 'external_entity', 'general'] as const)(
    'a MAC-bound governed %s turn refuses an omitted required-client read with the exact no-single-client receipt (no interface fallback)',
    async (subjectScope) => {
      const dto = {
        clientId: UI_ACME,
        conversationId: `mac-nofallback-${subjectScope}`,
        toolPolicy: 'read-only' as const,
        messages: [{ role: 'user' as const, text: 'Summarize the client.' }],
      };
      const call = functionCall(`mac-nofallback-${subjectScope}`, CLIENT_READ, {});
      const complete = jest
        .fn()
        .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
        .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
      const invoke = jest.fn();
      const { service } = buildManaged(complete, {
        registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
      });
      global.fetch = fetchRouter({
        native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
      }) as unknown as typeof fetch;

      const governed = attestGovernedTurn(governedTurn(subjectScope, null), governedRequestBinding(dto));
      const result: MeriV3ChatResult = await RequestCredentialsStore.run(
        { bearerToken: 'bearer' },
        () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
      );

      // The capability was advertised/admitted for the turn, so the block is the
      // scope guard — not an undeclared or policy-disabled capability.
      expect(toolsOnCall(complete, 0)).toContain(CLIENT_READ);
      expect(invoke).not.toHaveBeenCalled();
      expect(result.steps).toEqual([
        expect.objectContaining({
          tool: CLIENT_READ,
          status: 'blocked',
          detail: GOVERNED_NO_SINGLE_CLIENT_REFUSAL,
        }),
      ]);
    },
  );

  test.each(['portfolio', 'external_entity', 'general'] as const)(
    'a MAC-bound governed %s turn refuses an EXPLICIT model client filter on a read (no generic actor-ACL grant)',
    async (subjectScope) => {
      const dto = {
        clientId: UI_ACME,
        conversationId: `mac-explicit-${subjectScope}`,
        toolPolicy: 'read-only' as const,
        messages: [{ role: 'user' as const, text: 'Summarize the client.' }],
      };
      const call = functionCall(`mac-explicit-${subjectScope}`, CLIENT_READ, { clientId: UI_ACME });
      const complete = jest
        .fn()
        .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
        .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
      const invoke = jest.fn();
      const { service } = buildManaged(complete, {
        registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
      });
      global.fetch = fetchRouter({
        native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
      }) as unknown as typeof fetch;

      const governed = attestGovernedTurn(governedTurn(subjectScope, null), governedRequestBinding(dto));
      const result: MeriV3ChatResult = await RequestCredentialsStore.run(
        { bearerToken: 'bearer' },
        () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
      );

      expect(toolsOnCall(complete, 0)).toContain(CLIENT_READ);
      expect(invoke).not.toHaveBeenCalled();
      expect(result.steps).toEqual([
        expect.objectContaining({
          tool: CLIENT_READ,
          status: 'blocked',
          detail: GOVERNED_NO_SINGLE_CLIENT_REFUSAL,
        }),
      ]);
    },
  );

  test('a MAC-bound governed single-Beta turn refuses an EXPLICIT Acme read filter with the exact cross-client reason and zero owner I/O', async () => {
    const dto = {
      clientId: UI_ACME,
      conversationId: 'mac-explicit-beta-subject',
      toolPolicy: 'read-only' as const,
      messages: [{ role: 'user' as const, text: 'Summarize the client.' }],
    };
    const call = functionCall('mac-explicit-beta-read', CLIENT_READ, { clientId: UI_ACME });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Blocked.' }));
    const invoke = jest.fn();
    const { service } = buildManaged(complete, {
      registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
    }) as unknown as typeof fetch;

    const governed = attestGovernedTurn(clientSubjectTurn(), governedRequestBinding(dto));
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    expect(toolsOnCall(complete, 0)).toContain(CLIENT_READ);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.steps).toEqual([
      expect.objectContaining({
        tool: CLIENT_READ,
        status: 'blocked',
        detail: CROSS_CLIENT_REFUSAL,
      }),
    ]);
  });

  test('a MAC-bound governed single-Beta turn dispatches an EXPLICIT Beta read filter (matching control)', async () => {
    const dto = {
      clientId: UI_ACME,
      conversationId: 'mac-explicit-beta-match',
      toolPolicy: 'read-only' as const,
      messages: [{ role: 'user' as const, text: 'Summarize the client.' }],
    };
    const call = functionCall('mac-explicit-beta-match', CLIENT_READ, { clientId: AUTH_BETA });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Beta profile.' }));
    const invoke = jest.fn(async (...args: Parameters<ToolRegistry['invoke']>) =>
      getClientContextOwnerPayload(String((args[1] as Record<string, unknown>).clientId)),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: CLIENT_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
    }) as unknown as typeof fetch;

    const governed = attestGovernedTurn(clientSubjectTurn(), governedRequestBinding(dto));
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ clientId: AUTH_BETA });
    expect((result.steps ?? []).some((step) => step.tool === CLIENT_READ && step.status === 'done')).toBe(true);
  });

  test.each(['portfolio', 'general'] as const)(
    'a MAC-bound governed %s turn dispatches an omitted OPTIONAL personal read with NO injected client',
    async (subjectScope) => {
      const dto = {
        clientId: UI_ACME,
        conversationId: `mac-optional-${subjectScope}`,
        toolPolicy: 'read-only' as const,
        messages: [{ role: 'user' as const, text: 'What do we know about Kestrel?' }],
      };
      const call = functionCall(`mac-optional-${subjectScope}`, 'search_memory', { query: 'Kestrel' });
      const complete = jest
        .fn()
        .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
        .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted.' }));
      const invoke = jest.fn(
        async (..._args: Parameters<ToolRegistry['invoke']>) => memoryOwnerPayload(),
      );
      const { service } = buildManaged(complete, {
        registry: registry([{ name: 'search_memory', readOnly: true }], invoke),
      });
      global.fetch = fetchRouter({
        native: () => jsonResponse({ schemas: [clientScopedNativeSchema('search_memory')] }),
      }) as unknown as typeof fetch;

      const governed = attestGovernedTurn(governedTurn(subjectScope, null), governedRequestBinding(dto));
      const result: MeriV3ChatResult = await RequestCredentialsStore.run(
        { bearerToken: 'bearer' },
        () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
      );

      expect(toolsOnCall(complete, 0)).toContain('search_memory');
      expect(invoke).toHaveBeenCalledTimes(1);
      // The interface client (Acme) is NEVER injected into an optional actor
      // read: the model's omitted filter stays omitted.
      expect(invoke.mock.calls[0]?.[1]).toEqual({ query: 'Kestrel' });
      expect((result.steps ?? []).some((step) => step.tool === 'search_memory' && step.status === 'done')).toBe(
        true,
      );
    },
  );

  test('a MAC-bound governed client turn keeps an omitted personal mail read personal (no injected client)', async () => {
    const dto = {
      clientId: UI_ACME,
      conversationId: 'mac-mail-omitted-thread',
      toolPolicy: 'read-only' as const,
      messages: [{ role: 'user' as const, text: 'My inbox the last two weeks.' }],
    };
    const call = functionCall('mac-mail-omitted', 'list_emails', { withinDays: 14, folder: 'inbox' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Your inbox.' }));
    const invoke = jest.fn(
      async (..._args: Parameters<ToolRegistry['invoke']>) => ({ messages: [] }),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: 'list_emails', readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema('list_emails')] }),
    }) as unknown as typeof fetch;

    const governed = attestGovernedTurn(clientSubjectTurn(), governedRequestBinding(dto));
    await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ withinDays: 14, folder: 'inbox' });
  });

  test('a MAC-bound governed Beta turn refuses save_memory when the ORIGINAL conversation client is null (no truthiness hole)', async () => {
    const dto = {
      conversationId: 'mac-null-client-save',
      messages: [{ role: 'user' as const, text: 'Remember that briefs include the program office.' }],
    };
    const call = functionCall('mac-null-save', 'save_memory', {
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

    const governed = attestGovernedTurn(clientSubjectTurn(), governedRequestBinding(dto));
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    expect(toolsOnCall(complete, 0)).toContain('save_memory');
    expect(invoke).not.toHaveBeenCalled();
    expect(proposal).not.toHaveBeenCalled();
    expect(result.pendingApprovals ?? []).toEqual([]);
    expect(result.steps).toEqual([
      expect.objectContaining({
        tool: 'save_memory',
        status: 'blocked',
        detail: GOVERNED_BOUND_EFFECT_REFUSAL,
      }),
    ]);
  });

  test('a MAC-bound governed Beta turn refuses create_word when the ORIGINAL conversation client is null (no truthiness hole)', async () => {
    const dto = {
      conversationId: 'mac-null-client-create-word',
      messages: [{ role: 'user' as const, text: 'Create a Word briefing.' }],
    };
    const call = functionCall('mac-null-create-word', 'create_word', { title: 'Briefing' });
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

    const governed = attestGovernedTurn(clientSubjectTurn(), governedRequestBinding(dto));
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    expect(toolsOnCall(complete, 0)).toContain('create_word');
    expect(invoke).not.toHaveBeenCalled();
    expect(proposal).not.toHaveBeenCalled();
    expect(result.artifacts ?? []).toEqual([]);
    expect(result.steps).toEqual([
      expect.objectContaining({
        tool: 'create_word',
        status: 'blocked',
        detail: GOVERNED_BOUND_EFFECT_REFUSAL,
      }),
    ]);
  });

  test('a MAC-bound governed Beta turn runs save_memory when the conversation is bound to Beta (matching control)', async () => {
    const dto = {
      clientId: AUTH_BETA,
      conversationId: 'mac-matching-save',
      messages: [{ role: 'user' as const, text: 'Remember that briefs include the program office.' }],
    };
    const call = functionCall('mac-matching-save', 'save_memory', {
      content: 'Briefs include the program office.',
      scope: 'client',
    });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Noted.' }));
    const invoke = jest.fn();
    const proposal = jest.fn(async () => ({
      disposition: 'pending_approval' as const,
      proposal: {
        proposalId: 'proposal-1',
        reason: 'Approval required.',
        status: 'pending',
        policy: { packKey: 'pack', packVersion: '1', binding: 'memory', decisionHash: 'hash' },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        riskTier: 'low',
        policyCode: 'POLICY',
        ruleId: 'RULE',
        preview: {},
      },
    }));
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

    const governed = attestGovernedTurn(clientSubjectTurn(), governedRequestBinding(dto));
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(proposal).toHaveBeenCalledTimes(1);
    expect(result.pendingApprovals?.length).toBe(1);
    expect(
      (result.steps ?? []).some((step) => step.tool === 'save_memory' && step.status === 'pending_approval'),
    ).toBe(true);
  });

  test('a MAC-bound governed Beta turn advertises get_client_context AND create_word and refuses the server-coordinated document preflight read of the interface client (Acme) with zero wrong-target owner/proposal/artifact (real normal.run)', async () => {
    const dto = {
      clientId: UI_ACME,
      conversationId: 'mac-doc-preflight-thread',
      // NOTE: no `toolPolicy: 'read-only'` — the turn must admit BOTH actual
      // capabilities together (get_client_context read + create_word write).
      messages: [
        {
          role: 'user' as const,
          text: 'List every action item from the uploaded transcript in the client files.',
        },
      ],
    };
    // The model emits NO function call: the auxiliary dispatcher here is the
    // SERVER-coordinated document preflight (`continueDocumentReads`), which
    // projects the ORIGINAL dto.clientId (Acme) into `read_client_documents`.
    const complete = jest.fn().mockResolvedValue(providerResult({ outputText: 'I reviewed the files.' }));
    const invoke = jest.fn(
      async (..._args: Parameters<ToolRegistry['invoke']>) => ({ documents: [] }),
    );
    const proposal = jest.fn();
    const { service } = buildManaged(complete, {
      registry: registry(
        [
          { name: 'read_client_documents', readOnly: true },
          { name: CLIENT_READ, readOnly: true },
          { name: 'create_word', readOnly: false },
        ],
        invoke,
      ),
      actionProposalCreate: proposal,
    });
    const fetchMock = fetchRouter({
      native: () =>
        jsonResponse({
          schemas: [
            clientScopedNativeSchema('read_client_documents', ['clientId']),
            clientScopedNativeSchema(CLIENT_READ, ['clientId']),
            {
              name: 'create_word',
              description: 'Create a Word document.',
              input_schema: { type: 'object', properties: { title: { type: 'string' } } },
            },
          ],
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const governed = attestGovernedTurn(clientSubjectTurn(), governedRequestBinding(dto));
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    // BOTH actual capabilities were advertised/admitted together, so the block
    // below is the scope guard, not an undeclared or policy-disabled capability.
    expect(toolsOnCall(complete, 0)).toEqual(
      expect.arrayContaining([CLIENT_READ, 'create_word']),
    );
    // The server preflight actually entered its auxiliary dispatch and the
    // client-file read is refused with the exact cross-client reason.
    const docSteps = (result.steps ?? []).filter((step) => step.tool === 'read_client_documents');
    expect(docSteps.length).toBeGreaterThan(0);
    expect(docSteps[0]).toMatchObject({ status: 'blocked', detail: CROSS_CLIENT_REFUSAL });
    // Zero wrong-target owner I/O, proposal or artifact persistence, and no
    // native owner POST (/api/clio/tools/) for any document/context/artifact tool.
    expect(invoke).not.toHaveBeenCalled();
    expect(proposal).not.toHaveBeenCalled();
    expect(result.artifacts ?? []).toEqual([]);
    expect(
      fetchMock.mock.calls
        .map((entry) => String(entry[0]))
        .filter((url) => url.includes('/api/clio/tools/')),
    ).toHaveLength(0);
  });

  test('a MAC-bound governed single-Beta turn performs the SAME server-coordinated document preflight read against the authenticated target (matching positive)', async () => {
    const dto = {
      clientId: AUTH_BETA,
      conversationId: 'mac-doc-preflight-positive-thread',
      messages: [
        {
          role: 'user' as const,
          text: 'List every action item from the uploaded transcript in the client files.',
        },
      ],
    };
    const complete = jest.fn().mockResolvedValue(providerResult({ outputText: 'I reviewed the files.' }));
    const invoke = jest.fn(
      async (..._args: Parameters<ToolRegistry['invoke']>) => ({ documents: [] }),
    );
    const { service } = buildManaged(complete, {
      registry: registry(
        [
          { name: 'read_client_documents', readOnly: true },
          { name: CLIENT_READ, readOnly: true },
          { name: 'create_word', readOnly: false },
        ],
        invoke,
      ),
    });
    global.fetch = fetchRouter({
      native: () =>
        jsonResponse({
          schemas: [
            clientScopedNativeSchema('read_client_documents', ['clientId']),
            clientScopedNativeSchema(CLIENT_READ, ['clientId']),
            {
              name: 'create_word',
              description: 'Create a Word document.',
              input_schema: { type: 'object', properties: { title: { type: 'string' } } },
            },
          ],
        }),
    }) as unknown as typeof fetch;

    const governed = attestGovernedTurn(clientSubjectTurn(), governedRequestBinding(dto));
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    expect(toolsOnCall(complete, 0)).toEqual(
      expect.arrayContaining([CLIENT_READ, 'create_word']),
    );
    // The SAME preflight entry dispatched its list read against the
    // authenticated single target (Beta), never the interface selection.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ clientId: AUTH_BETA, limit: 10 });
    expect(
      (result.steps ?? []).some(
        (step) => step.tool === 'read_client_documents' && step.status === 'done',
      ),
    ).toBe(true);
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
      native: () => jsonResponse({ schemas: [clientScopedNativeSchema(CLIENT_READ, ['clientId'])] }),
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

/**
 * Lane A1 request-local catalog availability: normal `.run` coverage. These
 * enter the real managed run path with the real ApiManagedMcpRepo + native base
 * fetch, and assert the sanitized status reaches the provider instructions and
 * the final release, without fabricating consulted records.
 */
describe('MeriV3 request-local catalog availability (Lane A1 normal.run)', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('a requested connected-app failure yields a truthful limitation on the final reply', async () => {
    // Adversarial provider: it ignores the availability instruction AND prefixes
    // its own `Source note:` (a bypass attempt) while asserting the unsupported
    // consulted-record fact.
    const complete = jest.fn().mockResolvedValue(
      providerResult({
        outputText:
          'Source note: Jane Finder is a HubSpot contact. HubSpot records were consulted.',
      }),
    );
    const { service } = buildManaged(complete);

    // HubSpot's managed catalog is unreachable; native Capiro catalog is healthy.
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ error: 'upstream' }, 500),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-requested-app',
          messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
        }),
    );

    // The provider request was steered with bounded, source-specific guidance.
    const instructions = String(complete.mock.calls[0]?.[0]?.instructions ?? '');
    expect(instructions).toContain('Source availability for this request');
    expect(instructions).toContain('HubSpot');

    // The provider's unsupported consulted-record fact is ABSENT, not merely
    // disclaimed: the release does not trust provider obedience and cannot be
    // bypassed by a provider-authored `Source note:` prefix.
    expect(result.reply).not.toContain('Jane Finder is a HubSpot contact.');
    expect(result.reply).not.toContain('HubSpot records were consulted');

    // The fixed, bounded limitation is PRESENT.
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('HubSpot');
    expect(result.reply).toContain('were not consulted');

    // No fabricated citation or source record was attached for the failed app.
    expect((result.citations ?? []).some((citation) => citation.tool.includes('hubspot'))).toBe(
      false,
    );
  });

  test('an unrelated failure does not make every answer incomplete', async () => {
    const complete = jest.fn().mockResolvedValue(providerResult({ outputText: 'It is sunny.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ error: 'upstream' }, 500),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-unrelated',
          messages: [{ role: 'user', text: 'What is the weather today?' }],
        }),
    );

    const instructions = String(complete.mock.calls[0]?.[0]?.instructions ?? '');
    expect(instructions).not.toContain('Source availability for this request');
    expect(result.reply).toContain('It is sunny.');
    expect(result.reply).not.toContain('Source note:');
  });

  test('a deliberate whole-fetch skip (toolPolicy none) queries no catalog and claims no outage', async () => {
    const complete = jest.fn().mockResolvedValue(providerResult({ outputText: 'Plain reply.' }));
    const { service } = buildManaged(complete);

    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ error: 'upstream' }, 500),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-skip',
          toolPolicy: 'none',
          messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
        }),
    );

    // The forbidden whole-fetch path is a deliberate skip: no catalog GET at all.
    expect(managedSchemaGets(fetchMock)).toHaveLength(0);
    const instructions = String(complete.mock.calls[0]?.[0]?.instructions ?? '');
    expect(instructions).not.toContain('Source availability for this request');
    expect(result.reply).toContain('Plain reply.');
    expect(result.reply).not.toContain('Source note:');
  });

  test('a current owner read failure after an initially healthy catalog is fed to the released status', async () => {
    const call = functionCall('owner-read-fail', MANAGED_READ, { query: 'Jane Finder' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      // Adversarial final answer: overclaims the HubSpot read that just failed.
      .mockResolvedValue(providerResult({ outputText: 'Jane Finder is a HubSpot contact.' }));
    const { service } = buildManaged(complete);

    // The catalog stays healthy (advertised at exposure AND at the pre-I/O
    // revalidation), but the OWNER read itself fails after dispatch.
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse({ error: 'upstream' }, 500),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-owner-failure',
          messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
        }),
    );

    // The read was actually attempted at the owner.
    expect(toolsOnCall(complete, 0)).toContain(MANAGED_READ);
    expect(managedOwnerPosts(fetchMock)).toHaveLength(1);

    // The current owner failure makes the released answer truthful: the
    // unsupported fact is absent and the fixed limitation is present.
    expect(result.reply).not.toContain('Jane Finder is a HubSpot contact.');
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('HubSpot');
    expect(result.reply).toContain('were not consulted');
  });

  test('a native owner read failure after a healthy catalog reaches the second provider request', async () => {
    const call = functionCall('native-owner-fail', 'get_client_context', {});
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'The client is thriving.' }));
    // The native catalog is HEALTHY, but the actual owner read throws.
    const invoke = jest.fn(async () => {
      throw new Error('canonical client-context owner unavailable');
    });
    const { service } = buildManaged(complete, {
      registry: registry([{ name: 'get_client_context', readOnly: true }], invoke),
    });
    const fetchMock = fetchRouter({
      native: () =>
        jsonResponse({ schemas: [clientScopedNativeSchema('get_client_context', ['clientId'])] }),
      managed: () => jsonResponse({ schemas: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          clientId: UI_ACME,
          conversationId: 'availability-native-owner-failure',
          messages: [{ role: 'user', text: 'Look up our client records.' }],
        }),
    );

    // The read was actually attempted at the owner exactly once (no retry/I/O).
    expect(invoke).toHaveBeenCalledTimes(1);
    // The CURRENT failure observed after round 0 is present in the NEXT provider
    // request (fresh snapshot + fresh relevance at every provider request).
    const secondInstructions = String(complete.mock.calls[1]?.[0]?.instructions ?? '');
    expect(secondInstructions).toContain('Source availability for this request');
    expect(secondInstructions).toContain('Capiro client-record read this request needed failed');
    // The released answer is a bounded, truthful limitation, not provider prose.
    expect(result.reply).not.toContain('The client is thriving.');
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('not consulted');
  });

  test('an ordinary client question is relevant through the actual attempted read without literal records', async () => {
    const call = functionCall('ordinary-client-read', 'get_client_context', {});
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'The client is thriving.' }));
    const invoke = jest.fn(async () => {
      throw new Error('canonical client-context owner unavailable');
    });
    const { service } = buildManaged(complete, {
      registry: registry([{ name: 'get_client_context', readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () =>
        jsonResponse({ schemas: [clientScopedNativeSchema('get_client_context', ['clientId'])] }),
      managed: () => jsonResponse({ schemas: [] }),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          clientId: UI_ACME,
          conversationId: 'availability-ordinary-client',
          messages: [{ role: 'user', text: 'Summarize the account status.' }],
        }),
    );

    // The request NEVER says "client records", but the actual attempted canonical
    // client-record read made it relevant: the failure reaches the second
    // provider request and the released limitation.
    const secondInstructions = String(complete.mock.calls[1]?.[0]?.instructions ?? '');
    expect(secondInstructions).toContain('Source availability for this request');
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('not consulted');
  });

  test('a current managed read failure is relevant through the attempted metadata without an app phrase', async () => {
    const call = functionCall('managed-attempt', MANAGED_READ, { query: 'Anything' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Here is what I found.' }));
    const { service } = buildManaged(complete);
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse({ error: 'upstream' }, 500),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-managed-attempt',
          messages: [{ role: 'user', text: 'What did we last discuss with them?' }],
        }),
    );

    // The request never names HubSpot, but the actual attempted HubSpot read
    // failed, so the released limitation names it.
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('HubSpot');
    expect(result.reply).toContain('were not consulted');
  });

  test('an unavailable envelope naming only an unrelated app does not mark the requested app unavailable', async () => {
    const complete = jest.fn().mockResolvedValue(
      providerResult({ outputText: 'HubSpot is connected; no matching record was found.' }),
    );
    const { service } = buildManaged(complete);
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () =>
        jsonResponse({
          schemas: [managedSchema()],
          availability: {
            state: 'unavailable',
            complete: false,
            registryUnavailable: false,
            failures: [{ appId: 'airtable', name: 'Airtable', reason: 'unavailable' }],
          },
        }),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-unrelated-app',
          messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
        }),
    );

    const instructions = String(complete.mock.calls[0]?.[0]?.instructions ?? '');
    expect(instructions).not.toContain('Source availability for this request');
    expect(result.reply).toContain('no matching record was found');
    expect(result.reply).not.toContain('Source note:');
  });

  test('a valid authenticated seeded fact is retained with an honest additional-check limitation', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue(providerResult({ outputText: 'Here is the agreement term: 24 months.' }));
    const { service } = buildManaged(complete);
    // The native Capiro catalog is DOWN this turn, but the authorized inherited
    // document observation is already in the authenticated governed context.
    global.fetch = fetchRouter({
      native: () => jsonResponse({ error: 'native down' }, 500),
      managed: () => jsonResponse({ schemas: [] }),
    }) as unknown as typeof fetch;

    const governed = governedWith({
      inheritedDocumentEvidence: [inheritedDocumentCitation()],
    });
    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        runWithGovernedMeriContext(governed, () =>
          service.run(context, {
            conversationId: 'availability-seeded-fact',
            messages: [{ role: 'user', text: 'Look up our client records.' }],
          }),
        ),
    );

    // The authorized seed record is NOT erased and the limitation is phrased as
    // an ADDITIONAL live check, not a false "records were not consulted".
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('additional live Capiro client-record check');
    expect(result.reply).not.toContain('were not consulted');
    expect(result.reply).toContain('Term: 24 months');
    // Retained as READABLE source context with its accepted citation — never a
    // raw serialized result object, provenance field, or internal token/error.
    expect(result.reply).toContain('Master services agreement');
    expect(result.reply).toContain('[9] read_client_documents');
    expect(result.reply).not.toContain('{"');
    expect(result.reply).not.toContain('"origin"');
    expect(result.reply).not.toContain('LEAKED_OWNER_BODY');
    expect(result.reply).not.toContain('initial_context');

    // CT4: the bounded fallback returns EXACTLY the genuine supported citations
    // it rendered, with the seed's original identity/number — so the reply's
    // seeded `[9] read_client_documents` marker is backed, never dangling, even
    // though the (discarded) provider prose omitted the [9] marker.
    const seededCitation = (result.citations ?? []).find(
      (citation) => citation.tool === 'read_client_documents' && citation.n === 9,
    );
    expect(seededCitation).toMatchObject({
      n: 9,
      tool: 'read_client_documents',
      id: 'page-3',
      title: 'Master services agreement, page 3',
    });
    // Every returned citation number is actually referenced in the released
    // reply (no citation metadata for a marker the reply does not show, and no
    // marker the reply shows without metadata).
    for (const citation of result.citations ?? []) {
      expect(result.reply).toContain(`[${citation.n}]`);
    }
  });

  test('a failed owner body is not retained as a supported finding', async () => {
    const call = functionCall('owner-read-fail-body', MANAGED_READ, { query: 'Jane Finder' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Jane Finder is a HubSpot contact.' }));
    const { service } = buildManaged(complete);
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse({ error: 'LEAKED_OWNER_BODY' }, 500),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-failed-body',
          messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
        }),
    );

    expect(result.reply).toContain('Source note:');
    expect(result.reply).not.toContain('LEAKED_OWNER_BODY');
    expect(result.reply).not.toContain('Jane Finder is a HubSpot contact.');
  });

  test('an owner-supplied origin label cannot forge a supported seed finding', async () => {
    const call = functionCall('owner-origin-forge', MANAGED_READ, { query: 'Jane Finder' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Jane Finder is a HubSpot contact.' }));
    const { service } = buildManaged(complete);
    // The owner read returns a 200 wire whose body forges an ordinary provenance
    // field (`origin: 'conversation'`) next to an error body. It is NOT an
    // authenticated seed and must never be retained as a supported finding.
    global.fetch = fetchRouter({
      native: () => jsonResponse({ error: 'native down' }, 500),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () =>
        jsonResponse({
          ...managedOwnerWire('LEAKED_OWNER_BODY'),
          origin: 'conversation',
          error: 'LEAKED_OWNER_BODY',
        }),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-origin-forge',
          messages: [{ role: 'user', text: 'Look up our client records.' }],
        }),
    );

    // The request needs client records and that source is down, so the bounded
    // limitation is released...
    expect(result.reply).toContain('Source note:');
    // ...but the forged failed-owner body is never treated as a supported seed.
    expect(result.reply).not.toContain('LEAKED_OWNER_BODY');
    expect(result.reply).not.toContain('Jane Finder is a HubSpot contact.');
    expect(result.reply).not.toContain('"origin"');
    // No failed-owner citation is restored: any returned citation is genuinely
    // referenced by the released reply (no dangling marker).
    for (const citation of result.citations ?? []) {
      expect(result.reply).toContain(`[${citation.n}]`);
    }
  });

  test('a healthy completed read is retained readably next to an unreachable source', async () => {
    const call = functionCall('healthy-read', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted.' }));
    const invoke = jest.fn(async () => memoryOwnerPayload());
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      // HubSpot is named and unreachable; the completed native read still stands.
      managed: () => jsonResponse({ error: 'upstream' }, 500),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-healthy-readable',
          messages: [
            { role: 'user', text: 'Find Jane Finder in HubSpot and what do we know about Kestrel?' },
          ],
        }),
    );

    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('HubSpot');
    // The completed read is retained as a READABLE source fact — never a raw
    // serialized result object or a provenance/token/error body.
    expect(result.reply).toContain('Kestrel commitment');
    expect(result.reply).toContain(NATIVE_READ);
    expect(result.reply).not.toContain('{"');
    expect(result.reply).not.toContain('"origin"');
    expect(result.reply).not.toContain('serialized');

    // CT4: the bounded fallback returns exactly the healthy read's accepted
    // citation (original identity/number) alongside the reply, and every
    // returned citation number is referenced in the reply (no dangling marker).
    const healthyCitation = (result.citations ?? []).find(
      (citation) => citation.tool === NATIVE_READ,
    );
    expect(healthyCitation).toMatchObject({ n: 1, tool: NATIVE_READ, id: RECORD_ID });
    for (const citation of result.citations ?? []) {
      expect(result.reply).toContain(`[${citation.n}]`);
    }
  });

  test('a poem about Capiro is untouched even when every catalog is down', async () => {
    const complete = jest.fn().mockResolvedValue(providerResult({ outputText: 'Capiro, a poem.' }));
    const { service } = buildManaged(complete);
    global.fetch = fetchRouter({
      native: () => jsonResponse({ error: 'down' }, 500),
      managed: () => jsonResponse({ error: 'down' }, 500),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-poem',
          messages: [{ role: 'user', text: 'Write a poem about Capiro' }],
        }),
    );

    expect(result.reply).toContain('Capiro, a poem.');
    expect(result.reply).not.toContain('Source note:');
  });

  test('preparing for Monday is untouched even when every catalog is down', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue(providerResult({ outputText: 'Here is your Monday plan.' }));
    const { service } = buildManaged(complete);
    global.fetch = fetchRouter({
      native: () => jsonResponse({ error: 'down' }, 500),
      managed: () => jsonResponse({ error: 'down' }, 500),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'availability-monday',
          messages: [{ role: 'user', text: 'Help me prepare for Monday' }],
        }),
    );

    expect(result.reply).toContain('Here is your Monday plan.');
    expect(result.reply).not.toContain('Source note:');
  });

  test('a selected-client creative temporal question is untouched when every catalog is down', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue(providerResult({ outputText: 'Today, a small poem.' }));
    const { service } = buildManaged(complete);
    global.fetch = fetchRouter({
      native: () => jsonResponse({ error: 'down' }, 500),
      managed: () => jsonResponse({ error: 'down' }, 500),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          clientId: CLIENT_ID,
          conversationId: 'availability-selected-client-poem',
          messages: [{ role: 'user', text: 'Write a poem about today.' }],
        }),
    );

    // A client focus plus a generic temporal word ("today") is NOT proof of a
    // private-record request: the exact provider answer is retained with no
    // fabricated unavailable-record limitation.
    expect(result.reply).toContain('Today, a small poem.');
    expect(result.reply).not.toContain('Source note:');
  });

  test('an already-stopped outer parent makes zero catalog, model or owner calls (with credentials)', async () => {
    const complete = jest.fn();
    const { service } = buildManaged(complete);
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse(managedOwnerWire('should-not-run')),
      capabilities: () => jsonResponse({ visualAnalysis: { enabled: true } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort(new DOMException('Turn cancelled', 'AbortError'));

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        service.run(
          context,
          {
            conversationId: 'availability-parent-stopped',
            messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
          },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toBeDefined();

    // An already-stopped parent never starts discovery, a model call or an owner
    // read: the stopped request cannot become a benign empty/usable catalog.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  test('an already-stopped outer parent makes zero calls without credentials too', async () => {
    const complete = jest.fn();
    const { service } = buildManaged(complete);
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort(new DOMException('Turn cancelled', 'AbortError'));

    await expect(
      service.run(
        context,
        {
          conversationId: 'availability-parent-stopped-no-creds',
          messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeDefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  test('an already-expired outer parent makes zero catalog, model or owner calls', async () => {
    const complete = jest.fn();
    const { service } = buildManaged(complete);
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [managedSchema()] }),
      owner: () => jsonResponse(managedOwnerWire('should-not-run')),
      capabilities: () => jsonResponse({ visualAnalysis: { enabled: true } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        service.run(
          context,
          {
            conversationId: 'availability-parent-expired',
            messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
          },
          { deadlineAt: Date.now() - 1 },
        ),
      ),
    ).rejects.toBeDefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  test('a parent Stop during native discovery is not swallowed as an empty catalog', async () => {
    const complete = jest.fn();
    const { service } = buildManaged(complete);
    const controller = new AbortController();
    const fetchMock = fetchRouter({
      native: () => {
        controller.abort(new DOMException('Turn cancelled', 'AbortError'));
        return jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] });
      },
      managed: () => jsonResponse({ schemas: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        service.run(
          context,
          {
            conversationId: 'availability-stop-native',
            messages: [{ role: 'user', text: 'What do we know about Kestrel?' }],
          },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toBeDefined();

    // A response that resolved after Stop is not healthy evidence: no model turn
    // and no later owner read started.
    expect(complete).not.toHaveBeenCalled();
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  test('a parent Stop during managed discovery is not swallowed as an empty catalog', async () => {
    const complete = jest.fn();
    const { service } = buildManaged(complete);
    const controller = new AbortController();
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => {
        controller.abort(new DOMException('Turn cancelled', 'AbortError'));
        return jsonResponse({ schemas: [managedSchema()] });
      },
      owner: () => jsonResponse(managedOwnerWire('should-not-run')),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        service.run(
          context,
          {
            conversationId: 'availability-stop-managed',
            messages: [{ role: 'user', text: 'Find Jane Finder in HubSpot.' }],
          },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toBeDefined();

    expect(complete).not.toHaveBeenCalled();
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  test('a parent Stop during the visual capability probe is not swallowed as a usable result', async () => {
    const complete = jest.fn();
    // A REAL ApiVisualAnalysisRepo (not the default mock), so the probe's own
    // parent/child asserts are the thing under test.
    const { service } = buildManaged(complete, {
      visualAnalysis: new ApiVisualAnalysisRepo(config() as never),
    });
    const controller = new AbortController();
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [] }),
      managed: () => jsonResponse({ schemas: [] }),
      capabilities: () => {
        controller.abort(new DOMException('Turn cancelled', 'AbortError'));
        return jsonResponse({ visualAnalysis: { enabled: true } });
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        service.run(
          context,
          {
            conversationId: 'availability-stop-visual',
            messages: [{ role: 'user', text: 'Summarize the account status.' }],
          },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toBeDefined();

    expect(complete).not.toHaveBeenCalled();
    expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
  });

  test.each<[string, () => Response]>([
    ['a non-OK response', () => jsonResponse({ error: 'down' }, 500)],
    ['a malformed-body response', () => new Response('{not json', { status: 200 })],
  ])(
    'a parent Stop during native discovery is not masked by %s',
    async (_label, nativeRoute) => {
      const complete = jest.fn();
      const { service } = buildManaged(complete);
      const controller = new AbortController();
      const fetchMock = fetchRouter({
        native: () => {
          controller.abort(new DOMException('Turn cancelled', 'AbortError'));
          return nativeRoute();
        },
        managed: () => jsonResponse({ schemas: [] }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
          service.run(
            context,
            {
              conversationId: 'availability-stop-native-response',
              messages: [{ role: 'user', text: 'What do we know about Kestrel?' }],
            },
            { signal: controller.signal },
          ),
        ),
      ).rejects.toBeDefined();

      // The stopped parent propagates ahead of the benign/unavailable early
      // branch: no model turn and no later owner effect.
      expect(complete).not.toHaveBeenCalled();
      expect(managedOwnerPosts(fetchMock)).toHaveLength(0);
    },
  );

  // ── Lane A continuation: native registry owner-call post-await boundaries ──
  //
  // The native registry owner dispatch is the in-process canonical read. A Stop
  // or absolute-expiry of the outer parent WHILE that owner call is awaited must
  // not publish the late result as a current read: no availability observation,
  // no done step/event, no citation/artifact ledger and no further provider
  // round. The read was already incurred at the owner; nothing is rolled back,
  // and the deferred fixture keeps the real registered capability, current
  // authority, MeriRunBudget and ledger (only the external transport is faked).

  test('a deferred native registry owner read resolving after the outer parent stops is never published as current', async () => {
    const call = functionCall('native-deferred-stop', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [call], outputText: '', functionCalls: [call] }),
      )
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted [1].' }));
    let resolveOwner: ((value: unknown) => void) | undefined;
    const invoke = jest.fn(
      (..._args: Parameters<ToolRegistry['invoke']>) =>
        new Promise<unknown>((resolve) => {
          resolveOwner = resolve;
        }),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [] }),
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const events: MeriV3ChatStreamEvent[] = [];
    const run = RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(
        context,
        {
          conversationId: 'native-deferred-stop',
          messages: [{ role: 'user', text: 'What do we know about Kestrel?' }],
        },
        { signal: controller.signal, onEvent: (event) => events.push(event) },
      ),
    );

    // The registered native owner dispatch is actually in flight.
    await waitFor(() => invoke.mock.calls.length === 1);
    // The outer parent stops while the owner read is awaited...
    controller.abort(new DOMException('Turn cancelled', 'AbortError'));
    // ...and the already-incurred owner read now resolves.
    resolveOwner?.(memoryOwnerPayload());
    const result: MeriV3ChatResult = await run;

    // The read was dispatched exactly once and no later provider round started:
    // the late result was never fed back to the model.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(fedBackInput(complete)).not.toContain(`[Tool result from "${NATIVE_READ}"`);

    // No citation/artifact/step/done-event publication for the late read.
    expect((result.citations ?? []).some((citation) => citation.tool === NATIVE_READ)).toBe(false);
    expect(result.artifacts ?? []).toHaveLength(0);
    expect(
      (result.steps ?? []).some((step) => step.tool === NATIVE_READ && step.status === 'done'),
    ).toBe(false);
    expect(events.some((event) => event.type === 'tool_done' && event.tool === NATIVE_READ)).toBe(
      false,
    );

    // The turn ends as a cancelled partial, not a false healthy answer.
    expect(result.reply).not.toContain('Kestrel commitment noted');
    expect(result.telemetry?.partial).toBe(true);
    expect(result.telemetry?.finishReason).toBe('cancelled');
  });

  test('a deferred native registry owner read resolving after the outer parent deadline passes is never published as current', async () => {
    const call = functionCall('native-deferred-expiry', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [call], outputText: '', functionCalls: [call] }),
      )
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted [1].' }));
    let resolveOwner: ((value: unknown) => void) | undefined;
    const invoke = jest.fn(
      (..._args: Parameters<ToolRegistry['invoke']>) =>
        new Promise<unknown>((resolve) => {
          resolveOwner = resolve;
        }),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [] }),
    }) as unknown as typeof fetch;

    // The ACTUAL runtime for this request is Deep: the raw runtime log shows the
    // same request auto-escalating standard -> deep with a synthesis reserve of
    // 180000ms, so an ordinary 90s/120s deadline would never admit the gather
    // round (`remainingMs <= reserveMs` breaks before the owner dispatch). The
    // fixture therefore derives its admission window from the ACTUAL Deep profile
    // budget via the same `resolveMeriV3ReasoningProfile` the service uses and
    // requests Deep explicitly, so a distant absolute deadline is admitted. That
    // exact instant is then advanced past while the owner read is awaited —
    // exactly the wall-clock expiry the shared control checks
    // (`Date.now() >= deadlineAt`). No production budget/deadline/reserve is
    // changed; only the fixture's own deadline is made truthful.
    const deepBudgetMs = resolveMeriV3ReasoningProfile('deep').turnBudgetMs;
    const turnDeadlineAt = Date.now() + deepBudgetMs;
    const run = RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(
        context,
        {
          conversationId: 'native-deferred-expiry',
          reasoningMode: 'deep',
          messages: [{ role: 'user', text: 'What do we know about Kestrel?' }],
        },
        { deadlineAt: turnDeadlineAt },
      ),
    );

    await waitFor(() => invoke.mock.calls.length === 1);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(turnDeadlineAt + 1);
    try {
      resolveOwner?.(memoryOwnerPayload());
      const result: MeriV3ChatResult = await run;

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(fedBackInput(complete)).not.toContain(`[Tool result from "${NATIVE_READ}"`);
      expect((result.citations ?? []).some((citation) => citation.tool === NATIVE_READ)).toBe(false);
      expect(result.artifacts ?? []).toHaveLength(0);
      expect(
        (result.steps ?? []).some((step) => step.tool === NATIVE_READ && step.status === 'done'),
      ).toBe(false);
      expect(result.reply).not.toContain('Kestrel commitment noted');
      expect(result.telemetry?.partial).toBe(true);
      expect(result.telemetry?.finishReason).toBe('deadline_exceeded');
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('an active outer parent still publishes the deferred native owner read as a supported result', async () => {
    const call = functionCall('native-deferred-active', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [call], outputText: '', functionCalls: [call] }),
      )
      .mockResolvedValueOnce(providerResult({ outputText: 'Kestrel commitment noted [1].' }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted [1].' }));
    let resolveOwner: ((value: unknown) => void) | undefined;
    const invoke = jest.fn(
      (..._args: Parameters<ToolRegistry['invoke']>) =>
        new Promise<unknown>((resolve) => {
          resolveOwner = resolve;
        }),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
    });
    global.fetch = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [] }),
    }) as unknown as typeof fetch;

    const run = RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(context, {
        conversationId: 'native-deferred-active',
        messages: [{ role: 'user', text: 'What do we know about Kestrel?' }],
      }),
    );

    await waitFor(() => invoke.mock.calls.length === 1);
    resolveOwner?.(memoryOwnerPayload());
    const result: MeriV3ChatResult = await run;

    // The active parent publishes the read exactly as the synchronous green
    // control does: two provider rounds, the canonical [1] citation and the
    // supported final answer.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(fedBackInput(complete)).toContain(`[Tool result from "${NATIVE_READ}"`);
    const nativeCitation = result.citations?.find((citation) => citation.tool === NATIVE_READ);
    expect(nativeCitation).toMatchObject({ n: 1, id: RECORD_ID, tool: NATIVE_READ });
    expect(result.reply).toContain('Kestrel commitment noted');
  });

  // ── Root additions (2026-10-09): real canonical owner binding ──
  //
  // The preceding ordinary late-owner tests drive the local `registry(...)`
  // mock and its jest `invoke`; those complementary controls are preserved. The
  // cases below instead bind the REAL `InMemoryToolRegistry` to the ACTUAL
  // production owner factories: the canonical delegated `search_memory`
  // capability registered through `registerDelegatedTools` executed by the real
  // `ApiToolExecutorRepo` (`POST /api/clio/tools/:name`), and for the negative
  // `createGetClientContextTool` + `ApiClientContextRepo` (which reuses that same
  // real executor). Only the external HTTP/model transport is faked: the
  // registry, real schema validation, `DefaultScopingWrapper` scoping, the
  // admission path and the authenticated owner POST are all real. This corrects
  // the AA221 fidelity limit where two cases used a local jest handler.

  /**
   * A real MeriContext with the identity fields `DefaultScopingWrapper`
   * validates (tenant/user/clerk/role). The base `context` fixture intentionally
   * omits the clerk/role fields, so the real registry would fail-closed without
   * them.
   */
  const scopedContext = {
    ...(context as unknown as Record<string, unknown>),
    clerkUserId: 'clerk-user-1',
    role: 'member',
  } as unknown as MeriContext;

  test('a real canonical delegated search_memory read posts the exact owner request/bearer/input and publishes its citation', async () => {
    const call = functionCall('native-real-registry', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted [1].' }));
    // The ACTUAL production binding: the canonical `search_memory` catalog spec
    // (FULL_CHAT_READ_TOOLS, the same catalog `MeriRegistryService` registers)
    // registered through `registerDelegatedTools`, executed by the real
    // `ApiToolExecutorRepo` that posts to apps/api's authenticated executor.
    const executor = new ApiToolExecutorRepo(config() as never);
    const realRegistry = new InMemoryToolRegistry();
    registerDelegatedTools(
      (def) => realRegistry.register(def),
      FULL_CHAT_READ_TOOLS.filter((spec) => spec.name === NATIVE_READ),
      executor,
    );
    const { service } = buildManaged(complete, { registry: realRegistry });
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [] }),
      nativeOwner: () => jsonResponse(memoryOwnerPayload()),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(scopedContext, {
          conversationId: 'native-real-registry',
          messages: [{ role: 'user', text: 'What do we know about Kestrel?' }],
        }),
    );

    // The REAL owner POST happened exactly once at the authenticated executor
    // with the caller's bearer and the exact parsed current input — not a fake
    // local handler.
    const posts = nativeOwnerPosts(fetchMock);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(`/api/clio/tools/${NATIVE_READ}`);
    const init = nativeOwnerInit(fetchMock);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer bearer');
    expect(JSON.parse(String(init?.body))).toEqual({ query: 'Kestrel' });
    // The registered native read is published as a supported result: its
    // canonical [1] citation with its exact identity, and the supported answer.
    expect(complete).toHaveBeenCalledTimes(2);
    const citation = (result.citations ?? []).find((entry) => entry.tool === NATIVE_READ);
    expect(citation).toMatchObject({ n: 1, id: RECORD_ID, tool: NATIVE_READ });
    expect(result.reply).toContain('Kestrel commitment noted');
  });

  test('a real canonical get_client_context read fails at the authenticated owner POST and is recorded as a current failure', async () => {
    const call = functionCall('native-real-fail', 'get_client_context', {});
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'The client is thriving.' }));
    // The ACTUAL production binding: `createGetClientContextTool` over
    // `ApiClientContextRepo`, which reuses the SAME real `ApiToolExecutorRepo`
    // owner bridge that posts `POST /api/clio/tools/get_client_context`.
    const executor = new ApiToolExecutorRepo(config() as never);
    const realRegistry = new InMemoryToolRegistry();
    realRegistry.register(createGetClientContextTool(new ApiClientContextRepo(executor)));
    const { service } = buildManaged(complete, { registry: realRegistry });
    const fetchMock = fetchRouter({
      native: () =>
        jsonResponse({ schemas: [clientScopedNativeSchema('get_client_context', ['clientId'])] }),
      managed: () => jsonResponse({ schemas: [] }),
      nativeOwner: () => jsonResponse({ error: 'owner unavailable' }, 500),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(scopedContext, {
          clientId: '30000000-0000-4000-8000-0000000000ac',
          conversationId: 'native-real-fail',
          messages: [{ role: 'user', text: 'Look up our client records.' }],
        }),
    );

    // The real canonical owner read was attempted exactly once (no retry) at the
    // authenticated executor with the caller's bearer.
    const posts = nativeOwnerPosts(fetchMock);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('/api/clio/tools/get_client_context');
    expect(
      (nativeOwnerInit(fetchMock)?.headers as Record<string, string>).authorization,
    ).toBe('Bearer bearer');
    // The CURRENT owner failure reaches the next provider request and the
    // released bounded limitation, and never leaks the raw owner body.
    const secondInstructions = String(complete.mock.calls[1]?.[0]?.instructions ?? '');
    expect(secondInstructions).toContain('Source availability for this request');
    expect(secondInstructions).toContain('Capiro client-record read this request needed failed');
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('not consulted');
    expect(result.reply).not.toContain('The client is thriving.');
    expect(result.reply).not.toContain('owner unavailable');
  });

  // ── Root addition (2026-10-09): creative wording is not a record request ──
  //
  // A SELECTED-CLIENT generic creative request containing history wording
  // ("Write a poem about history.") with all catalogs down and NO actual
  // record-dependent plan or attempted read. A routing CLASS alone must not be
  // broader than an actual request for private records: a creative poem must be
  // released untouched, exactly like the temporal "poem about today" positive
  // control. The earlier `RECORD_SPECIFIC_RETRIEVAL_QUERY_CLASSES` /
  // `catalogRelevanceSignals().intentRequiresClientRecords` seam this case once
  // targeted has been REMOVED from production: relevance now rests on the real
  // evidence plan, an explicit record-phrasing request, or an actual attempted
  // canonical client-record read, so this creative poem is released as-is. The
  // assertion below is retained unchanged.
  test('a selected-client creative history poem is not treated as a private-record request', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue(providerResult({ outputText: 'A poem about history.' }));
    const { service } = buildManaged(complete);
    global.fetch = fetchRouter({
      native: () => jsonResponse({ error: 'down' }, 500),
      managed: () => jsonResponse({ error: 'down' }, 500),
    }) as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          clientId: CLIENT_ID,
          conversationId: 'availability-history-poem',
          messages: [{ role: 'user', text: 'Write a poem about history.' }],
        }),
    );

    // A client focus plus a generic creative word ("history") is NOT proof of a
    // private-record request: the exact provider answer is retained with no
    // fabricated unavailable-record limitation. (Faithful red case — see above.)
    expect(result.reply).toContain('A poem about history.');
    expect(result.reply).not.toContain('Source note:');
  });

  // ════════════════════════════════════════════════════════════════════════
  // Continuation (2026-10-09): the four missing groups from the prior report.
  //
  // (2) same-tool success/failure citation lineage, (3) native discovery
  // transport variants through normal.run, (4) optional visual child-only
  // timeout under an active parent, (1) researchRun Stop/absolute expiry during
  // the awaited replay and served-procedure authority BEFORE a NEW reservation.
  // Every case reuses the existing normal.run harness, fixtures, real registry
  // and request-local observer; only external HTTP/model transports are faked
  // and no preserved assertion is weakened.
  // ════════════════════════════════════════════════════════════════════════

  // ── (2) two calls to the SAME tool: healthy citation + failed read ──
  test('two calls to the same tool, one healthy and one failed, never restore the failed owner evidence', async () => {
    const healthy = functionCall('same-tool-healthy', NATIVE_READ, { query: 'Kestrel' });
    const failed = functionCall('same-tool-failed', NATIVE_READ, { query: 'Beta' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({
          output: [healthy, failed],
          outputText: '',
          functionCalls: [healthy, failed],
        }),
      )
      .mockResolvedValue(providerResult({ outputText: 'Both facts noted.' }));
    // The ACTUAL production binding (same as the real-registry positive near
    // 4180): the canonical `search_memory` spec registered through
    // `registerDelegatedTools` and executed by the REAL `ApiToolExecutorRepo`
    // (`POST /api/clio/tools/search_memory`). Only the external HTTP/model
    // transport is faked; the registry, real schema validation, admission path
    // and authenticated owner POST are all real. The two calls carry DISTINCT
    // inputs and are never deduplicated.
    const executor = new ApiToolExecutorRepo(config() as never);
    const realRegistry = new InMemoryToolRegistry();
    registerDelegatedTools(
      (def) => realRegistry.register(def),
      FULL_CHAT_READ_TOOLS.filter((spec) => spec.name === NATIVE_READ),
      executor,
    );
    const { service } = buildManaged(complete, { registry: realRegistry });
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [] }),
      nativeOwner: (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query?: unknown };
        // The failed logical owner result carries a DISTINCT owner-shaped
        // citable record through the SAME normal.run ledger/extraction path, so
        // a tool-name-only restoration would have something to wrongly restore.
        return body.query === 'Beta'
          ? jsonResponse(failedMemoryOwnerPayload())
          : jsonResponse(memoryOwnerPayload());
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(scopedContext, {
          conversationId: 'same-tool-lineage',
          messages: [
            {
              role: 'user',
              text: 'Check our institutional knowledge for the Kestrel and Beta facts.',
            },
          ],
        }),
    );

    // Both distinct calls really dispatched at the authenticated owner POST.
    const ownerBodies = fetchMock.mock.calls
      .filter((candidate) => String(candidate[0]).includes('/api/clio/tools/'))
      .map((candidate) => JSON.parse(String((candidate[1] as RequestInit | undefined)?.body ?? '{}')));
    expect(ownerBodies).toHaveLength(2);
    expect(ownerBodies.map((body) => (body as { query?: unknown }).query).sort()).toEqual([
      'Beta',
      'Kestrel',
    ]);
    // The failed read makes the requested records unavailable, so the bounded
    // fallback runs and retains the healthy read's accepted citation with its
    // ORIGINAL identity; the failed owner's distinct record is never restored
    // merely because another call in the same turn used the same tool name.
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('Kestrel commitment');
    const citations = result.citations ?? [];
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ n: 1, tool: NATIVE_READ, id: RECORD_ID });
    for (const citation of citations) expect(result.reply).toContain(`[${citation.n}]`);
    expect(result.reply).not.toContain(FAILED_TITLE);
    expect(result.reply).not.toContain(FAILED_SNIPPET);
    expect(result.reply).not.toContain(FAILED_RECORD_ID);
    expect(citations.some((citation) => citation.id === FAILED_RECORD_ID)).toBe(false);
  });

  // ── (2b) SAME source id, LATER unavailable ──
  test('a later UNAVAILABLE read sharing the SAME source id never overwrites the healthy bound citation', async () => {
    const healthy = functionCall('same-id-healthy', NATIVE_READ, { query: 'Kestrel' });
    const failed = functionCall('same-id-failed', NATIVE_READ, { query: 'Beta' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({ output: [healthy, failed], outputText: '', functionCalls: [healthy, failed] }),
      )
      .mockResolvedValue(providerResult({ outputText: 'Both facts noted.' }));
    // The later read is CLASSIFIED UNAVAILABLE yet carries the SAME source id as
    // the healthy read. A global citation array keyed by tool+id is OVERWRITTEN by
    // this unavailable object, so the bounded release must resolve the healthy
    // call's concrete bound object — never that overwritten global slot.
    const sameIdUnavailable = {
      ...memoryOwnerPayload(),
      contentStatus: 'unavailable',
      results: [
        {
          id: RECORD_ID,
          memoryItemId: RECORD_ID,
          title: FAILED_TITLE,
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
            title: FAILED_TITLE,
            value: FAILED_SNIPPET,
            clientId: CLIENT_ID,
            content: { hash: 'revoked-same-id' },
          },
        },
      ],
    };
    const executor = new ApiToolExecutorRepo(config() as never);
    const realRegistry = new InMemoryToolRegistry();
    registerDelegatedTools(
      (def) => realRegistry.register(def),
      FULL_CHAT_READ_TOOLS.filter((spec) => spec.name === NATIVE_READ),
      executor,
    );
    const { service } = buildManaged(complete, { registry: realRegistry });
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      managed: () => jsonResponse({ schemas: [] }),
      nativeOwner: (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query?: unknown };
        return body.query === 'Beta'
          ? jsonResponse(sameIdUnavailable)
          : jsonResponse(memoryOwnerPayload());
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(scopedContext, {
          conversationId: 'same-id-lineage',
          messages: [
            {
              role: 'user',
              text: 'Check our institutional knowledge for the Kestrel and Beta facts.',
            },
          ],
        }),
    );

    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('Kestrel commitment');
    expect(result.reply).not.toContain(FAILED_TITLE);
    expect(result.reply).not.toContain(FAILED_SNIPPET);
    const citations = result.citations ?? [];
    expect(citations).toHaveLength(1);
    // The SAME n/id, but the HEALTHY concrete object (title) — not the overwritten
    // global slot that now holds the unavailable object with the same id.
    expect(citations[0]).toMatchObject({
      n: 1,
      tool: NATIVE_READ,
      id: RECORD_ID,
      title: 'Kestrel commitment',
    });
    expect(citations[0]?.title).not.toBe(FAILED_TITLE);
    expect(result.reply).toContain('[1]');
  });

  // ── (2c) SAME existing numbered identity, TWO SUPPORTED invocations ──
  test('two SUPPORTED invocations reusing the SAME source identity release exactly ONE marker with the LATEST concrete metadata under an unrelated requested-source outage', async () => {
    const first = functionCall('same-identity-first', NATIVE_READ, { query: 'Kestrel' });
    const second = functionCall('same-identity-second', NATIVE_READ, { query: 'Falcon' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        providerResult({
          output: [first, second],
          outputText: '',
          functionCalls: [first, second],
        }),
      )
      .mockResolvedValue(providerResult({ outputText: 'Both facts noted [1].' }));
    // Two DISTINCT inputs, both really dispatched at the authenticated owner POST
    // (the real canonical `search_memory` binding). Both return the SAME governed
    // memory source id but with DIFFERENT healthy titles/snippets:
    // `numberMeriEvidenceCitations` reuses the first identity's number for the
    // second and returns a NEW `{...source, n: prior.n}` object, so the two
    // accepted objects share one number while carrying conflicting metadata. An
    // UNRELATED requested HubSpot managed catalog outage (named app, no valid
    // envelope — a whole-source hard failure) triggers the bounded fallback,
    // which must release exactly ONE marker for that existing identity with the
    // LATEST supported concrete metadata. Existing controls are preserved: the
    // UNAVAILABLE-same-id and different-id isolation cases above are untouched.
    const secondTitle = 'Falcon follow-up';
    const secondSnippet = 'Falcon owner follow-up fact';
    const sameIdentityLaterPayload = {
      ...memoryOwnerPayload(),
      results: [
        {
          id: RECORD_ID,
          memoryItemId: RECORD_ID,
          title: secondTitle,
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
            title: secondTitle,
            value: secondSnippet,
            clientId: CLIENT_ID,
            content: { hash: 'falcon-v1' },
          },
        },
      ],
    };
    const executor = new ApiToolExecutorRepo(config() as never);
    const realRegistry = new InMemoryToolRegistry();
    registerDelegatedTools(
      (def) => realRegistry.register(def),
      FULL_CHAT_READ_TOOLS.filter((spec) => spec.name === NATIVE_READ),
      executor,
    );
    const { service } = buildManaged(complete, { registry: realRegistry });
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] }),
      // The request named HubSpot (an unrelated requested app): a whole
      // managed-source outage with no valid envelope.
      managed: () => jsonResponse({ error: 'down' }, 500),
      nativeOwner: (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query?: unknown };
        return body.query === 'Falcon'
          ? jsonResponse(sameIdentityLaterPayload)
          : jsonResponse(memoryOwnerPayload());
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(scopedContext, {
          conversationId: 'same-identity-duplicate',
          messages: [
            {
              role: 'user',
              text: 'Check our institutional knowledge for the Kestrel and Falcon facts and pull the HubSpot deals.',
            },
          ],
        }),
    );

    // Both real owner POSTs executed at the authenticated executor (distinct
    // inputs are never deduplicated).
    const ownerBodies = fetchMock.mock.calls
      .filter((candidate) => String(candidate[0]).includes('/api/clio/tools/'))
      .map((candidate) =>
        JSON.parse(String((candidate[1] as RequestInit | undefined)?.body ?? '{}')),
      );
    expect(ownerBodies).toHaveLength(2);
    expect(ownerBodies.map((body) => (body as { query?: unknown }).query).sort()).toEqual([
      'Falcon',
      'Kestrel',
    ]);
    // The unrelated requested HubSpot outage triggered the bounded fallback with
    // its fixed source limitation preserved alongside the retained findings.
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('HubSpot');
    expect(result.reply).toContain('not consulted');
    // Exactly ONE unambiguous marker/metadata for the ONE existing identity — the
    // LATEST supported concrete object: not a duplicated marker, not the stale
    // earlier title, not a conflicting earlier snippet.
    expect(result.reply.match(/\[1\]/g) ?? []).toHaveLength(1);
    expect(result.reply).toContain(secondTitle);
    expect(result.reply).not.toContain('Kestrel commitment');
    const citations = result.citations ?? [];
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ n: 1, tool: NATIVE_READ, id: RECORD_ID });
    expect(citations[0]?.title).toBe(secondTitle);
  });

  // ── (3) native discovery transport variants through normal.run ──
  test.each<[string, () => Response]>([
    ['401 auth denial', () => jsonResponse({ error: 'unauthorized' }, 401)],
    ['403 auth denial', () => jsonResponse({ error: 'forbidden' }, 403)],
    ['invalid-JSON body', () => new Response('{not json', { status: 200 })],
    ['malformed envelope', () => jsonResponse({ schemas: 'not-an-array' })],
  ])(
    'a native discovery %s is sanitized to the bounded limitation with no retry or raw error text',
    async (_label, nativeRoute) => {
      const complete = jest
        .fn()
        .mockResolvedValue(providerResult({ outputText: 'Here is what I found.' }));
      const { service } = buildManaged(complete);
      const fetchMock = fetchRouter({
        native: nativeRoute,
        managed: () => jsonResponse({ schemas: [] }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result: MeriV3ChatResult = await RequestCredentialsStore.run(
        { bearerToken: 'bearer' },
        () =>
          service.run(context, {
            conversationId: 'native-discovery-variant',
            messages: [{ role: 'user', text: 'Look up our client records.' }],
          }),
      );

      // Exactly one native discovery attempt: a native failure is never retried.
      expect(nativeSchemaGets(fetchMock)).toHaveLength(1);
      const instructions = String(complete.mock.calls[0]?.[0]?.instructions ?? '');
      expect(instructions).toContain('Source availability for this request');
      expect(instructions).not.toContain('HTTP ');
      // The provider prose is discarded and the released reply is the fixed,
      // source-specific limitation with no raw transport/status/body text.
      expect(result.reply).toContain('Source note:');
      expect(result.reply).toContain('were not consulted');
      expect(result.reply).not.toContain('Here is what I found.');
      expect(result.reply).not.toContain('HTTP ');
      expect(result.reply).not.toContain('unauthorized');
      expect(result.reply).not.toContain('forbidden');
      expect(result.reply).not.toContain('{not json');
      expect(result.reply).not.toContain('not-an-array');
    },
  );

  test('a native discovery network failure is sanitized to the bounded limitation with no retry or raw transport text', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue(providerResult({ outputText: 'Here is what I found.' }));
    const { service } = buildManaged(complete);
    const fetchMock = fetchRouter({
      native: () => {
        throw new TypeError('native discovery transport refused');
      },
      managed: () => jsonResponse({ schemas: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'native-discovery-network',
          messages: [{ role: 'user', text: 'Look up our client records.' }],
        }),
    );

    expect(nativeSchemaGets(fetchMock)).toHaveLength(1);
    expect(result.reply).toContain('Source note:');
    expect(result.reply).toContain('were not consulted');
    expect(result.reply).not.toContain('Here is what I found.');
    expect(result.reply).not.toContain('transport refused');
  });

  test('an unrelated request is not made incomplete by a native discovery auth denial', async () => {
    const complete = jest.fn().mockResolvedValue(providerResult({ outputText: 'It is sunny.' }));
    const { service } = buildManaged(complete);
    const fetchMock = fetchRouter({
      native: () => jsonResponse({ error: 'unauthorized' }, 401),
      managed: () => jsonResponse({ schemas: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(context, {
          conversationId: 'native-discovery-unrelated',
          messages: [{ role: 'user', text: 'What is the weather today?' }],
        }),
    );

    const instructions = String(complete.mock.calls[0]?.[0]?.instructions ?? '');
    expect(instructions).not.toContain('Source availability for this request');
    expect(result.reply).toContain('It is sunny.');
    expect(result.reply).not.toContain('Source note:');
  });

  // ── (4) optional visual-probe child-only timeout under an active parent ──
  test('an optional visual-probe child-only timeout under an active parent permits chat without analysis and restores its timers', async () => {
    const parent = new AbortController();
    let childAborted = false;
    let probeCalls = 0;
    const complete = jest
      .fn()
      .mockResolvedValue(providerResult({ outputText: 'Account status: healthy.' }));
    const { service } = buildManaged(complete, {
      // A small optional-probe bound so the CHILD times out while the parent
      // (180s Standard turn budget) stays active.
      configValues: { MERIV2_TOOL_TIMEOUT_MS: '25', INTERNAL_SERVICE_SECRET: 'service-secret' },
      visualAnalysis: new ApiVisualAnalysisRepo(
        config({ MERIV2_TOOL_TIMEOUT_MS: '25' }) as never,
      ),
    });
    global.fetch = jest.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/clio/v3/mcp-tool-schemas')) {
        return Promise.resolve(jsonResponse({ schemas: [] }));
      }
      if (url.includes('/api/clio/tool-schemas')) {
        return Promise.resolve(jsonResponse({ schemas: [] }));
      }
      if (url.includes('/api/clio/v3/capabilities')) {
        probeCalls += 1;
        // Pending until the bounded CHILD timer aborts it; the parent is never
        // aborted, so this is a child-only timeout.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            childAborted = true;
            reject((init.signal as AbortSignal).reason);
          });
        });
      }
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;

    // Observe the ACTUAL scoped child-timer lifecycle instead of a vacuous
    // zero-count under real timers. The optional visual probe builds a child
    // execution control with its OWN bounded 25ms timer
    // (ApiVisualAnalysisRepo.available -> createMeriExecutionControl(control, 25)),
    // whose dispose() clears the timer. The parent (180s turn budget) is a
    // different, larger bound and is never advanced.
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(
          context,
          {
            conversationId: 'visual-child-timeout',
            messages: [{ role: 'user', text: 'Summarize the account status.' }],
          },
          { signal: parent.signal },
        ),
    );

    // Only the bounded child probe timed out: the parent was never stopped, the
    // ordinary chat proceeded, and no analysis capability was advertised.
    expect(probeCalls).toBe(1);
    expect(childAborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(toolsOnCall(complete, 0)).not.toContain('run_analysis');
    expect(result.reply).toContain('Account status: healthy.');
    // The bounded child's scoped timer was actually CREATED and then DISPOSED
    // (clearTimeout) when the probe settled and its execution control released.
    // The child bound derives from MERIV2_TOOL_TIMEOUT_MS=25 (`Math.max(0,
    // deadlineAt - Date.now())`), so its delay can round to 24-25ms; select the
    // small scoped timers (< 100ms) — the turn/provider bounds are far larger.
    const childTimers = setTimeoutSpy.mock.results
      .map((result, index) => ({
        delay: setTimeoutSpy.mock.calls[index]?.[1],
        timer: result.value as unknown,
      }))
      .filter((entry) => typeof entry.delay === 'number' && entry.delay < 100);
    expect(childTimers.length).toBeGreaterThan(0);
    for (const entry of childTimers) {
      expect(clearTimeoutSpy).toHaveBeenCalledWith(entry.timer);
    }
  });

  // ── (1) researchRun Stop/absolute expiry BEFORE a NEW reservation ──
  //
  // The research tool-dispatch branch (meriv3-assistant.service.ts ~4310-4515)
  // awaits a durable replay, then the served-procedure authority, BEFORE opening
  // the NEW safe-read reservation and the owner dispatch. A Stop or absolute
  // expiry during either await must leave the ORIGINAL parent stopped so no
  // reservation and no owner read start; an already-incurred read's
  // outcome/failure settlement is ATTEMPTED even though its publication is
  // withheld for a no-longer-current turn. NOTE (transport fidelity): the mocks
  // below ignore `init.signal`, so they prove an ATTEMPTED accounting, not a
  // confirmed durable receipt. A real transport honoring the aborted parent
  // rejects the settlement POST before a receipt (see the abort-aware transport
  // case below); only the external HTTP/model and owner transports are faked,
  // while the branch, budget and registry are real.

  /** An admitted research execution envelope bound to one request conversation. */
  function researchRunBinding(conversationId: string) {
    const researchRun = { sessionId: 'session-a', runId: 'run-a', leaseEpoch: 3 };
    return {
      researchRun,
      researchPlanExecution: createMeriResearchPlanExecutionEnvelope({
        plan: { version: 1, title: 'Admitted request-path plan', steps: [] },
        scope: {
          ...researchRun,
          tenantId: 'tenant-1',
          actorId: 'user-1',
          clientId: null,
          conversationId,
        },
        allowedReadCapabilities: [NATIVE_READ],
      }),
    };
  }

  /** A served governed procedure that admits only the native read. */
  function researchProcedureContext(): MeriGovernedTurnContext {
    const now = Date.now();
    const base = governedTurn('general', null) as unknown as Record<string, unknown>;
    return {
      ...base,
      procedure: {
        version: 1,
        tenantId: 'tenant-1',
        identity: {
          source: 'firm',
          recordId: 'procedure-row-1',
          canonicalId: 'memory_audit',
          version: 6,
        },
        manifestDigest: 'a'.repeat(64),
        instruction: 'Run the signed institutional-memory audit.',
        scope: 'general',
        clientId: null,
        clientRequired: false,
        resolvedAt: now,
        validUntil: now + 60_000,
        policy: {
          effectMode: 'read_only',
          allowedCapabilities: ['memory.read'],
          allowedTools: [NATIVE_READ],
          requiredTools: [NATIVE_READ],
        },
        contract: {
          outputFields: ['auditStatus'],
          completionChecks: ['Report source coverage'],
          coverageStates: ['checked', 'unavailable'],
          caseIds: ['CD-01'],
        },
      },
    } as unknown as MeriGovernedTurnContext;
  }

  function researchProcedureDecision(governed: MeriGovernedTurnContext): Response {
    const procedure = governed.procedure!;
    return jsonResponse({
      authorized: true,
      identity: procedure.identity,
      manifestDigest: procedure.manifestDigest,
    });
  }

  /**
   * A research-run HTTP router. It remembers the replay's `toolVersion` and
   * echoes it on the reservation/outcome so the branch's version equality holds.
   */
  function researchFetch(hooks: {
    onReplay?: (init: RequestInit) => Response;
    onValidate?: (init: RequestInit) => Response;
  } = {}): jest.Mock {
    let toolVersion = '';
    return jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/clio/v3/mcp-tool-schemas')) return jsonResponse({ schemas: [] });
      if (url.includes('/api/clio/v3/capabilities')) return jsonResponse({});
      if (url.includes('/api/clio/tool-schemas')) {
        return jsonResponse({ schemas: [nativeSchema(NATIVE_READ)] });
      }
      if (url.endsWith('/active')) return jsonResponse({ active: true });
      if (url.includes('/provider-budget/reservations')) {
        return jsonResponse({
          reservationId: 'provider-reservation',
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          dispatchAllowed: true,
        });
      }
      if (url.includes('/provider-budget/settlements')) return jsonResponse({});
      if (url.endsWith('/safe-read/replay')) {
        toolVersion = String(JSON.parse(String(init?.body)).toolVersion ?? '');
        return hooks.onReplay
          ? hooks.onReplay(init ?? {})
          : jsonResponse({ replayed: false, dispatchAllowed: true });
      }
      if (url.endsWith('/safe-read/reservations')) {
        return jsonResponse({
          dispatchAllowed: true,
          reservationId: 'reservation-a',
          tool: NATIVE_READ,
          toolVersion,
        });
      }
      if (url.endsWith('/safe-read/failures')) {
        return jsonResponse({ outcome: 'retryable_failure' });
      }
      if (url.endsWith('/safe-read/outcomes')) {
        return jsonResponse({
          executionId: 'execution-a',
          providerCallId: 'provider-call-a',
          tool: NATIVE_READ,
          toolVersion,
          classifier: 'complete',
          sequence: 1,
          receiptId: 'receipt-a',
        });
      }
      if (url.includes('/api/clio/procedure-runtime/validate')) {
        return hooks.onValidate ? hooks.onValidate(init ?? {}) : jsonResponse({});
      }
      return jsonResponse({});
    }) as jest.Mock;
  }

  /** Count research-lifecycle requests by exact path suffix. */
  function researchRequestCount(fetchMock: jest.Mock, suffix: string): number {
    return fetchMock.mock.calls.filter((candidate) => String(candidate[0]).endsWith(suffix)).length;
  }

  /**
   * The ORDERED tags of the research lifecycle requests actually issued, so a
   * case can prove the awaited replay/current-authority boundaries were really
   * reached (and in which order) rather than passing on an earlier refusal.
   */
  function researchLifecycleOrder(fetchMock: jest.Mock): string[] {
    // The inner map is explicitly typed `string | null` so the guard predicate
    // narrows that inferred element type to `string`; without the annotation the
    // literal-object union it infers is not assignable to the declared return
    // type and the `tag is string` predicate's parameter type disagrees (the
    // exact TS2322/TS2677 the check receipt recorded). No cast/assertion is used.
    return fetchMock.mock.calls
      .map((candidate) => String(candidate[0]))
      .map((url): string | null =>
        url.endsWith('/safe-read/replay')
          ? 'replay'
          : url.includes('/procedure-runtime/validate')
            ? 'validate'
            : url.endsWith('/safe-read/reservations')
              ? 'reserve'
              : url.endsWith('/safe-read/outcomes')
                ? 'outcome'
                : url.endsWith('/safe-read/failures')
                  ? 'failure'
                  : null,
      )
      .filter((tag): tag is string => tag !== null);
  }

  test('a researchRun Stop during the awaited durable replay settles no new reservation and dispatches no owner read', async () => {
    const call = functionCall('research-stop-replay', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel noted.' }));
    const invoke = jest.fn(async () => memoryOwnerPayload());
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });
    const controller = new AbortController();
    const fetchMock = researchFetch({
      onReplay: () => {
        controller.abort(new DOMException('Turn cancelled', 'AbortError'));
        return jsonResponse({ replayed: false, dispatchAllowed: true });
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        service.run(
          context,
          {
            ...researchRunBinding('research-stop-replay'),
            conversationId: 'research-stop-replay',
            toolPolicy: 'read-only',
            messages: [{ role: 'user', text: 'Research the Kestrel commitment.' }],
          },
          { signal: controller.signal },
        ),
    );

    const reservationRequests = fetchMock.mock.calls.filter((candidate) =>
      String(candidate[0]).endsWith('/safe-read/reservations'),
    ).length;
    expect(reservationRequests).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.telemetry?.partial).toBe(true);
    expect(result.telemetry?.finishReason).toBe('cancelled');
    // The awaited durable replay was actually REACHED (not refused earlier) and
    // only then did the Stop land — before any validate/reservation/owner work.
    expect(researchRequestCount(fetchMock, '/safe-read/replay')).toBe(1);
    expect(researchLifecycleOrder(fetchMock)).toEqual(['replay']);
  });

  test('a researchRun absolute expiry during the awaited durable replay settles no new reservation and dispatches no owner read', async () => {
    const call = functionCall('research-expiry-replay', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel noted.' }));
    const invoke = jest.fn(async () => memoryOwnerPayload());
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });
    const turnDeadlineAt = Date.now() + 120_000;
    let nowSpy: jest.SpyInstance<number, []> | undefined;
    const fetchMock = researchFetch({
      onReplay: () => {
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(turnDeadlineAt + 1);
        return jsonResponse({ replayed: false, dispatchAllowed: true });
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result: MeriV3ChatResult = await RequestCredentialsStore.run(
        { bearerToken: 'bearer' },
        () =>
          service.run(
            context,
            {
              ...researchRunBinding('research-expiry-replay'),
              conversationId: 'research-expiry-replay',
              toolPolicy: 'read-only',
              messages: [{ role: 'user', text: 'Research the Kestrel commitment.' }],
            },
            { deadlineAt: turnDeadlineAt },
          ),
      );
      const reservationRequests = fetchMock.mock.calls.filter((candidate) =>
        String(candidate[0]).endsWith('/safe-read/reservations'),
      ).length;
      expect(reservationRequests).toBe(0);
      expect(invoke).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(1);
      expect(result.telemetry?.partial).toBe(true);
      expect(result.telemetry?.finishReason).toBe('deadline_exceeded');
      // The awaited durable replay was actually reached; only then did the
      // absolute expiry land, before any validate/reservation/owner work.
      expect(researchRequestCount(fetchMock, '/safe-read/replay')).toBe(1);
      expect(researchLifecycleOrder(fetchMock)).toEqual(['replay']);
    } finally {
      nowSpy?.mockRestore();
    }
  });

  test('a researchRun Stop during the awaited served-procedure authority check settles no new reservation or owner read', async () => {
    const call = functionCall('research-stop-procedure', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel noted.' }));
    const invoke = jest.fn(async () => memoryOwnerPayload());
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });
    const dto = {
      ...researchRunBinding('research-stop-procedure'),
      conversationId: 'research-stop-procedure',
      toolPolicy: 'read-only' as const,
      messages: [{ role: 'user' as const, text: 'Research the Kestrel commitment.' }],
    };
    // A genuinely MAC-authenticated served-procedure turn bound to the exact
    // request conversation/messages/actor the `.run` uses (the same binding
    // `chat.controller.ts` verifies before `runWithGovernedMeriContext`).
    const governed = attestServedGovernedTurn(
      researchProcedureContext(),
      servedGovernedBinding(dto),
    );
    const controller = new AbortController();
    let validateCalls = 0;
    const fetchMock = researchFetch({
      onValidate: () => {
        validateCalls += 1;
        controller.abort(new DOMException('Turn cancelled', 'AbortError'));
        return researchProcedureDecision(governed);
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        runWithGovernedMeriContext(governed, () =>
          service.run(context, dto, { signal: controller.signal }),
        ),
    );

    expect(validateCalls).toBe(1);
    const reservationRequests = fetchMock.mock.calls.filter((candidate) =>
      String(candidate[0]).endsWith('/safe-read/reservations'),
    ).length;
    expect(reservationRequests).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.telemetry?.partial).toBe(true);
    expect(result.telemetry?.finishReason).toBe('cancelled');
    // The cancellation landed AFTER the awaited durable replay and DURING the
    // current-authority validate — never during an earlier selection probe and
    // never before the replay.
    expect(researchRequestCount(fetchMock, '/safe-read/replay')).toBe(1);
    expect(researchLifecycleOrder(fetchMock)).toEqual(['replay', 'validate']);
  });

  test('a researchRun absolute expiry during the awaited served-procedure authority check settles no new reservation or owner read', async () => {
    const call = functionCall('research-expiry-procedure', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel noted.' }));
    const invoke = jest.fn(async () => memoryOwnerPayload());
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });
    const dto = {
      ...researchRunBinding('research-expiry-procedure'),
      conversationId: 'research-expiry-procedure',
      toolPolicy: 'read-only' as const,
      messages: [{ role: 'user' as const, text: 'Research the Kestrel commitment.' }],
    };
    const governed = attestServedGovernedTurn(
      researchProcedureContext(),
      servedGovernedBinding(dto),
    );
    const turnDeadlineAt = Date.now() + 120_000;
    let nowSpy: jest.SpyInstance<number, []> | undefined;
    let validateCalls = 0;
    const fetchMock = researchFetch({
      onValidate: () => {
        validateCalls += 1;
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(turnDeadlineAt + 1);
        return researchProcedureDecision(governed);
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result: MeriV3ChatResult = await RequestCredentialsStore.run(
        { bearerToken: 'bearer' },
        () =>
          runWithGovernedMeriContext(governed, () =>
            service.run(context, dto, { deadlineAt: turnDeadlineAt }),
          ),
      );
      expect(validateCalls).toBe(1);
      expect(invoke).not.toHaveBeenCalled();
      expect(result.telemetry?.partial).toBe(true);
      expect(result.telemetry?.finishReason).toBe('deadline_exceeded');
      // The durable replay was reached BEFORE the current-authority validate;
      // the expiry landed during that validate, not an earlier probe.
      expect(researchRequestCount(fetchMock, '/safe-read/replay')).toBe(1);
      expect(researchLifecycleOrder(fetchMock)).toEqual(['replay', 'validate']);
    } finally {
      nowSpy?.mockRestore();
    }
  });

  test('a researchRun Stop during the owner dispatch still settles the incurred complete outcome before withholding publication', async () => {
    const call = functionCall('research-outcome-stop', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted [1].' }));
    let resolveOwner: ((value: unknown) => void) | undefined;
    const invoke = jest.fn(
      (..._args: Parameters<ToolRegistry['invoke']>) =>
        new Promise<unknown>((resolve) => {
          resolveOwner = resolve;
        }),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });
    const controller = new AbortController();
    const fetchMock = researchFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(
        context,
        {
          ...researchRunBinding('research-outcome-stop'),
          conversationId: 'research-outcome-stop',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: 'Research the Kestrel commitment.' }],
        },
        { signal: controller.signal },
      ),
    );

    await waitFor(() => invoke.mock.calls.length === 1);
    controller.abort(new DOMException('Turn cancelled', 'AbortError'));
    resolveOwner?.(memoryOwnerPayload());
    const result: MeriV3ChatResult = await run;

    const outcomeRequests = fetchMock.mock.calls.filter((candidate) =>
      String(candidate[0]).endsWith('/safe-read/outcomes'),
    ).length;
    // The already-incurred read's outcome settlement was ATTEMPTED at the
    // lifecycle owner through a permissive fixture that ignores `init.signal`
    // (an ATTEMPT/attempted-accounting receipt, not a confirmed durable commit).
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(outcomeRequests).toBe(1);
    // ...but the late read was never published as current.
    expect((result.citations ?? []).some((citation) => citation.tool === NATIVE_READ)).toBe(false);
    expect(result.reply).not.toContain('Kestrel commitment');
    expect(result.telemetry?.partial).toBe(true);
    expect(result.telemetry?.finishReason).toBe('cancelled');
  });

  test('a researchRun Stop during the owner dispatch still settles the incurred failure before withholding publication', async () => {
    const call = functionCall('research-failure-stop', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel noted.' }));
    let resolveOwner: ((value: unknown) => void) | undefined;
    const invoke = jest.fn(
      (..._args: Parameters<ToolRegistry['invoke']>) =>
        new Promise<unknown>((resolve) => {
          resolveOwner = resolve;
        }),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });
    const controller = new AbortController();
    const fetchMock = researchFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(
        context,
        {
          ...researchRunBinding('research-failure-stop'),
          conversationId: 'research-failure-stop',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: 'Research the Kestrel commitment.' }],
        },
        { signal: controller.signal },
      ),
    );

    await waitFor(() => invoke.mock.calls.length === 1);
    controller.abort(new DOMException('Turn cancelled', 'AbortError'));
    resolveOwner?.({
      tool: NATIVE_READ,
      error: 'LEAKED_FAILED_OWNER_BODY',
      coverage: { complete: false, paginationComplete: false, sources: [] },
    });
    const result: MeriV3ChatResult = await run;

    const failureRequests = fetchMock.mock.calls.filter((candidate) =>
      String(candidate[0]).endsWith('/safe-read/failures'),
    ).length;
    // The already-incurred failed read's failure settlement was ATTEMPTED at the
    // lifecycle owner through the same permissive fixture (an attempted
    // accounting, not a confirmed durable commit), but a no-longer-current turn
    // never publishes it as a current error step/finding.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(failureRequests).toBe(1);
    expect(
      (result.steps ?? []).some((step) => step.tool === NATIVE_READ && step.status === 'error'),
    ).toBe(false);
    expect(result.telemetry?.partial).toBe(true);
    expect(result.telemetry?.finishReason).toBe('cancelled');
  });

  test('an active researchRun resolves the served-procedure authority, opens exactly one reservation, dispatches the owner read once and publishes its citation', async () => {
    const call = functionCall('research-active', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel commitment noted [1].' }));
    const invoke = jest.fn(async () => memoryOwnerPayload());
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });
    const dto = {
      ...researchRunBinding('research-active'),
      conversationId: 'research-active',
      toolPolicy: 'read-only' as const,
      messages: [{ role: 'user' as const, text: 'Research the Kestrel commitment.' }],
    };
    const governed = attestServedGovernedTurn(
      researchProcedureContext(),
      servedGovernedBinding(dto),
    );
    const fetchMock = researchFetch({ onValidate: () => researchProcedureDecision(governed) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result: MeriV3ChatResult = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => runWithGovernedMeriContext(governed, () => service.run(context, dto)),
    );

    // The faithful active-parent counterpart: the whole lifecycle ran exactly
    // once, in the exact order replay -> validate -> reserve -> outcome, with no
    // failure settlement, and the read was published as a supported citation.
    expect(researchLifecycleOrder(fetchMock)).toEqual([
      'replay',
      'validate',
      'reserve',
      'outcome',
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(researchRequestCount(fetchMock, '/safe-read/failures')).toBe(0);
    expect((result.citations ?? []).some((citation) => citation.tool === NATIVE_READ)).toBe(true);
    expect(result.reply).toContain('Kestrel commitment');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test('a researchRun Stop during the owner dispatch whose failure settlement is unavailable leaves the reservation uncertain with no new reservation, retry or publication', async () => {
    const call = functionCall('research-settlement-unavailable', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel noted.' }));
    let resolveOwner: ((value: unknown) => void) | undefined;
    const invoke = jest.fn(
      (..._args: Parameters<ToolRegistry['invoke']>) =>
        new Promise<unknown>((resolve) => {
          resolveOwner = resolve;
        }),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });
    const controller = new AbortController();
    const baseFetch = researchFetch();
    const baseImpl = baseFetch.getMockImplementation()!;
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      // The lifecycle owner CANNOT durably classify the incurred failed dispatch.
      if (url.endsWith('/safe-read/failures'))
        return jsonResponse({ error: 'lifecycle unavailable' }, 503);
      return baseImpl(input, init);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(
        context,
        {
          ...researchRunBinding('research-settlement-unavailable'),
          conversationId: 'research-settlement-unavailable',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: 'Research the Kestrel commitment.' }],
        },
        { signal: controller.signal },
      ),
    );

    await waitFor(() => invoke.mock.calls.length === 1);
    controller.abort(new DOMException('Turn cancelled', 'AbortError'));
    resolveOwner?.({
      tool: NATIVE_READ,
      error: 'LEAKED_FAILED_OWNER_BODY',
      coverage: { complete: false, paginationComplete: false, sources: [] },
    });
    const result: MeriV3ChatResult = await run;

    // The read was incurred exactly once; ONE failure settlement was attempted
    // and it was UNAVAILABLE, so the reservation stays UNCERTAIN: no second
    // settlement attempt, no new reservation, no outcome receipt, no retry and no
    // publication. The unavailable accounting is never declared settled.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(researchRequestCount(fetchMock, '/safe-read/failures')).toBe(1);
    expect(researchRequestCount(fetchMock, '/safe-read/reservations')).toBe(1);
    expect(researchRequestCount(fetchMock, '/safe-read/outcomes')).toBe(0);
    expect((result.citations ?? []).some((citation) => citation.tool === NATIVE_READ)).toBe(false);
    expect(result.reply).not.toContain('Kestrel commitment');
    expect(result.reply).not.toContain('LEAKED_FAILED_OWNER_BODY');
    expect(result.telemetry?.partial).toBe(true);
    expect(result.telemetry?.finishReason).toBe('cancelled');
  });

  test('a researchRun Stop during the owner dispatch leaves the settlement UNCERTAIN when the real transport honors the aborted parent', async () => {
    const call = functionCall('research-abort-transport', NATIVE_READ, { query: 'Kestrel' });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(providerResult({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValue(providerResult({ outputText: 'Kestrel noted.' }));
    let resolveOwner: ((value: unknown) => void) | undefined;
    const invoke = jest.fn(
      (..._args: Parameters<ToolRegistry['invoke']>) =>
        new Promise<unknown>((resolve) => {
          resolveOwner = resolve;
        }),
    );
    const { service } = buildManaged(complete, {
      registry: registry([{ name: NATIVE_READ, readOnly: true }], invoke),
      configValues: { INTERNAL_SERVICE_SECRET: 'service-secret' },
    });
    const controller = new AbortController();
    const baseFetch = researchFetch();
    const baseImpl = baseFetch.getMockImplementation()!;
    // The ABORT-AWARE transport counterpart to the permissive mocks above: a real
    // fetch honors an already-aborted `init.signal` and REJECTS the settlement
    // POST before any durable server receipt. Counted separately so the case can
    // distinguish an ATTEMPTED accounting from an ACCEPTED receipt.
    let rejectedSettlements = 0;
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (
        (url.endsWith('/safe-read/outcomes') || url.endsWith('/safe-read/failures')) &&
        init?.signal?.aborted
      ) {
        rejectedSettlements += 1;
        throw new DOMException('Turn cancelled', 'AbortError');
      }
      return baseImpl(input, init);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      service.run(
        context,
        {
          ...researchRunBinding('research-abort-transport'),
          conversationId: 'research-abort-transport',
          toolPolicy: 'read-only',
          messages: [{ role: 'user', text: 'Research the Kestrel commitment.' }],
        },
        { signal: controller.signal },
      ),
    );

    await waitFor(() => invoke.mock.calls.length === 1);
    controller.abort(new DOMException('Turn cancelled', 'AbortError'));
    resolveOwner?.(memoryOwnerPayload());
    const result: MeriV3ChatResult = await run;

    // The original owner read and its ONE reservation were incurred exactly once.
    // The outcome settlement was ATTEMPTED but REJECTED at the aborted transport,
    // so NO durable outcome receipt exists; the compensating failure settlement
    // was likewise attempted and rejected. The reservation therefore remains
    // UNCERTAIN — no second reservation, no new owner read/retry and no
    // publication — and no durable-store success is invented from a rejected POST.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(researchRequestCount(fetchMock, '/safe-read/reservations')).toBe(1);
    expect(researchRequestCount(fetchMock, '/safe-read/outcomes')).toBe(1);
    expect(researchRequestCount(fetchMock, '/safe-read/failures')).toBe(1);
    expect(rejectedSettlements).toBe(2);
    // The whole lifecycle ran in the exact order, with the settlement attempt
    // only AFTER the owner read was incurred (never before the reservation).
    expect(researchLifecycleOrder(fetchMock)).toEqual(['replay', 'reserve', 'outcome', 'failure']);
    expect((result.citations ?? []).some((citation) => citation.tool === NATIVE_READ)).toBe(false);
    expect(result.reply).not.toContain('Kestrel commitment');
    expect(result.telemetry?.partial).toBe(true);
    expect(result.telemetry?.finishReason).toBe('cancelled');
  });
});
