import { validateMeriCapturePolicyPair } from './meri-capture-policy-readback.js';
import { EventEmitter } from 'node:events';
import type { Request } from 'express';
import {
  encodeMeriCapturePolicyTransport,
  MERI_CAPTURE_POLICY_HEADER,
  verifyMeriCaptureEvidenceReceipt,
  signMeriCaptureEvidenceReceipt,
  type MeriServerReadonlyCapturePolicy,
} from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import { MeriController } from './meri.controller.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import {
  bindCurrentMeriCaptureTurn,
  currentMeriGovernedRuntime,
  MeriContextPlaneRuntimeService,
} from './meri-context-plane-runtime.js';
import {
  admitMeriServerReadonlyCaptureTransport,
  assertMeriServerReadonlyCaptureCurrentAuthority,
  createMeriServerReadonlyCaptureOutputFence,
  issueMeriServerReadonlyCapturePolicy,
  meriReadonlyCaptureCatalogSha256,
} from './meri-server-readonly-capture.js';
import {
  buildApiOnlyMeriServerCaptureEvidence,
  persistMeriServerCaptureEvidenceReceipt,
} from './meri-server-capture-evidence.js';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';

const SECRET = 'capture-service-secret';
const TENANT_ID = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const TENANT_SLUG = 'meri-foundation-20260928-t1';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';

const captureCtx: TenantContext = {
  tenantId: TENANT_ID,
  tenantSlug: TENANT_SLUG,
  userId: ACTOR_ID,
  clerkUserId: 'clerk-synthetic-pat',
  role: 'standard_user',
};

const ordinaryCtx: TenantContext = {
  tenantId: '44444444-4444-4444-8444-444444444444',
  tenantSlug: 'ordinary-tenant',
  userId: '55555555-5555-4555-8555-555555555555',
  clerkUserId: 'clerk-ordinary',
  role: 'standard_user',
};

function policy(
  overrides: Partial<MeriServerReadonlyCapturePolicy> = {},
): MeriServerReadonlyCapturePolicy {
  const issuedAt = Date.now();
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    traceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    turnId: null,
    caseId: '01',
    captureRunId: 'run-1',
    fixtureVersion: 'fixture-v1',
    physicalMapSha256: 'd'.repeat(64),
    resetReceiptId: 'reset-1',
    seedReceiptId: 'seed-1',
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: TENANT_ID,
    tenantSlug: TENANT_SLUG,
    actorUserId: ACTOR_ID,
    conversationId: CONVERSATION_ID,
    clientId: CLIENT_ID,
    issuedAt,
    expiresAt: issuedAt + 60_000,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: meriReadonlyCaptureCatalogSha256(),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
    ],
    ...overrides,
  };
}

function request(headers: Record<string, string> = {}): Request {
  const req = new EventEmitter() as EventEmitter & Partial<Request>;
  const res = new EventEmitter() as EventEmitter & {
    writableEnded: boolean;
    destroyed: boolean;
  };
  res.writableEnded = false;
  res.destroyed = false;
  req.headers = headers;
  req.res = res as never;
  req.aborted = false;
  return req as Request;
}

function authorityHarness() {
  const state = {
    membershipActive: true,
    conversationClientId: CLIENT_ID as string | null,
    memoryAuthorized: true,
    messages: [] as any[],
  };
  const tx = {
    $executeRaw: jest.fn(async (_sql: TemplateStringsArray, ...values: any[]) => {
      const [metadata, id, tenantId, userId, conversationId, clientId] = values;
      const row = state.messages.find(
        (candidate) =>
          candidate.id === id &&
          candidate.tenantId === tenantId &&
          candidate.userId === userId &&
          candidate.conversationId === conversationId &&
          candidate.clientId === clientId &&
          candidate.role === 'assistant',
      );
      if (!row) return 0;
      row.metadata = { ...row.metadata, ...JSON.parse(metadata) };
      return 1;
    }),
    tenant: {
      findUnique: jest.fn(async () => ({
        id: TENANT_ID,
        slug: TENANT_SLUG,
        settings: {
          meriFoundationFixture: {
            fixtureNamespace: 'meri-foundation-20260928',
            captureEvidence: {
              caseId: '01',
              captureRunId: 'run-1',
              fixtureVersion: 'fixture-v1',
              physicalMapSha256: 'd'.repeat(64),
              resetReceiptId: 'reset-1',
              seedReceiptId: 'seed-1',
            },
          },
        },
      })),
    },
    user: {
      findUnique: jest.fn(async () => ({
        id: ACTOR_ID,
        clerkUserId: captureCtx.clerkUserId,
        email: 'pat.synthetic@example.com',
        firstName: 'Pat',
        lastName: 'Synthetic',
      })),
    },
    tenantMembership: {
      findFirst: jest.fn(async () => (state.membershipActive ? { id: 'membership-1' } : null)),
    },
    clioConversation: {
      findFirst: jest.fn(async () => ({
        id: CONVERSATION_ID,
        clientId: state.conversationClientId,
        client: state.conversationClientId
          ? {
              id: state.conversationClientId,
              tenantId: TENANT_ID,
              name: 'Aster Defense',
              memoryWall: true,
              memoryAccessGrants: state.memoryAuthorized ? [{ id: 'grant-1' }] : [],
            }
          : null,
      })),
    },
    clioMessage: {
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: `message-${data.role}` };
        state.messages.push(row);
        return row;
      }),
      findFirst: jest.fn(
        async ({ where }: any) =>
          state.messages.find(
            (row) =>
              (!where.id || row.id === where.id) &&
              (!where.conversationId || row.conversationId === where.conversationId) &&
              (!where.role || row.role === where.role),
          ) ?? null,
      ),
      findMany: jest.fn(async () => state.messages),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.messages.find((candidate) => candidate.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    clioAttachment: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    clioArtifact: {
      create: jest.fn(async () => ({ id: 'artifact-unexpected' })),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, run: (value: typeof tx) => unknown) => run(tx)),
  };
  return { state, tx, prisma };
}

function controllerWithSink(sink: jest.Mock, actualToolBoundary = false, prisma?: unknown) {
  const tools = actualToolBoundary
    ? Object.assign(Object.create(MeriToolsService.prototype) as MeriToolsService, {
        searchMemory: sink,
        prisma,
      })
    : { executeFromAuthenticatedUser: sink };
  return new MeriController(
    {} as never,
    tools as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('server-owned read-only acceptance capture boundary', () => {
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  test.each(['21', '22', '23', '24', '26', '27'])(
    'budget expansion %s cannot mint live policy',
    async (caseId) => {
      const { prisma, tx } = authorityHarness();
      const tenant = await tx.tenant.findUnique();
      tenant.settings.meriFoundationFixture.captureEvidence.caseId = caseId;
      tx.tenant.findUnique.mockResolvedValue(tenant);
      await expect(
        issueMeriServerReadonlyCapturePolicy({
          prisma: prisma as never,
          ctx: captureCtx,
          conversationId: CONVERSATION_ID,
        }),
      ).rejects.toMatchObject({
        response: { reason: 'controlled_budget_expansion_not_live_qualified' },
      });
    },
  );

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
    jest.restoreAllMocks();
  });

  test('raw producer emits authenticated BLOCKED evidence with actual usage and write identities', () => {
    const current = policy({ turnId: 'message-user' });
    const signed = buildApiOnlyMeriServerCaptureEvidence({
      policy: current,
      userMessageId: 'message-user',
      assistantMessageId: 'message-assistant',
      citations: [{ id: 'private-source', snippet: 'actual observed passage' }],
      usage: { inputTokens: 11, outputTokens: 7 },
      secret: SECRET,
    });
    const verified = verifyMeriCaptureEvidenceReceipt(signed, current, SECRET);

    expect(verified.status).toBe('BLOCKED');
    expect(verified.blockers).toEqual(
      expect.arrayContaining([
        'orchestrator_release_unproved',
        'source_tenant_authority_unproved:private-source',
      ]),
    );
    expect(verified.usage).toMatchObject({
      provider: { status: 'NOT_RUN', value: null },
      model: { status: 'NOT_RUN', value: null },
      inputTokens: { status: 'OBSERVED', value: 11 },
      outputTokens: { status: 'OBSERVED', value: 7 },
      estimatedCostUsd: { status: 'NOT_RUN', value: null },
    });
    expect(verified.effects.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'conversation_user_message',
          recordId: 'message-user',
          status: 'observed',
        }),
        expect.objectContaining({
          kind: 'conversation_assistant_message',
          recordId: 'message-assistant',
          status: 'observed',
        }),
      ]),
    );
  });

  test('issues policy only from current synthetic fixture, actor, conversation, and client authority', async () => {
    const { prisma, state } = authorityHarness();

    const issued = await issueMeriServerReadonlyCapturePolicy({
      prisma: prisma as never,
      ctx: captureCtx,
      conversationId: CONVERSATION_ID,
    });

    expect(issued).toMatchObject({
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      actorUserId: ACTOR_ID,
      conversationId: CONVERSATION_ID,
      clientId: CLIENT_ID,
      dynamicMcpAllowed: false,
      incidentalWriters: 'suppressed',
    });

    state.membershipActive = false;
    await expect(
      assertMeriServerReadonlyCaptureCurrentAuthority({
        prisma: prisma as never,
        ctx: captureCtx,
        policy: issued,
      }),
    ).rejects.toMatchObject({ status: 403 });
    state.membershipActive = true;
    state.conversationClientId = '77777777-7777-4777-8777-777777777777';
    await expect(
      assertMeriServerReadonlyCaptureCurrentAuthority({
        prisma: prisma as never,
        ctx: captureCtx,
        policy: issued,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test.each(['api-only', 'proxy'])(
    'receipt readback in %s tolerates JSONB key order and rejects content tampering',
    async (owner) => {
      const { prisma, state, tx } = authorityHarness();
      const current = policy({ turnId: 'message-user' });
      const receipt = buildApiOnlyMeriServerCaptureEvidence({
        policy: current,
        userMessageId: 'message-user',
        assistantMessageId: 'message-assistant',
        citations: [],
        usage: null,
        secret: SECRET,
      });
      state.messages.push({
        id: 'message-assistant',
        conversationId: CONVERSATION_ID,
        tenantId: TENANT_ID,
        userId: ACTOR_ID,
        clientId: CLIENT_ID,
        role: 'assistant',
        metadata: {},
      });
      const reorder = (value: any): any =>
        Array.isArray(value)
          ? value.map(reorder)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value)
                  .reverse()
                  .map(([key, item]) => [key, reorder(item)]),
              )
            : value;
      const update = tx.$executeRaw.getMockImplementation()!;
      let tamper = false;
      tx.$executeRaw.mockImplementation(async (sql: TemplateStringsArray, ...values: any[]) => {
        const result = await update(sql, ...values);
        const row = state.messages[0];
        row.metadata = reorder(row.metadata);
        if (tamper) row.metadata.serverCaptureEvidenceReceipt.receipt.traceId = 'tampered';
        return result;
      });
      const proxy = Object.assign(Object.create(MeriV3ProxyService.prototype), { prisma }) as any;
      const persist = () =>
        owner === 'api-only'
          ? persistMeriServerCaptureEvidenceReceipt({
              prisma: prisma as never,
              ctx: captureCtx,
              policy: current,
              assistantMessageId: 'message-assistant',
              receipt,
            })
          : proxy.persistCaptureEvidenceReceipt({
              ctx: captureCtx,
              conversationId: CONVERSATION_ID,
              clientId: CLIENT_ID,
              policy: current,
              userMessageId: 'message-user',
              assistantMessageId: 'message-assistant',
              orchestrator: receipt,
            });
      const runtime = new MeriContextPlaneRuntimeService(
        prisma as never,
        {
          resolveChat: async () => ({
            retrieval: { plan: { subjectScope: 'client' } },
          }),
        } as never,
      );
      await runtime.runChatTurn(
        captureCtx,
        { conversationId: CONVERSATION_ID, body: 'Read the source', mode: 'new' },
        async () => {
          await expect(persist()).resolves.toBeUndefined();
          expect(state.messages[0].metadata.serverReadonlyCapturePolicy).toEqual(current);
          expect(state.messages[0].metadata.serverReadonlyCapturePolicy).not.toBe(current);
          tamper = true;
          await expect(persist()).rejects.toThrow('meri_capture_receipt_readback_mismatch');
        },
      );
    },
  );

  test('runtime proxy prerequisite binds the issued policy before dispatch', async () => {
    const { prisma } = authorityHarness();
    const governed = {
      version: 1,
      operationId: 'meri.chat',
      prompt: 'governed',
      contextPacket: { items: [], exclusions: [], unauthorizedCount: 0, degraded: false },
      retrieval: { plan: { subjectScope: 'client' }, coverage: { sourceHealth: [] } },
    };
    const contextPlane = { resolveChat: jest.fn(async () => governed) };
    const runtime = new MeriContextPlaneRuntimeService(prisma as never, contextPlane as never);
    const dispatch = jest.fn(async () => {
      const current = currentMeriGovernedRuntime();
      expect(current?.capturePolicy).toMatchObject({
        tenantId: TENANT_ID,
        actorUserId: ACTOR_ID,
        conversationId: CONVERSATION_ID,
        clientId: CLIENT_ID,
      });
      expect(current?.context.serverReadonlyCapturePolicy).toBe(current?.capturePolicy);
      return 'dispatched';
    });

    await expect(
      runtime.runChatTurn(
        captureCtx,
        { conversationId: CONVERSATION_ID, body: 'Read the source', mode: 'new' },
        dispatch,
      ),
    ).resolves.toBe('dispatched');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])(
    'turn binding preserves output-fence current-authority checks (revoked=%s)',
    async (revoked) => {
      const { prisma, state } = authorityHarness();
      const runtime = new MeriContextPlaneRuntimeService(
        prisma as never,
        {
          resolveChat: async () => ({ retrieval: { plan: { subjectScope: 'client' } } }),
        } as never,
      );
      await runtime.runChatTurn(
        captureCtx,
        { conversationId: CONVERSATION_ID, body: 'Read the source', mode: 'new' },
        async () => {
          const before = currentMeriGovernedRuntime()!.capturePolicy!;
          expect(before.turnId).toBeNull();
          const released: string[] = [];
          const fence = createMeriServerReadonlyCaptureOutputFence({
            prisma: prisma as never,
            ctx: captureCtx,
            policy: before,
            destination: { write: (chunk) => released.push(chunk) },
          });
          const bound = bindCurrentMeriCaptureTurn('persisted-user-message');
          expect(bound).toEqual({ ...before, turnId: 'persisted-user-message' });
          expect(before.turnId).toBeNull();
          fence.writer.write('private response');
          state.membershipActive = !revoked;
          if (revoked) {
            await expect(fence.release()).rejects.toMatchObject({ status: 403 });
            expect(released).toEqual([]);
          } else {
            await expect(fence.release()).resolves.toBeUndefined();
            expect(released).toEqual(['private response']);
          }
        },
      );
    },
  );

  test('capture output fence preserves exact parser chunks and order only after a current-authority release', async () => {
    const { prisma } = authorityHarness();
    const issued = (await issueMeriServerReadonlyCapturePolicy({
      prisma: prisma as never,
      ctx: captureCtx,
      conversationId: CONVERSATION_ID,
    }))!;
    const released: string[] = [];
    const fence = createMeriServerReadonlyCaptureOutputFence({
      prisma: prisma as never,
      ctx: captureCtx,
      policy: issued,
      destination: { write: (chunk) => released.push(chunk) },
    });
    const chunks = [
      ': ping\n\n',
      'data: {"type":"text",',
      '"text":"private"}\n\n',
      'data: {"type":"error","message":"provider"}\n\n',
      'data: {"type":"done"}\n\n',
    ];
    chunks.forEach((chunk) => fence.writer.write(chunk));
    expect(released).toEqual([]);
    await fence.release();
    await fence.release();
    expect(released).toEqual(chunks);
  });

  test('capture output fence drops all buffered output on revocation or bounded-buffer overflow', async () => {
    const revoked = authorityHarness();
    const revokedPolicy = (await issueMeriServerReadonlyCapturePolicy({
      prisma: revoked.prisma as never,
      ctx: captureCtx,
      conversationId: CONVERSATION_ID,
    }))!;
    const revokedWrites: string[] = [];
    const revokedFence = createMeriServerReadonlyCaptureOutputFence({
      prisma: revoked.prisma as never,
      ctx: captureCtx,
      policy: revokedPolicy,
      destination: { write: (chunk) => revokedWrites.push(chunk) },
    });
    revokedFence.writer.write('data: {"type":"text","text":"PRIVATE"}\n\n');
    revoked.state.membershipActive = false;
    await expect(revokedFence.release()).rejects.toMatchObject({ status: 403 });
    expect(revokedWrites).toEqual([]);

    const overflow = authorityHarness();
    const overflowPolicy = (await issueMeriServerReadonlyCapturePolicy({
      prisma: overflow.prisma as never,
      ctx: captureCtx,
      conversationId: CONVERSATION_ID,
    }))!;
    const overflowWrites: string[] = [];
    const overflowFence = createMeriServerReadonlyCaptureOutputFence({
      prisma: overflow.prisma as never,
      ctx: captureCtx,
      policy: overflowPolicy,
      destination: { write: (chunk) => overflowWrites.push(chunk) },
    });
    for (let index = 0; index <= 8_192; index += 1) overflowFence.writer.write('x');
    await expect(overflowFence.release()).rejects.toMatchObject({
      response: expect.objectContaining({ reason: 'private_output_buffer_limit_exceeded' }),
    });
    expect(overflowWrites).toEqual([]);
  });

  test('actual raw complete turn keeps the controlled write sink at expected messages through delayed work', async () => {
    const { prisma, tx } = authorityHarness();
    const observedWriteCounts = [tx.clioMessage.create.mock.calls.length];
    const flags = {
      isEnabled: jest.fn(async () => {
        observedWriteCounts.push(tx.clioMessage.create.mock.calls.length);
        return true;
      }),
    };
    const raw = Object.create(MeriService.prototype) as any;
    Object.assign(raw, {
      prisma,
      meriFlags: flags,
      bizdevScope: undefined,
      researchPortfolioScope: undefined,
      logger: { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() },
      scheduleAfterTurnMaintenance: jest.fn(),
    });
    const contextPlane = {
      resolveChat: jest.fn(async () => ({
        version: 1,
        operationId: 'meri.chat',
        prompt: 'governed',
        contextPacket: { items: [], exclusions: [], unauthorizedCount: 0, degraded: false },
        retrieval: { plan: { subjectScope: 'firm' }, coverage: { sourceHealth: [] } },
      })),
    };
    const runtime = new MeriContextPlaneRuntimeService(prisma as never, contextPlane as never);
    const writes: string[] = [];

    await runtime.runChatTurn(
      captureCtx,
      {
        conversationId: CONVERSATION_ID,
        body: 'Generate fake constituents for the letter-writing campaign',
        mode: 'new',
      },
      () =>
        raw.streamMessage(
          captureCtx,
          CONVERSATION_ID,
          'Generate fake constituents for the letter-writing campaign',
          { write: (value: string) => writes.push(value) },
        ),
    );
    observedWriteCounts.push(tx.clioMessage.create.mock.calls.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
    observedWriteCounts.push(tx.clioMessage.create.mock.calls.length);

    const persisted = tx.clioMessage.create.mock.calls.map(([arg]: any) => arg.data);
    expect(persisted.map((row: any) => row.role)).toEqual(['user', 'assistant']);
    expect(persisted[1]?.metadata.serverReadonlyCaptureReceipt).toMatchObject({
      authority: 'server_current',
      conversationId: CONVERSATION_ID,
    });
    expect(observedWriteCounts).toEqual([0, 1, 2, 2]);
    expect(tx.clioAttachment.updateMany).not.toHaveBeenCalled();
    expect(tx.clioArtifact.create).not.toHaveBeenCalled();
    expect(tx.clioArtifact.updateMany).not.toHaveBeenCalled();
    expect(raw.scheduleAfterTurnMaintenance).not.toHaveBeenCalled();
    const frames = writes
      .filter((value) => value.startsWith('data: '))
      .map((value) => JSON.parse(value.slice(6)) as Record<string, unknown>);
    expect(frames.find((frame) => frame.type === 'done')?.serverReadonlyCaptureReceipt).toEqual(
      persisted[1]?.metadata.serverReadonlyCaptureReceipt,
    );

    const artifactAuthority = authorityHarness();
    const artifactWrites: string[] = [];
    const artifactRaw = Object.create(MeriService.prototype) as any;
    Object.assign(artifactRaw, {
      prisma: artifactAuthority.prisma,
      meriFlags: {
        isEnabled: jest.fn(async () => false),
        isMeriV2SurfaceEnabled: jest.fn(async () => true),
      },
      bizdevScope: undefined,
      researchPortfolioScope: undefined,
      logger: { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() },
      config: { get: jest.fn(() => 20_000) },
      meriV2Chat: {
        configured: true,
        streamChat: jest.fn(async ({ onEvent }: any) => {
          onEvent({
            type: 'artifact',
            artifact: {
              id: 'artifact-outside-policy',
              title: 'Unexpected artifact',
              kind: 'document',
              bodyText: 'must not link',
            },
          });
        }),
      },
      aiCredentials: { resolveProvider: jest.fn(async () => null) },
      clientKb: { buildSnapshot: jest.fn(async () => null) },
      firmSkills: { skillsForTenant: jest.fn(async () => []) },
      loadRelevantMemories: jest.fn(async () => []),
      skillsEnabled: jest.fn(() => false),
      suggestionsEnabled: jest.fn(() => false),
      scheduleAfterTurnMaintenance: jest.fn(),
    });
    const artifactRuntime = new MeriContextPlaneRuntimeService(
      artifactAuthority.prisma as never,
      contextPlane as never,
    );
    await artifactRuntime.runChatTurn(
      captureCtx,
      { conversationId: CONVERSATION_ID, body: 'Read only', mode: 'new' },
      () =>
        artifactRaw.streamMessage(
          captureCtx,
          CONVERSATION_ID,
          'Read only',
          { write: (value: string) => artifactWrites.push(value) },
          undefined,
          'new',
          [],
          'token',
        ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      artifactAuthority.tx.clioMessage.create.mock.calls.map(([arg]: any) => arg.data.role),
    ).toEqual(['user']);
    expect(artifactAuthority.tx.clioArtifact.create).not.toHaveBeenCalled();
    expect(artifactAuthority.tx.clioArtifact.updateMany).not.toHaveBeenCalled();
    expect(artifactRaw.scheduleAfterTurnMaintenance).not.toHaveBeenCalled();
    const artifactFrames = artifactWrites
      .filter((value) => value.startsWith('data: '))
      .map((value) => JSON.parse(value.slice(6)) as Record<string, unknown>);
    expect(artifactFrames.some((frame) => frame.type === 'artifact')).toBe(false);
    expect(artifactFrames).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'Server-owned read-only capture authority was denied before dispatch.',
      }),
    );
  });

  test('actual V2 full turn releases ordered private frames and the truthful persisted receipt while authority remains current', async () => {
    const authority = authorityHarness();
    const writes: string[] = [];
    const raw = Object.create(MeriService.prototype) as any;
    Object.assign(raw, {
      prisma: authority.prisma,
      meriFlags: {
        isEnabled: jest.fn(async () => false),
        isMeriV2SurfaceEnabled: jest.fn(async () => true),
      },
      bizdevScope: undefined,
      researchPortfolioScope: undefined,
      logger: { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() },
      config: { get: jest.fn(() => 20_000) },
      meriV2Chat: {
        configured: true,
        streamChat: jest.fn(async ({ onEvent }: any) => {
          await Promise.resolve();
          onEvent({ type: 'text', text: 'V2 private answer' });
          onEvent({
            type: 'grounding_caveat',
            topSeverity: 'low',
            findings: [{ check: 'source', severity: 'low', detail: 'V2 private context' }],
          });
          onEvent({
            type: 'done',
            reply: 'V2 private answer',
            steps: [],
            citations: [{ n: 1, id: 'private-source', title: 'Private', type: 'source' }],
            usage: { inputTokens: 1, outputTokens: 2 },
          });
          expect(writes).toEqual([]);
        }),
      },
      aiCredentials: { resolveProvider: jest.fn(async () => null) },
      clientKb: { buildSnapshot: jest.fn(async () => null) },
      firmSkills: { skillsForTenant: jest.fn(async () => []) },
      loadRelevantMemories: jest.fn(async () => []),
      skillsEnabled: jest.fn(() => false),
      suggestionsEnabled: jest.fn(() => false),
      scheduleAfterTurnMaintenance: jest.fn(),
    });
    const runtime = new MeriContextPlaneRuntimeService(
      authority.prisma as never,
      {
        resolveChat: jest.fn(async () => ({
          version: 1,
          operationId: 'meri.chat',
          prompt: 'governed',
          contextPacket: { items: [], exclusions: [], unauthorizedCount: 0, degraded: false },
          retrieval: { plan: { subjectScope: 'client' }, coverage: { sourceHealth: [] } },
        })),
      } as never,
    );
    await runtime.runChatTurn(
      captureCtx,
      { conversationId: CONVERSATION_ID, body: 'Read private source', mode: 'new' },
      () =>
        raw.streamMessage(
          captureCtx,
          CONVERSATION_ID,
          'Read private source',
          { write: (value: string) => writes.push(value) },
          undefined,
          'new',
          [],
          'token',
        ),
    );
    const frames = writes
      .filter((value) => value.startsWith('data: '))
      .map((value) => JSON.parse(value.slice(6)) as Record<string, unknown>);
    expect(frames.map((frame) => frame.type)).toEqual([
      'turn_accepted',
      'start',
      'text',
      'grounding_caveat',
      'usage',
      'citations',
      'done',
    ]);
    const persisted = authority.tx.clioMessage.create.mock.calls.map(([arg]: any) => arg.data);
    expect(persisted.map((row: any) => row.role)).toEqual(['user', 'assistant']);
    expect(frames.at(-1)?.serverReadonlyCaptureReceipt).toEqual(
      persisted[1]?.metadata.serverReadonlyCaptureReceipt,
    );
    expect(authority.tx.clioArtifact.create).not.toHaveBeenCalled();
    expect(authority.tx.clioArtifact.updateMany).not.toHaveBeenCalled();
    expect(raw.scheduleAfterTurnMaintenance).not.toHaveBeenCalled();
  });

  test.each(['before_first_frame', 'between_frames'] as const)(
    'actual V2 full turn withholds text, context, proposal, and metadata after authority withdrawal %s',
    async (timing) => {
      const authority = authorityHarness();
      const writes: string[] = [];
      const raw = Object.create(MeriService.prototype) as any;
      Object.assign(raw, {
        prisma: authority.prisma,
        meriFlags: {
          isEnabled: jest.fn(async () => false),
          isMeriV2SurfaceEnabled: jest.fn(async () => true),
        },
        bizdevScope: undefined,
        researchPortfolioScope: undefined,
        logger: { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() },
        config: { get: jest.fn(() => 20_000) },
        meriV2Chat: {
          configured: true,
          streamChat: jest.fn(async ({ onEvent }: any) => {
            await Promise.resolve();
            if (timing === 'before_first_frame') authority.state.membershipActive = false;
            onEvent({ type: 'text', text: 'PRIVATE_V2_ONE' });
            onEvent({
              type: 'pending_approval',
              tool: 'untrusted_tool',
              label: 'PRIVATE_PROPOSAL',
              proposalId: 'private-proposal',
              status: 'pending',
              reason: 'PRIVATE_REASON',
            });
            if (timing === 'between_frames') {
              await Promise.resolve();
              authority.state.conversationClientId = 'client-rebound';
            }
            onEvent({
              type: 'grounding_caveat',
              topSeverity: 'high',
              findings: [{ check: 'source', severity: 'high', detail: 'PRIVATE_CONTEXT' }],
            });
            onEvent({ type: 'text', text: 'PRIVATE_V2_TWO' });
            onEvent({
              type: 'done',
              reply: 'PRIVATE_V2_ONEPRIVATE_V2_TWO',
              steps: [],
              citations: [{ n: 1, id: 'private-source', title: 'Private', type: 'source' }],
            });
          }),
        },
        aiCredentials: { resolveProvider: jest.fn(async () => null) },
        clientKb: { buildSnapshot: jest.fn(async () => null) },
        firmSkills: { skillsForTenant: jest.fn(async () => []) },
        loadRelevantMemories: jest.fn(async () => []),
        skillsEnabled: jest.fn(() => false),
        suggestionsEnabled: jest.fn(() => false),
        scheduleAfterTurnMaintenance: jest.fn(),
      });
      const runtime = new MeriContextPlaneRuntimeService(
        authority.prisma as never,
        {
          resolveChat: jest.fn(async () => ({
            version: 1,
            operationId: 'meri.chat',
            prompt: 'governed',
            contextPacket: { items: [], exclusions: [], unauthorizedCount: 0, degraded: false },
            retrieval: { plan: { subjectScope: 'client' }, coverage: { sourceHealth: [] } },
          })),
        } as never,
      );
      await expect(
        runtime.runChatTurn(
          captureCtx,
          { conversationId: CONVERSATION_ID, body: 'Read private source', mode: 'new' },
          () =>
            raw.streamMessage(
              captureCtx,
              CONVERSATION_ID,
              'Read private source',
              { write: (value: string) => writes.push(value) },
              undefined,
              'new',
              [],
              'token',
            ),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(writes).toEqual([]);
      expect(authority.tx.clioMessage.create.mock.calls.map(([arg]: any) => arg.data.role)).toEqual(
        ['user'],
      );
      expect(authority.tx.clioArtifact.create).not.toHaveBeenCalled();
      expect(authority.tx.clioArtifact.updateMany).not.toHaveBeenCalled();
      expect(raw.scheduleAfterTurnMaintenance).not.toHaveBeenCalled();
    },
  );

  test.each(['before_first_frame', 'between_provider_chunks'] as const)(
    'actual raw provider full turn withholds private deltas after authority withdrawal %s',
    async (timing) => {
      const authority = authorityHarness();
      const writes: string[] = [];
      const encoder = new TextEncoder();
      jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        const body = {
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            if (timing === 'before_first_frame') authority.state.memoryAuthorized = false;
            yield encoder.encode(
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PRIVATE_RAW_ONE"}}\n',
            );
            if (timing === 'between_provider_chunks') {
              await Promise.resolve();
              authority.state.conversationClientId = 'client-rebound';
            }
            yield encoder.encode(
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PRIVATE_RAW_TWO"}}\n' +
                'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n',
            );
          },
        };
        return { ok: true, body, text: async () => '' } as never;
      });
      const configValues: Record<string, unknown> = {
        CLIO_HISTORY_CHAR_BUDGET: 20_000,
        CLIO_PROMPT_CACHE_ENABLED: false,
        CLIO_CITATIONS_ENABLED: false,
        CLIO_MODEL: 'controlled-model',
        CLIO_MAX_TOKENS: 1_000,
        CLIO_EXTENDED_THINKING: false,
        CLIO_THINKING_MODE: 'disabled',
        CLIO_THINKING_BUDGET_TOKENS: 0,
        CLIO_REQUEST_TIMEOUT_MS: 20_000,
        CLIO_MAX_TOOL_ROUNDS: 2,
        CLIO_TURN_BUDGET_MS: 20_000,
        CLIO_TOOL_TIMEOUT_MS: 1_000,
        CLIO_TOOL_RETRIES: 0,
      };
      const raw = Object.create(MeriService.prototype) as any;
      Object.assign(raw, {
        prisma: authority.prisma,
        meriFlags: {
          isEnabled: jest.fn(async () => false),
          isMeriV2SurfaceEnabled: jest.fn(async () => false),
        },
        bizdevScope: undefined,
        researchPortfolioScope: undefined,
        logger: { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() },
        config: { get: jest.fn((key: string) => configValues[key]) },
        meriV2Chat: { configured: false },
        aiCredentials: {
          resolveProvider: jest.fn(async () => ({
            apiKey: 'controlled-key',
            model: 'controlled-model',
            usedTenantKey: false,
            modelOverridden: false,
          })),
        },
        tools: {
          analysisSandboxEnabled: jest.fn(async () => false),
          anthropicToolSchemas: jest.fn(() => []),
          isSideEffecting: jest.fn(() => false),
        },
        mcp: { bridgedSchemasFor: jest.fn(async () => []) },
        classifyIntent: jest.fn(async () => 'general'),
        orchestrateContext: jest.fn(async () => ({
          context: '',
          policy: { tier: 'fast' },
          template: null,
          trace: [],
          sources: [],
          conflict: null,
          activeClient: null,
        })),
        buildSystemBlocks: jest.fn(() => []),
        skillsEnabled: jest.fn(() => false),
        suggestionsEnabled: jest.fn(() => false),
        scheduleAfterTurnMaintenance: jest.fn(),
      });
      const runtime = new MeriContextPlaneRuntimeService(
        authority.prisma as never,
        {
          resolveChat: jest.fn(async () => ({
            version: 1,
            operationId: 'meri.chat',
            prompt: 'governed',
            contextPacket: { items: [], exclusions: [], unauthorizedCount: 0, degraded: false },
            retrieval: { plan: { subjectScope: 'client' }, coverage: { sourceHealth: [] } },
          })),
        } as never,
      );
      await expect(
        runtime.runChatTurn(
          captureCtx,
          { conversationId: CONVERSATION_ID, body: 'Read private source', mode: 'new' },
          () =>
            raw.streamMessage(captureCtx, CONVERSATION_ID, 'Read private source', {
              write: (value: string) => writes.push(value),
            }),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(writes).toEqual([]);
      expect(authority.tx.clioMessage.create.mock.calls.map(([arg]: any) => arg.data.role)).toEqual(
        ['user'],
      );
      expect(authority.tx.clioArtifact.create).not.toHaveBeenCalled();
      expect(authority.tx.clioArtifact.updateMany).not.toHaveBeenCalled();
      expect(raw.scheduleAfterTurnMaintenance).not.toHaveBeenCalled();
    },
  );

  test('tool controller rejects writes before the controlled effect and permits authorized reads', async () => {
    const { prisma, state } = authorityHarness();
    const sink = jest.fn(async () => ({ tool: 'search_memory', result: 'normal' }));
    const controller = controllerWithSink(sink, true, prisma);
    const current = policy();
    const writeHeader = encodeMeriCapturePolicyTransport(current, 'tool', 'send_email', SECRET);

    await expect(
      Promise.resolve().then(() =>
        controller.executeTool(
          captureCtx,
          'send_email',
          { to: 'nobody@example.com' },
          request({ [MERI_CAPTURE_POLICY_HEADER]: writeHeader }),
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(sink).not.toHaveBeenCalled();

    const readHeader = encodeMeriCapturePolicyTransport(current, 'tool', 'search_memory', SECRET);
    await expect(
      controller.executeTool(
        captureCtx,
        'search_memory',
        { query: 'appropriations' },
        request({ [MERI_CAPTURE_POLICY_HEADER]: readHeader }),
      ),
    ).resolves.toEqual({ tool: 'search_memory', result: 'normal' });
    expect(sink).toHaveBeenCalledTimes(1);

    state.membershipActive = false;
    await expect(
      controller.executeTool(
        captureCtx,
        'search_memory',
        { query: 'appropriations' },
        request({ [MERI_CAPTURE_POLICY_HEADER]: readHeader }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(sink).toHaveBeenCalledTimes(1);

    state.membershipActive = true;
    state.conversationClientId = '77777777-7777-4777-8777-777777777777';
    await expect(
      controller.executeTool(
        captureCtx,
        'search_memory',
        { query: 'appropriations' },
        request({ [MERI_CAPTURE_POLICY_HEADER]: readHeader }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(sink).toHaveBeenCalledTimes(1);
  });

  test('missing, malformed, stale, wrong-tenant, and actor-rebound transport authority fails closed', () => {
    expect(() =>
      admitMeriServerReadonlyCaptureTransport({
        ctx: captureCtx,
        req: request(),
        purpose: 'tool',
        toolName: 'search_memory',
      }),
    ).toThrow('Server-owned read-only capture authority was denied before dispatch.');

    for (const encoded of [
      'not-an-envelope',
      encodeMeriCapturePolicyTransport(
        policy({ expiresAt: Date.now() - 1 }),
        'tool',
        'search_memory',
        SECRET,
      ),
      encodeMeriCapturePolicyTransport(
        policy({ actorUserId: '66666666-6666-4666-8666-666666666666' }),
        'tool',
        'search_memory',
        SECRET,
      ),
      encodeMeriCapturePolicyTransport(
        policy({ tenantId: '77777777-7777-4777-8777-777777777777' }),
        'tool',
        'search_memory',
        SECRET,
      ),
    ]) {
      expect(() =>
        admitMeriServerReadonlyCaptureTransport({
          ctx: captureCtx,
          req: request({ [MERI_CAPTURE_POLICY_HEADER]: encoded }),
          purpose: 'tool',
          toolName: 'search_memory',
        }),
      ).toThrow('Server-owned read-only capture authority was denied before dispatch.');
    }
  });

  test('ordinary tenants retain their existing controller behavior without a capture policy', async () => {
    const sink = jest.fn(async () => ({ disposition: 'existing-path' }));
    const controller = controllerWithSink(sink);

    await expect(
      controller.executeTool(ordinaryCtx, 'send_email', { to: 'existing@example.com' }, request()),
    ).resolves.toEqual({ disposition: 'existing-path' });
    expect(sink).toHaveBeenCalledTimes(1);
  });
  function captureReadbackHarness() {
    const { prisma, state } = authorityHarness();
    const current = policy({ turnId: 'message-user' });
    const envelope = buildApiOnlyMeriServerCaptureEvidence({
      policy: current,
      userMessageId: 'message-user',
      assistantMessageId: 'message-assistant',
      citations: [],
      usage: null,
      secret: SECRET,
    });
    const scope = {
      tenantId: TENANT_ID,
      userId: ACTOR_ID,
      conversationId: CONVERSATION_ID,
      clientId: CLIENT_ID,
    };
    state.messages.push({ ...scope, id: 'message-user', role: 'user', body: 'read', metadata: {} });
    state.messages.push({
      ...scope,
      id: 'message-assistant',
      role: 'assistant',
      body: 'private answer',
      metadata: {
        serverReadonlyCapturePolicy: current,
        serverCaptureEvidenceReceipt: envelope,
      },
    });
    const authorizeOrdinaryReportMessages = jest.fn(async (_ctx, _scope, messages) => messages);
    const service = Object.assign(Object.create(MeriService.prototype), {
      prisma,
      authorizeOrdinaryReportMessages,
    }) as MeriService;
    return { state, current, envelope, service, authorizeOrdinaryReportMessages };
  }

  test('existing messages GET independently reads the full policy and keeps report authorization', async () => {
    const h = captureReadbackHarness();
    const result = await h.service.listMessages(captureCtx, CONVERSATION_ID);
    expect(result[1]?.metadata).toEqual({
      serverReadonlyCapturePolicy: h.current,
      serverCaptureEvidenceReceipt: h.envelope,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(h.authorizeOrdinaryReportMessages).toHaveBeenCalledTimes(1);
  });

  test.each(['membership', 'client-wall', 'conversation-client', 'turn-missing'])(
    'existing messages GET denies capture evidence after current %s authority changes',
    async (change) => {
      const h = captureReadbackHarness();
      if (change === 'membership') h.state.membershipActive = false;
      if (change === 'client-wall') h.state.memoryAuthorized = false;
      if (change === 'conversation-client') h.state.conversationClientId = 'other-client';
      if (change === 'turn-missing') h.state.messages.shift();
      await expect(h.service.listMessages(captureCtx, CONVERSATION_ID)).rejects.toMatchObject({
        status: 403,
      });
      expect(h.authorizeOrdinaryReportMessages).not.toHaveBeenCalled();
    },
  );

  test.each([
    'policy-missing',
    'receipt-missing',
    'expired',
    'trace',
    'extra-secret',
    'message-id',
  ])(
    'existing messages GET rejects %s without deriving a policy from the envelope',
    async (change) => {
      const h = captureReadbackHarness();
      const metadata = h.state.messages[1].metadata;
      if (change === 'policy-missing') delete metadata.serverReadonlyCapturePolicy;
      if (change === 'receipt-missing') delete metadata.serverCaptureEvidenceReceipt;
      if (change === 'expired') metadata.serverReadonlyCapturePolicy.expiresAt = Date.now() - 1;
      if (change === 'trace') metadata.serverReadonlyCapturePolicy.traceId = 'different';
      if (change === 'extra-secret') metadata.serverReadonlyCapturePolicy.serviceSecret = SECRET;
      if (change === 'message-id') h.state.messages[1].id = 'another-assistant';
      await expect(h.service.listMessages(captureCtx, CONVERSATION_ID)).rejects.toMatchObject({
        status: 403,
      });
    },
  );

  test('a validly signed fixture mismatch is rejected against the independently issued policy', () => {
    const h = captureReadbackHarness();
    const changed = structuredClone(h.envelope.receipt);
    changed.fixture.physicalMapSha256 = { status: 'OBSERVED', value: 'a'.repeat(64), reason: null };
    const signed = signMeriCaptureEvidenceReceipt(changed, SECRET);
    expect(() => validateMeriCapturePolicyPair(h.current, signed)).toThrow(
      'meri_capture_policy_readback_denied',
    );
  });

  test('Case12 receipt readback binds the separate completed setup without promoting capture', () => {
    const current = policy({caseId: '12', turnId: 'message-user', resetReceiptId: null, seedReceiptId: null,
      captureRunId: '33333333-3333-4333-8333-333333333333', case12Setup: {
        setupRunId: '11111111-1111-4111-8111-111111111111', fixtureInstanceId: '22222222-2222-4222-8222-222222222222',
        setupPlanSha256: 'a'.repeat(64), setupClaimSha256: 'b'.repeat(64), setupLedgerSha256: 'c'.repeat(64),
      }});
    const envelope = buildApiOnlyMeriServerCaptureEvidence({policy: current, userMessageId: 'message-user',
      assistantMessageId: 'message-assistant', citations: [], usage: null, secret: SECRET});
    expect(validateMeriCapturePolicyPair(current, envelope)).toEqual(current);
    expect(envelope.receipt.status).toBe('BLOCKED');
    expect(envelope.receipt.fixture.case12Setup?.value).toEqual(current.case12Setup);
    const changed = structuredClone(envelope.receipt);
    changed.fixture.case12Setup!.value!.setupLedgerSha256 = 'd'.repeat(64);
    expect(() => validateMeriCapturePolicyPair(current, signMeriCaptureEvidenceReceipt(changed, SECRET))).toThrow('policy_readback_denied');
    const missing = structuredClone(envelope.receipt); delete missing.fixture.case12Setup;
    expect(() => validateMeriCapturePolicyPair(current, signMeriCaptureEvidenceReceipt(missing, SECRET))).toThrow('policy_readback_denied');
    expect(() => validateMeriCapturePolicyPair({...current, caseId: '14'}, envelope)).toThrow('policy_readback_denied');
  });

  test('clock readback allows only the exact field and independently matches the receipt binding', () => {
    const current = policy({ turnId: 'message-user', fixtureVersion: 'meri-live-v1-2026-09-26.1',
      captureRunId: '11111111-1111-4111-8111-111111111111' });
    current.semanticClock = { version: 1, kind: 'qualified_original_fixture_semantic_clock',
      instant: '2026-09-26T16:00:00.000Z', timeZone: 'America/New_York', caseId: '01',
      captureRunId: current.captureRunId!, currentVerifySha256: 'a'.repeat(64), observedAt: current.issuedAt };
    const envelope = buildApiOnlyMeriServerCaptureEvidence({ policy: current,
      userMessageId: 'message-user', assistantMessageId: 'message-assistant', citations: [], usage: null, secret: SECRET });
    expect(validateMeriCapturePolicyPair(current, envelope)).toEqual(current);
    expect(envelope.receipt.blockers).toContain('semantic_clock_api_tool_join_pending');
    expect(envelope.receipt.semanticClock!.prompt.status).toBe('NOT_RUN');
    for (const changed of [ { ...current, semanticClock: null }, { ...current, semanticClock: undefined },
      { ...current, fixtureVersion: null }, { ...current, fixtureVersion: 'other-fixture' },
      { ...current, extraClock: current.semanticClock },
      { ...current, semanticClock: { ...current.semanticClock, currentVerifySha256: 'b'.repeat(64) } },
      { ...current, syntheticReadBudget: {} } ]) {
      expect(() => validateMeriCapturePolicyPair(changed, envelope)).toThrow('policy_readback_denied');
    }
    const noClock = { ...current }; delete noClock.semanticClock;
    expect(() => validateMeriCapturePolicyPair(noClock, envelope)).toThrow('policy_readback_denied');
  });

  test('ordinary messages need no capture service identity and retain their metadata', async () => {
    const h = captureReadbackHarness();
    h.state.messages[1].metadata = { ordinary: true };
    delete process.env.INTERNAL_SERVICE_SECRET;
    expect((await h.service.listMessages(captureCtx, CONVERSATION_ID))[1]?.metadata).toEqual({
      ordinary: true,
    });
  });
});
