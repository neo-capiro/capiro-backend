import { S3Client } from '@aws-sdk/client-s3';
import { MERI_CASE46 as f } from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { createCase46SetupDependencies } from './meri-case46-setup-dependencies.js';
import { case46SourceIdentity } from './meri-case46-authority.js';

const run = '1196830a-83b4-4530-bcd1-87840bf88b41';
const ctx = {
  tenantId: f.tenantId,
  tenantSlug: f.tenantSlug,
  userId: f.actorUserId,
  clerkUserId: 'user_owned_case46_test',
  role: 'standard_user',
} as TenantContext;
const keys = [
  'MERI_SYNTHETIC_FIXTURE_NAMESPACE',
  'ASSETS_BUCKET',
  'DATABASE_URL',
  'INTERNAL_SERVICE_SECRET',
  'CLIO_CLIENT_KB_ENABLED',
  'ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED',
  'CAPIRO_SERVICE_NAME',
  'ENGAGEMENT_PROCESS_MODE',
  'ENGAGEMENT_EXTERNAL_ACTIONS',
  'ENGAGEMENT_BACKGROUND_OWNER',
  'ENGAGEMENT_CALLBACKS_ENABLED',
  'ENGAGEMENT_RECALL_WEBHOOK_ENABLED',
];
const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, {
    MERI_SYNTHETIC_FIXTURE_NAMESPACE: f.namespace,
    ASSETS_BUCKET: 'case46-owned-test',
    DATABASE_URL: 'postgresql://unused@127.0.0.1:55433/unused',
    INTERNAL_SERVICE_SECRET: 'owned-constructor-test-only-not-a-real-secret',
    CLIO_CLIENT_KB_ENABLED: 'false',
    ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED: 'false',
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(() => {
  for (const k of keys)
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
});

function ports() {
  const rows = new Map<string, any>();
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) =>
      sql.join('').includes('SELECT u.clerk_user_id')
        ? [
            {
              clerk_user_id: ctx.clerkUserId,
              email: 'synthetic@example.com',
              first_name: 'Synthetic',
              last_name: 'Pat',
              role: 'standard_user',
              slug: f.tenantSlug,
              fixture_namespace: f.namespace,
            },
          ]
        : [],
    ),
    client: { findFirst: jest.fn(async () => ({ id: f.clientId, memoryWall: false })) },
    user: {
      findUnique: jest.fn(async () => ({
        email: 'synthetic@example.com',
        firstName: 'Synthetic',
        lastName: 'Pat',
      })),
    },
    engagementAttachment: {
      findFirst: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      upsert: jest.fn(async ({ create }: any) => {
        const row = {
          ...create,
          meetingId: null,
          viewerMode: 'all',
          viewerUserIds: [],
          indexedAt: null,
          supersededByAttachmentId: null,
        };
        rows.set(create.id, row);
        return row;
      }),
    },
    clioConversation: {
      create: jest.fn(async ({ data }: any) => ({
        id: 'f18048fe-182f-470a-b244-e5c1b9077f83',
        ...data,
      })),
    },
  };
  jest.spyOn(PrismaService.prototype, '$connect').mockResolvedValue();
  const disconnect = jest.spyOn(PrismaService.prototype, '$disconnect').mockResolvedValue();
  jest
    .spyOn(PrismaService.prototype, 'withTenantUser')
    .mockImplementation(async (_t, _u, work) => work(tx as never));
  jest
    .spyOn(PrismaService.prototype, 'withTenant')
    .mockImplementation(async (_t, work) => work(tx as never));
  const send = jest.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: any) => {
    if (command.constructor.name === 'GetObjectCommand')
      return { Body: { transformToByteArray: async () => Buffer.from(f.text) } };
    return {};
  }) as never);
  const index = jest.spyOn(ClientKbService.prototype, 'indexAttachment');
  return { tx, rows, send, index, disconnect };
}

it('real minimal document constructors create only canonical source bytes and an empty product conversation', async () => {
  const p = ports();
  const runtime = await createCase46SetupDependencies();
  try {
    expect(Object.keys(runtime).sort()).toEqual([
      'assertActor',
      'close',
      'createConversation',
      'createSource',
      'deps',
    ]);
    expect(Object.keys(runtime.deps.engagement)).toEqual(['extractAttachmentText']);
    const source = await runtime.createSource(ctx, run);
    expect(source).toEqual({
      id: case46SourceIdentity(run).physicalId,
      sourceSha256: f.sha256,
      ownershipSha256: case46SourceIdentity(run).ownershipSha256,
      byteLength: 28,
    });
    expect(p.send).toHaveBeenCalledTimes(1);
    const sent = (p.send.mock.calls[0]![0] as any).input;
    expect(sent.Body.equals(Buffer.from(f.text))).toBe(true);
    expect(p.index).not.toHaveBeenCalled(); // actual configured disabled branch, no invented indexed row
    expect(p.rows.get(source.id)).toMatchObject({
      lifecycleStatus: 'ready',
      scanStatus: 'scanner_not_required',
      calculatedSha256: f.sha256,
      sourceContentHash: f.sha256,
      uploadedByUserId: f.actorUserId,
    });
    const created = await runtime.createConversation(ctx, run);
    expect(created.clientId).toBe(f.clientId);
    const create = p.tx.clioConversation.create.mock.calls[0]![0].data;
    expect(create.title).toBe(`${f.namespace} case46 ${run}`);
    expect(create.messages).toBeUndefined();
    expect(create.artifacts).toBeUndefined();
    await expect(runtime.createSource(ctx, run)).rejects.toThrow('not_new_and_ready');
    expect(p.send).toHaveBeenCalledTimes(1);
    await runtime.close();
    await expect(runtime.createConversation(ctx, run)).rejects.toThrow('closed');
  } finally {
    await runtime.close();
  }
  expect(p.disconnect).toHaveBeenCalledTimes(1);
});

it('honors actual scanner-required configuration and retains the blocked source without indexing', async () => {
  const p = ports();
  process.env.ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED = 'true';
  const runtime = await createCase46SetupDependencies();
  try {
    await expect(runtime.createSource(ctx, run)).rejects.toThrow('not_new_and_ready');
    expect([...p.rows.values()][0]).toMatchObject({
      lifecycleStatus: 'blocked',
      scanStatus: 'failed',
    });
    expect(p.index).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
  }
});

it('refuses current foreign actor and real runtime disabled posture before document writes', async () => {
  const p = ports();
  const runtime = await createCase46SetupDependencies();
  try {
    await expect(runtime.createSource({ ...ctx, userId: 'foreign' }, run)).rejects.toThrow(
      'actor_denied',
    );
  } finally {
    await runtime.close();
  }
  expect(p.send).not.toHaveBeenCalled();
  process.env.ENGAGEMENT_EXTERNAL_ACTIONS = 'disabled';
  await expect(createCase46SetupDependencies()).rejects.toThrow();
  expect(p.send).not.toHaveBeenCalled();
});
