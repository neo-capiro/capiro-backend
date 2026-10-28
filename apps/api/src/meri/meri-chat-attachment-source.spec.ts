import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RolesGuard } from '../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../auth/tool-service-secret.guard.js';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import { MeriChatAttachmentReadService } from './meri-chat-attachment-read.service.js';
import {
  MeriChatAttachmentSourceService,
  parseAttachmentSource,
} from './meri-chat-attachment-source.js';
import { MeriChatAttachmentSourceController } from './meri-chat-attachment-source.controller.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const TENANT = id(1),
  ACTOR = id(2),
  CURRENT = id(3),
  SOURCE = id(4),
  CLIENT = id(5),
  VERSION = '2026-10-01T12:00:00.000Z';
const ctx = {
  tenantId: TENANT,
  userId: ACTOR,
  role: 'standard_user',
  tenantSlug: 'synthetic',
  clerkUserId: 'synthetic',
};
const selection = (clientId: string | null = CLIENT) => ({
  version: 2,
  currentTurn: { conversationId: CURRENT, selectedClientId: clientId },
  source: { kind: 'clio_conversation', conversationId: SOURCE },
});
function fixture(clientId: string | null = CLIENT) {
  const state = {
    version: VERSION,
    owner: ACTOR,
    clientId,
    visible: true,
    currentCalls: 0,
    changedCurrent: false,
    revokeCurrentAfter: false,
    changeSourceOnList: false,
    rowAvailable: true,
  };
  const current = {
    read: jest.fn(
      async (
        _ctx: unknown,
        _req: unknown,
        input: { conversationId: string; clientId: string | null; expect?: unknown },
      ) => {
        state.currentCalls++;
        if (
          input.conversationId !== CURRENT ||
          input.clientId !== state.clientId ||
          (state.revokeCurrentAfter && state.currentCalls > 1)
        )
          throw Error('CURRENT_DENIED');
        return {
          principal: { tenantId: TENANT, actorId: ACTOR },
          conversationId: CURRENT,
          selectedClientId: state.clientId,
          identityRevision: 'i',
          membershipRevision: 'm',
          contextRevision: state.changedCurrent && state.currentCalls > 1 ? 'changed' : 'c',
          checkedAtMs: Date.now(),
          expiresAtMs: Date.now() + 30000,
        };
      },
    ),
  };
  const conversation = jest.fn(
    async ({
      where,
    }: {
      where: { id: string; tenantId: string; userId: string; archivedAt: null };
    }) =>
      where.id === SOURCE &&
      where.tenantId === TENANT &&
      where.userId === state.owner &&
      state.rowAvailable
        ? { id: SOURCE, clientId: state.clientId, updatedAt: new Date(state.version) }
        : null,
  );
  const messages = jest.fn(async () => {
    if (state.changeSourceOnList) state.version = '2026-10-02T12:00:00.000Z';
    return [];
  });
  const tx = {
    clioConversation: { findFirst: conversation },
    clioMessage: { findMany: messages },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: state.visible }]),
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (tenant: string, actor: string, run: (value: typeof tx) => unknown) => {
        if (tenant !== TENANT || actor !== ACTOR) throw Error('PRINCIPAL_DENIED');
        return run(tx);
      },
    ),
  };
  const reader = new MeriChatAttachmentReadService(prisma as never);
  const service = new MeriChatAttachmentSourceService(current as never, reader);
  const execute = (body: unknown, read = false) =>
    service.execute(ctx as never, {} as never, body, read) as Promise<any>;
  return { state, current, conversation, messages, reader, service, execute };
}
function readBody(observation: any, input: Record<string, unknown> = {}) {
  return {
    ...selection(observation.currentTurn.selectedClientId),
    source: {
      kind: 'clio_conversation',
      conversationId: SOURCE,
      conversationVersion: observation.scope.conversationVersion,
    },
    observation: { asOf: observation.asOf, expiresAtMs: observation.expiresAtMs },
    input,
  };
}

describe('native prior-chat source owner', () => {
  test.each([CLIENT, null])(
    'reads a distinct owned source under current client/General, preserving exact context and empty manifest (%s)',
    async (client) => {
      const f = fixture(client),
        observed = await f.execute(selection(client));
      expect(observed).toMatchObject({
        version: 2,
        currentTurn: { conversationId: CURRENT, selectedClientId: client },
        scope: {
          tenantId: TENANT,
          userId: ACTOR,
          conversationId: SOURCE,
          clientId: client,
          conversationVersion: VERSION,
        },
      });
      expect(observed.expiresAtMs).toBeGreaterThan(observed.checkedAtMs);
      f.state.currentCalls = 0;
      const result = await f.execute(readBody(observed), true);
      expect(result).toMatchObject({
        tool: 'read_chat_attachments',
        conversationId: SOURCE,
        clientId: client,
        generatedAt: observed.asOf,
        records: [],
        coverage: { paginationComplete: true, contentComplete: false, total: null },
      });
      expect(f.current.read).toHaveBeenLastCalledWith(
        ctx,
        {},
        expect.objectContaining({
          conversationId: CURRENT,
          expect: { identityRevision: 'i', membershipRevision: 'm', contextRevision: 'c' },
        }),
      );
      expect(
        f.conversation.mock.calls.every(
          ([q]) =>
            q.where.id === SOURCE &&
            q.where.userId === ACTOR &&
            q.where.tenantId === TENANT &&
            q.where.archivedAt === null,
        ),
      ).toBe(true);
    },
  );
  test('source selectors do not silently become current-conversation authority', async () => {
    const f = fixture();
    await expect(
      f.execute({ ...selection(), source: { kind: 'clio_conversation', conversationId: CURRENT } }),
    ).rejects.toThrow();
    expect(f.messages).not.toHaveBeenCalled();
    expect(f.current.read.mock.calls[0]![2].conversationId).toBe(CURRENT);
  });
  test.each(['owner', 'wall', 'removed', 'client'] as const)(
    'current source %s denial releases no manifest',
    async (mode) => {
      const f = fixture();
      if (mode === 'owner') f.state.owner = id(99);
      if (mode === 'wall') f.state.visible = false;
      if (mode === 'removed') f.state.rowAvailable = false;
      const body = selection();
      if (mode === 'client') body.currentTurn.selectedClientId = id(99);
      await expect(f.execute(body)).rejects.toThrow();
      expect(f.messages).not.toHaveBeenCalled();
    },
  );
  test('changed or revoked current turn after source observation withholds its context', async () => {
    for (const key of ['changedCurrent', 'revokeCurrentAfter'] as const) {
      const f = fixture();
      f.state[key] = true;
      await expect(f.execute(selection())).rejects.toThrow();
    }
  });
  test('changed source between context and read and during actual read is refused', async () => {
    const f = fixture(),
      o = await f.execute(selection());
    f.state.version = '2026-10-02T12:00:00.000Z';
    await expect(f.execute(readBody(o), true)).rejects.toThrow();
    f.state.version = VERSION;
    f.state.changeSourceOnList = true;
    await expect(f.execute(readBody(o), true)).rejects.toThrow();
  });
  test('closed v2 envelope rejects wrong namespace, authority fields, input source substitution and stale/future observations', async () => {
    const f = fixture(),
      o = await f.execute(selection()),
      body = readBody(o);
    for (const bad of [
      { ...selection(), version: 1 },
      { ...selection(), tenantId: TENANT },
      { ...selection(), source: { kind: 'meri_conversation', conversationId: SOURCE } },
      { ...body, input: { conversationId: CURRENT } },
      {
        ...body,
        observation: {
          asOf: new Date(Date.now() + 60000).toISOString(),
          expiresAtMs: Date.now() + 65000,
        },
      },
      {
        ...body,
        observation: {
          asOf: new Date(Date.now() - 60000).toISOString(),
          expiresAtMs: Date.now() + 1000,
        },
      },
    ])
      expect(() => parseAttachmentSource(bad, Object.hasOwn(bad, 'input'))).toThrow();
    const hostile = { ...selection() };
    Object.defineProperty(hostile, 'source', {
      get() {
        throw Error('GETTER_EXECUTED');
      },
      enumerable: true,
    });
    expect(() => parseAttachmentSource(hostile, false)).toThrow(
      'Invalid attachment source request',
    );
  });
  test('v1 reader remains callable with its old scope; no source observation is required', async () => {
    const { withMeriChatAttachmentReadScope } =
      await import('./meri-chat-attachment-read-scope.js');
    const f = fixture();
    const result = await withMeriChatAttachmentReadScope(
      { tenantId: TENANT, userId: ACTOR, conversationId: SOURCE, selectedClientId: CLIENT },
      () => f.reader.read(ctx as never, { conversationId: SOURCE }),
    );
    expect(result.conversationId).toBe(SOURCE);
    expect(result.generatedAt).toEqual(expect.any(String));
    expect(f.current.read).not.toHaveBeenCalled();
  });
  test('source observation expiry never extends the actual request deadline', async () => {
    const { withMeriToolExecutionControl } = await import('./meri-tool-request-control.js');
    const f = fixture(),
      deadlineAt = Date.now() + 1000;
    const observation = await withMeriToolExecutionControl(
      { signal: new AbortController().signal, deadlineAt },
      () => f.execute(selection()),
    );
    expect(observation.expiresAtMs).toBeLessThanOrEqual(deadlineAt);
    expect(Date.parse(observation.asOf)).toBe(observation.checkedAtMs);
  });
});

describe('fixed native attachment HTTP routes', () => {
  let app: INestApplication;
  const f = fixture();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MeriChatAttachmentSourceController],
      providers: [
        ToolServiceSecretGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'NODE_ENV'
                ? 'test'
                : key === 'INTERNAL_SERVICE_SECRET'
                  ? 'synthetic-native-source'
                  : false,
          },
        },
        { provide: MeriChatAttachmentSourceService, useValue: f.service },
      ],
    })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: any, _res: any, next: () => void) => {
      req.tenantContext = ctx;
      next();
    });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  test('real service guard denies observe-only admission without opening the source', async () => {
    const before = f.current.read.mock.calls.length;
    await request(app.getHttpServer())
      .post('/api/clio/attachments/read-context')
      .send(selection())
      .expect(403);
    expect(f.current.read.mock.calls.length).toBe(before);
  });
  test('mounted context -> read uses the same existing reader and never creates a current/source ID alias', async () => {
    const observed = await request(app.getHttpServer())
      .post('/api/clio/attachments/read-context')
      .set('x-internal-service-secret', 'synthetic-native-source')
      .send(selection())
      .expect(200);
    expect(observed.headers['cache-control']).toBe('no-store');
    const page = await request(app.getHttpServer())
      .post('/api/clio/attachments/read')
      .set('x-internal-service-secret', 'synthetic-native-source')
      .send(readBody(observed.body))
      .expect(200);
    expect(page.body.conversationId).toBe(SOURCE);
    expect(page.body.generatedAt).toBe(observed.body.asOf);
  });
});
