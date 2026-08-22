import { describe, expect, it, jest } from '@jest/globals';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

/**
 * Phase 27 post-launch P1 (MeriV3 front) — found live in the Capiro-internal
 * canary: this tenant is routed through MeriV3ProxyService.streamMessage
 * (meriv3-runtime.proxy.ts's Proxy dispatches here whenever
 * MeriFeatureFlagsService.isMeriV3ChatEnabled is true), a completely separate
 * implementation from MeriService.streamMessage. The PR #1214 fix only
 * patched the latter, so feedback rated immediately after a MeriV3 turn
 * still posted the client's stale optimistic id and 400'd — reproduced
 * against the live capiro-dev-api right after #1214 deployed. These tests
 * pin the same contract here: every `done` frame this service ever emits
 * must carry the persisted assistant message id whenever one was written.
 */
function buildHarness() {
  const tx = {
    clioConversation: {
      findFirst: jest.fn(async () => ({
        id: CONVERSATION,
        clientId: null,
        summaryUpToMessageId: null,
        summary: null,
        metadata: null,
        client: null,
      })),
    },
    clioMessage: {
      create: jest.fn(async ({ data }: any) => ({ id: `msg-${data.role}-${Math.random()}` })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
    },
    clioAttachment: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({})),
    },
    clioArtifact: {
      updateMany: jest.fn(async () => ({})),
    },
  };
  const prisma = { withTenant: jest.fn((_t: string, cb: (tx: unknown) => unknown) => cb(tx)) };
  const flags = {
    isMeriV3ChatEnabled: jest.fn(async () => true),
    // compliance-block / deepResearchPromote off by default
    isEnabled: jest.fn(async (_tenantId: string, _key: string) => false),
  };
  const client = {
    configured: true,
    streamChat: jest.fn(async (_args: any) => {}),
  };
  const aiCredentials = { resolveProvider: jest.fn(async () => null) };
  const clientKb = { buildSnapshot: jest.fn(async () => null) };
  const firmSkills = { skillsForTenant: jest.fn(async () => []) };

  const service = new MeriV3ProxyService(
    prisma as never,
    flags as never,
    client as never,
    aiCredentials as never,
    clientKb as never,
    firmSkills as never,
  );

  const writes: string[] = [];
  const sse = { write: (data: string) => writes.push(data) };
  const frames = () =>
    writes
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);

  return { service, tx, prisma, flags, client, sse, frames };
}

const CTX = { tenantId: TENANT, userId: USER } as never;

describe('MeriV3ProxyService — done frame carries the persisted message id', () => {
  it('main completion path: done frame includes the real persisted assistant message id', async () => {
    const { service, client, sse, frames } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'text', text: 'Hello from MeriV3.' });
      onEvent({
        type: 'done',
        model: 'gpt-test',
        reasoningEffort: 'medium',
        reply: 'Hello from MeriV3.',
        usage: {},
        citations: [],
      });
    });

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Hi Meri',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toBeDefined();
    expect(typeof done!.messageId).toBe('string');
    expect(done!.messageId).toMatch(/^msg-assistant-/);
    // The stale-optimistic-id bug this pins: a client-generated id like
    // `mt4nmadw-siemgnk5ck` must never be what the frontend has to fall back
    // to — the server-persisted id must always be present when content or
    // tool steps were produced.
  });

  it('compliance-block short-circuit: done frame includes the refusal message id', async () => {
    const { service, flags, sse, frames } = buildHarness();
    flags.isEnabled.mockImplementation(async (_t: string, key: string) => key === 'complianceBlock');

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'please help me launder money through a shell PAC',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toBeDefined();
    expect(typeof done!.messageId).toBe('string');
    expect(done!.messageId).toMatch(/^msg-assistant-/);
  });

  it('research-promote short-circuit: done frame includes the offer message id', async () => {
    const { service, flags, sse, frames } = buildHarness();
    flags.isEnabled.mockImplementation(
      async (_t: string, key: string) => key === 'deepResearchPromote',
    );

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Build me a full sourced deliverable report on this program with every citation verified',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toBeDefined();
    expect(typeof done!.messageId).toBe('string');
    expect(done!.messageId).toMatch(/^msg-assistant-/);
  });

  it('nothing persisted (empty reply, no tool steps, no error): done frame omits messageId rather than fabricating one', async () => {
    const { service, client, sse, frames } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'done', model: 'gpt-test', reasoningEffort: 'low', reply: '', usage: {} });
    });

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Hi Meri',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toBeDefined();
    expect(done!.messageId).toBeUndefined();
  });

  it('contextPacketId/retrieval fields survive alongside messageId when both are present', async () => {
    const { service, client, sse, frames } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'text', text: 'Answer.' });
      onEvent({
        type: 'done',
        model: 'gpt-test',
        reasoningEffort: 'medium',
        reply: 'Answer.',
        usage: {},
        citations: [],
        contextPacket: { packetId: 'packet-1' },
        retrieval: { plan: { version: 1 }, coverage: { version: 1, complete: true } },
      });
    });

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Hi Meri',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toMatchObject({
      contextPacketId: 'packet-1',
      retrieval: expect.objectContaining({ plan: expect.anything() }),
    });
    expect(typeof done!.messageId).toBe('string');
  });
});
