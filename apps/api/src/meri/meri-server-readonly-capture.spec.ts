import { EventEmitter } from 'node:events';
import type { Request } from 'express';
import {
  encodeMeriCapturePolicyTransport,
  MERI_CAPTURE_POLICY_HEADER,
  type MeriServerReadonlyCapturePolicy,
} from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import { MeriController } from './meri.controller.js';
import { MeriToolsService } from './meri-tools.service.js';
import {
  currentMeriGovernedRuntime,
  MeriContextPlaneRuntimeService,
} from './meri-context-plane-runtime.js';
import {
  admitMeriServerReadonlyCaptureTransport,
  issueMeriServerReadonlyCapturePolicy,
  meriReadonlyCaptureCatalogSha256,
} from './meri-server-readonly-capture.js';

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

function policy(overrides: Partial<MeriServerReadonlyCapturePolicy> = {}): MeriServerReadonlyCapturePolicy {
  const issuedAt = Date.now();
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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

function controllerWithSink(sink: jest.Mock, actualToolBoundary = false) {
  const tools = actualToolBoundary
    ? Object.assign(Object.create(MeriToolsService.prototype) as MeriToolsService, {
        searchMemory: sink,
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
  );
}

describe('server-owned read-only acceptance capture boundary', () => {
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
    jest.restoreAllMocks();
  });

  test('issues policy only from current synthetic fixture, actor, conversation, and client authority', async () => {
    const prisma = {
      tenant: {
        findUnique: jest.fn(async () => ({
          id: TENANT_ID,
          slug: TENANT_SLUG,
          settings: { meriFoundationFixture: { fixtureNamespace: 'meri-foundation-20260928' } },
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
    };

    const issued = await issueMeriServerReadonlyCapturePolicy({
      prisma: prisma as never,
      ctx: captureCtx,
      conversationId: CONVERSATION_ID,
      clientId: CLIENT_ID,
      now: 1_000,
    });

    expect(issued).toMatchObject({
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      actorUserId: ACTOR_ID,
      conversationId: CONVERSATION_ID,
      clientId: CLIENT_ID,
      issuedAt: 1_000,
      expiresAt: 1_801_000,
      dynamicMcpAllowed: false,
      incidentalWriters: 'suppressed',
    });
  });

  test('runtime proxy prerequisite binds the issued policy before dispatch', async () => {
    const tx = {
      clioConversation: {
        findFirst: jest.fn(async () => ({ id: CONVERSATION_ID, client: { id: CLIENT_ID, name: 'Aster Defense' } })),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (value: typeof tx) => unknown) => run(tx)),
      tenant: {
        findUnique: jest.fn(async () => ({
          id: TENANT_ID,
          slug: TENANT_SLUG,
          settings: { meriFoundationFixture: { fixtureNamespace: 'meri-foundation-20260928' } },
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
    };
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

  test('tool controller rejects writes before the controlled effect and permits authorized reads', async () => {
    const sink = jest.fn(async () => ({ tool: 'search_memory', result: 'normal' }));
    const controller = controllerWithSink(sink, true);
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
  });

  test('missing, malformed, stale, and actor-rebound transport authority fails closed', () => {
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
});
