import type { TenantContext } from '@capiro/shared';
import type {
  MeriServerReadonlyCapturePolicy,
  SignedMeriCaptureEvidenceReceipt,
} from '@capiro/meriv2-core';
import { MeriService } from './meri.service.js';
import { meriReadonlyCaptureCatalogSha256 } from './meri-server-readonly-capture.js';

jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({
  AiCredentialResolverService: class {},
}));
jest.mock('../context/context-compiler.service.js', () => ({ ContextCompilerService: class {} }));
let mockPolicy: MeriServerReadonlyCapturePolicy;
let mockReceipt: SignedMeriCaptureEvidenceReceipt | null;
jest.mock('./meri-context-plane-runtime.js', () => ({
  ...jest.requireActual('./meri-context-plane-runtime.js'),
  currentMeriServerReadonlyCapturePolicy: () => mockPolicy,
  bindCurrentMeriCaptureTurn: (turnId: string) => (mockPolicy = { ...mockPolicy, turnId }),
  setCurrentMeriCaptureEvidenceReceipt: (receipt: SignedMeriCaptureEvidenceReceipt) => {
    mockReceipt = receipt;
  },
  currentMeriCaptureEvidenceReceipt: () => mockReceipt,
}));
// These are fixture authority/persistence ports. The existing readonly-capture suite
// independently exercises their real tenant and revocation barriers.
jest.mock('./meri-server-readonly-capture.js', () => ({
  ...jest.requireActual('./meri-server-readonly-capture.js'),
  assertMeriServerReadonlyCaptureCurrentAuthority: jest.fn(async () => undefined),
  createMeriServerReadonlyCaptureOutputFence: ({
    destination,
  }: {
    destination: { write: (value: string) => void };
  }) => ({ writer: destination, release: async () => undefined }),
}));
jest.mock('./meri-server-capture-evidence.js', () => ({
  ...jest.requireActual('./meri-server-capture-evidence.js'),
  persistMeriServerCaptureEvidenceReceipt: jest.fn(async () => undefined),
}));

function harness() {
  const ctx = { tenantId: 'tenant', userId: 'actor' } as TenantContext;
  const rows: Array<Record<string, any>> = [];
  const tx = {
    clioConversation: { findFirst: jest.fn(async () => ({ id: 'conversation', clientId: null })) },
    clioMessage: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `saved-${data.role}`, ...data };
        rows.push(row);
        return row;
      }),
      findMany: jest.fn(async () => [...rows].reverse()),
    },
    aiUsageEvent: { create: jest.fn(async () => ({})) },
  };
  const settings: Record<string, unknown> = {
    CLIO_MODEL: 'requested-alias',
    CLIO_MAX_TOKENS: 1024,
    CLIO_REQUEST_TIMEOUT_MS: 30000,
    CLIO_MAX_TOOL_ROUNDS: 2,
    CLIO_TURN_BUDGET_MS: 30000,
    CLIO_HISTORY_CHAR_BUDGET: 10000,
    CLIO_EXTENDED_THINKING: false,
  };
  const service = Object.assign(Object.create(MeriService.prototype), {
    prisma: { withTenant: jest.fn(async (_id: string, fn: (db: typeof tx) => unknown) => fn(tx)) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    config: { get: (key: string) => settings[key] ?? false },
    meriV2Chat: { configured: false },
    meriFlags: { isEnabled: async () => false },
    extractStreamControl: (content: string) => ({
      cleanContent: content,
      traceEnabled: false,
      pageWriteEnabled: false,
    }),
    classifyIntent: async () => 'general_question',
    orchestrateContext: async () => ({
      policy: { tier: 'fast' },
      sources: [],
      trace: [],
      context: '',
      activeClient: null,
    }),
    buildSystemBlocks: () => [],
    skillsEnabled: () => false,
    suggestionsEnabled: () => false,
    aiCredentials: { resolveProvider: async () => ({ apiKey: 'fixture', usedTenantKey: false }) },
    tools: {
      analysisSandboxEnabled: async () => false,
      anthropicToolSchemas: () => [],
      isConcurrencySafe: () => true,
      isSideEffecting: () => false,
      execute: jest.fn(async () => ({ error: 'Fixture source unavailable' })),
    },
    mcp: { bridgedSchemasFor: async () => [] },
    toolBreaker: { isOpen: () => false, recordSuccess: jest.fn(), recordFailure: jest.fn() },
    scheduleAfterTurnMaintenance: jest.fn(),
    maybeLearnFromConversation: jest.fn(async () => undefined),
  }) as MeriService;
  return {
    run: () =>
      service.streamMessage(ctx, 'conversation', 'Read this fact', { write: () => undefined }),
  };
}

describe('native API stream supplies actual capture observations', () => {
  const priorSecret = process.env.INTERNAL_SERVICE_SECRET;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'local-test-secret';
    mockReceipt = null;
    mockPolicy = {
      version: 1,
      kind: 'server_readonly_acceptance_capture',
      policyId: 'policy',
      requestId: 'request',
      traceId: 'trace',
      turnId: null,
      caseId: '01',
      captureRunId: 'run',
      fixtureVersion: 'v1',
      physicalMapSha256: 'd'.repeat(64),
      resetReceiptId: 'reset',
      seedReceiptId: 'seed',
      fixtureNamespace: 'meri-foundation-20260928',
      tenantId: 'tenant',
      tenantSlug: 'meri-foundation-20260928-t1',
      actorUserId: 'actor',
      conversationId: 'conversation',
      clientId: null,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      toolAuthority: 'shared_static_registry_read_only',
      toolCatalogSha256: meriReadonlyCaptureCatalogSha256(),
      dynamicMcpAllowed: false,
      incidentalWriters: 'suppressed',
      expectedCaptureWrites: [
        'context_packet_and_evidence',
        'conversation_user_message',
        'conversation_assistant_message',
      ],
    };
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (priorSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = priorSecret;
  });
  function response(events: unknown[]) {
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200,
    });
  }
  it('binds real SSE model/usage and provider call ID while preserving a tool owner failure', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response([
          {
            type: 'message_start',
            message: {
              model: 'actual-provider-model',
              usage: { input_tokens: 11, output_tokens: 1 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_actual_42', name: 'search_public_web' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"query":"fixture"}' },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 4 },
          },
          { type: 'message_stop' },
        ]),
      )
      .mockResolvedValueOnce(
        response([
          {
            type: 'message_start',
            message: {
              model: 'actual-provider-model',
              usage: { input_tokens: 21, output_tokens: 1 },
            },
          },
          {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Source unavailable.' },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 6 },
          },
          { type: 'message_stop' },
        ]),
      );
    await harness().run();
    expect(mockReceipt?.receipt).toMatchObject({
      requestId: 'request',
      conversationId: 'conversation',
      turnId: 'saved-user',
      usage: {
        provider: { value: 'anthropic' },
        model: { value: 'actual-provider-model' },
        inputTokens: { value: 32 },
        outputTokens: { value: 10 },
        cacheReadTokens: { status: 'UNKNOWN' },
      },
      toolCalls: [
        {
          callId: 'toolu_actual_42',
          name: 'search_public_web',
          attempt: 1,
          readOnly: true,
          status: 'failed',
          sourceIds: [],
        },
      ],
      releases: { orchestrator: { releaseRevision: { status: 'NOT_RUN' } } },
      status: 'BLOCKED',
    });
  });
  it('does not publish default zero usage or requested model as observed after a failed request', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fixture transport failure'));
    await harness().run();
    expect(mockReceipt?.receipt.usage).toMatchObject({
      provider: { value: 'anthropic' },
      model: { status: 'UNKNOWN', value: null },
      inputTokens: { status: 'UNKNOWN', value: null },
      outputTokens: { status: 'UNKNOWN', value: null },
    });
  });
});
