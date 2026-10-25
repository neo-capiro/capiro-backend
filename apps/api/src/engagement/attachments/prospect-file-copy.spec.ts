import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { TenantContext } from '@capiro/shared';
import {
  copyProspectFile,
  readProspectFileCopy,
  type ProspectFileCopyOwner,
} from './prospect-file-copy.js';

type Row = Record<string, any>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-copy-owner',
  role: 'standard_user',
} as TenantContext;
const prospectId = id(3),
  clientId = id(4),
  timestamp = '2026-10-25T00:00:00.000Z';
const bytes = Buffer.from('Synthetic reviewed upload'),
  checksum = createHash('sha256').update(bytes).digest('hex');
const input = () => ({
  schemaVersion: 1,
  requestId: id(5),
  prospectId,
  clientId,
  sourceId: id(6),
  expectedProspectUpdatedAt: timestamp,
  expectedRevision: 3,
  checksumSha256: checksum,
  contentLength: bytes.length,
  folder: 'Reviewed',
});
const clone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value), (key, v) =>
    ['createdAt', 'completedAt'].includes(key) && v ? new Date(v) : v,
  );
function harness() {
  const source: Row = {
    id: id(6),
    tenantId: ctx.tenantId,
    prospectId,
    clientId: null,
    meetingId: null,
    mailMessageId: null,
    uploadedByUserId: ctx.userId,
    source: 'manual',
    fileName: 'Reviewed.txt',
    contentType: 'text/plain',
    bucket: 'synthetic-bucket',
    s3Key: 'synthetic-source',
    byteSize: bytes.length,
    calculatedSha256: checksum,
    lifecycleStatus: 'ready',
    scanStatus: 'clean',
    metadataRevision: 3,
    supersededByAttachmentId: null,
    viewerMode: 'restricted',
    viewerUserIds: [ctx.userId],
  };
  const state = { source: source as Row | null, destinations: [] as Row[], receipts: [] as Row[] };
  const controls = {
    member: true,
    role: 'standard_user',
    wall: true,
    client: true,
    feature: true,
    converted: true,
    linked: clientId,
    prospectTime: timestamp,
    upload: true,
    ready: true,
    losePut: false,
    failInsert: false,
    phantomPending: false,
    phantomComplete: false,
    loseCompletedResponse: false,
    afterPut: undefined as undefined | (() => void),
    scan: 'clean',
    afterSourceLock: undefined as undefined | (() => void),
  };
  const unpack = (args: any[]) =>
    Array.isArray(args[0])
      ? { sql: args[0].join('?'), v: args.slice(1) }
      : { sql: args[0].sql, v: args[0].values };
  const member = () => (controls.member ? { role: controls.role } : null);
  const tx: any = {
    tenantMembership: {
      findFirst: async ({ where }: Row) =>
        where.tenantId === ctx.tenantId &&
        where.userId === ctx.userId &&
        where.user.clerkUserId === ctx.clerkUserId
          ? member()
          : null,
    },
    engagementAttachment: {
      findFirst: async ({ where }: Row) => {
        if (where.id === source.id) {
          const row = state.source;
          return row &&
            where.tenantId === row.tenantId &&
            where.prospectId === row.prospectId &&
            row.source === 'manual' &&
            row.lifecycleStatus === 'ready' &&
            row.supersededByAttachmentId === null &&
            row.clientId === null &&
            row.meetingId === null &&
            row.mailMessageId === null &&
            (row.viewerMode === 'all' ||
              row.uploadedByUserId === ctx.userId ||
              row.viewerUserIds.includes(ctx.userId))
            ? clone(row)
            : null;
        }
        return (
          state.destinations.find(
            (row) =>
              row.id === where.id &&
              row.tenantId === where.tenantId &&
              row.clientId === where.clientId,
          ) ?? null
        );
      },
      create: async ({ data }: Row) => {
        if (controls.failInsert) throw Error('Destination insert failed');
        const row = { ...data, metadataRevision: 0 };
        state.destinations.push(row);
        return row;
      },
    },
    prospectAttachmentUploadIntent: {
      findFirst: async ({ where }: Row) =>
        controls.upload &&
        where.confirmedAttachmentId === source.id &&
        where.checksumSha256 === checksum
          ? { id: id(8) }
          : null,
    },
    $queryRawUnsafe: async (sql: string, ...v: any[]) => {
      if (sql.includes('FROM business_development_prospects'))
        return [{ linkedClientId: controls.linked, status: 'active', dismissedAt: null }];
      if (sql.includes('FROM tenants'))
        return [
          { settings: { clioFeatureFlags: { 'businessDevelopment.enabled': controls.feature } } },
        ];
      if (sql.includes('FROM tenant_memberships'))
        return controls.member ? [{ userId: ctx.userId, clerkUserId: ctx.clerkUserId }] : [];
      if (sql.includes('SELECT (NOT c.memory_wall')) return [{ allowed: controls.wall }];
      if (sql.includes('FROM clients'))
        return controls.client ? [{ status: 'active', memoryWall: false }] : [];
      if (sql.includes('set_config')) return [];
      throw Error(`Unexpected query ${sql} ${v.length}`);
    },
    $queryRaw: async (...args: any[]) => {
      const { sql, v } = unpack(args);
      if (sql.includes('pg_advisory')) {
        expect(sql).toContain('::text');
        return [];
      }
      if (sql.includes('FROM prospect_attachment_copies'))
        return clone(
          state.receipts.filter(
            (row) => row.tenantId === v[0] && row.actorUserId === v[1] && row.requestId === v[2],
          ),
        );
      if (sql.includes('FROM business_development_prospects'))
        return v[0] === ctx.tenantId && v[1] === prospectId
          ? [
              {
                updatedAt: new Date(controls.prospectTime),
                convertedAt: controls.converted ? new Date(timestamp) : null,
                clientId: controls.linked,
              },
            ]
          : [];
      if (sql.includes('account_owner_version'))
        return controls.client && v[1] === clientId ? [{ version: 0, primary: null }] : [];
      if (sql.includes('FROM tenant_memberships tm')) return member() ? [member()] : [];
      if (sql.includes('FROM client_memory_access')) return [];
      if (sql.includes('FROM engagement_attachments')) {
        controls.afterSourceLock?.();
        return state.source ? [{ id: source.id }] : [];
      }
      throw Error(`Unexpected query ${sql}`);
    },
    $executeRaw: async (...args: any[]) => {
      const { sql, v } = unpack(args);
      if (sql.includes('INSERT INTO prospect_attachment_copies')) {
        state.receipts.push({
          tenantId: v[0],
          actorUserId: v[1],
          requestId: v[2],
          prospectId: v[3],
          clientId: v[4],
          payloadDigest: v[5],
          command: JSON.parse(v[6]),
          source: JSON.parse(v[7]),
          destinationId: v[8],
          bucket: v[9],
          key: v[10],
          status: 'pending',
          result: null,
          createdAt: new Date(timestamp),
          completedAt: null,
        });
        return 1;
      }
      if (sql.includes('UPDATE prospect_attachment_copies')) {
        const row = state.receipts.find(
          (r) => r.tenantId === v[1] && r.actorUserId === v[2] && r.requestId === v[3],
        )!;
        row.status = 'completed';
        row.result = JSON.parse(v[0]);
        row.completedAt = new Date(timestamp);
        return 1;
      }
      throw Error(`Unexpected write ${sql}`);
    },
  };
  const prisma = {
    withTenantUser: async (_tenant: string, _actor: string, fn: (tx: any) => Promise<any>) => {
      const before = clone(state);
      let result;
      try {
        result = await fn(tx);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
      const createdPending = state.receipts.length > before.receipts.length;
      const completed = state.receipts.some(
        (row, i) => row.status === 'completed' && before.receipts[i]?.status !== 'completed',
      );
      if ((createdPending && controls.phantomPending) || (completed && controls.phantomComplete))
        Object.assign(state, before);
      if (completed && controls.loseCompletedResponse) throw Error('Lost completed response');
      return result;
    },
  };
  const objects = new Map<string, Row>();
  const send = jest.fn(async (command: any) => {
    if (command instanceof GetObjectCommand)
      return { Body: Readable.from([bytes]), ContentLength: bytes.length };
    if (command instanceof PutObjectCommand) {
      if (objects.has(command.input.Key!))
        throw Object.assign(Error('exists'), { name: 'PreconditionFailed' });
      objects.set(command.input.Key!, {
        ContentLength: bytes.length,
        ContentType: command.input.ContentType,
        ChecksumSHA256: command.input.ChecksumSHA256,
        Metadata: command.input.Metadata,
      });
      controls.afterPut?.();
      if (controls.losePut) throw Error('Lost storage response');
      return {};
    }
    if (command instanceof HeadObjectCommand) return objects.get(command.input.Key!)!;
    throw Error('Unexpected provider operation');
  });
  const owner = {
    prisma,
    s3: { send },
    bucket: source.bucket,
    content: {
      readiness: () => ({ usable: controls.ready }),
      detectContentType: () => 'text/plain',
      contentTypeConflicts: (a: string, b: string) => a !== b,
    },
    scanner: {
      getStatus: async () => controls.scan,
      scanRequired: true,
      providerName: 'synthetic',
    },
    allowedType: (value: string) => value === 'text/plain',
  } as unknown as ProspectFileCopyOwner;
  return {
    state,
    controls,
    send,
    objects,
    owner,
    save: (raw: unknown = input()) => copyProspectFile(owner, ctx, raw),
    read: () => readProspectFileCopy(owner, ctx, id(5)),
  };
}
test('commits an independent restricted copy and exact lineage without modifying source', async () => {
  const h = harness(),
    original = clone(h.state.source),
    result = await h.save();
  expect(result).toMatchObject({
    status: 'completed',
    available: true,
    sourceId: id(6),
    expectedRevision: 3,
  });
  expect(h.state.source).toEqual(original);
  expect(h.state.destinations).toHaveLength(1);
  expect(h.state.destinations[0]).toMatchObject({
    clientId,
    prospectId: null,
    uploadedByUserId: ctx.userId,
    viewerMode: 'restricted',
    viewerUserIds: [ctx.userId],
    sharedAt: null,
    sharedByUserId: null,
    folder: 'Reviewed',
    sourceEntityType: 'prospect_upload_copy',
    sourceEntityId: id(6),
    sourceVersion: 3,
    sourceContentHash: checksum,
  });
  expect(h.state.destinations[0]!.s3Key).not.toBe(original!.s3Key);
  expect(await h.save()).toEqual(result);
  expect(h.send).toHaveBeenCalledTimes(2);
});
test.each(['member', 'client', 'wall', 'feature', 'converted', 'upload', 'ready'])(
  'current %s denial prevents any storage effect',
  async (key) => {
    const h = harness();
    (h.controls as any)[key] = false;
    await expect(h.save()).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.state.receipts).toHaveLength(0);
  },
);
test.each(['expectedRevision', 'checksumSha256', 'contentLength', 'expectedProspectUpdatedAt'])(
  'changed %s refuses before storage',
  async (field) => {
    const h = harness(),
      raw: any = input();
    raw[field] =
      field === 'checksumSha256'
        ? 'a'.repeat(64)
        : field === 'expectedProspectUpdatedAt'
          ? '2026-10-24T00:00:00.000Z'
          : raw[field] + 1;
    await expect(h.save(raw)).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  },
);
test('an unknown PUT result retains pending identity and recovers only the recorded object', async () => {
  const h = harness();
  h.controls.losePut = true;
  await expect(h.save()).rejects.toThrow('Lost storage response');
  const pending = await h.read();
  expect(pending.status).toBe('pending');
  expect(h.state.destinations).toHaveLength(0);
  expect(h.objects.size).toBe(1);
  h.controls.losePut = false;
  const result = await h.save();
  expect(result.destinationId).toBe(pending.destinationId);
  expect(result.status).toBe('completed');
  expect(h.objects.size).toBe(1);
});
test('failed destination insert preserves the external pending copy for exact retry', async () => {
  const h = harness();
  h.controls.failInsert = true;
  await expect(h.save()).rejects.toThrow('Destination insert failed');
  expect((await h.read()).status).toBe('pending');
  expect(h.state.destinations).toHaveLength(0);
  expect(h.objects.size).toBe(1);
  h.controls.failInsert = false;
  expect((await h.save()).status).toBe('completed');
  expect(h.objects.size).toBe(1);
});
test.each(['phantomPending', 'phantomComplete'])(
  'deferred %s rollback cannot be mistaken for a persisted result',
  async (key) => {
    const h = harness();
    (h.controls as any)[key] = true;
    await expect(h.save()).rejects.toMatchObject({ status: 503 });
    expect(h.state.destinations).toHaveLength(0);
    if (key === 'phantomPending') {
      expect(h.send).not.toHaveBeenCalled();
      expect(h.state.receipts).toHaveLength(0);
    } else {
      expect((await h.read()).status).toBe('pending');
      expect(h.objects.size).toBe(1);
    }
  },
);
test.each(['member', 'wall'])(
  'rechecks %s after provider work before admitting any destination',
  async (key) => {
    const h = harness();
    h.controls.afterPut = () => {
      (h.controls as any)[key] = false;
    };
    await expect(h.save()).rejects.toThrow();
    expect(h.state.destinations).toHaveLength(0);
    expect(h.state.receipts[0]!.status).toBe('pending');
  },
);
test('rechecks current membership after the selected source lock wait', async () => {
  const h = harness();
  h.controls.afterSourceLock = () => {
    h.controls.member = false;
  };
  await expect(h.save()).rejects.toMatchObject({ status: 403 });
  expect(h.send).not.toHaveBeenCalled();
});
test('lost completion response replays after source removal and never recreates a deleted destination', async () => {
  const h = harness();
  h.controls.loseCompletedResponse = true;
  await expect(h.save()).rejects.toThrow('Lost completed response');
  h.controls.loseCompletedResponse = false;
  h.state.source = null;
  h.state.destinations = [];
  const result = await h.save();
  expect(result).toMatchObject({ status: 'completed', available: false });
  expect(await h.read()).toEqual(result);
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(h.state.destinations).toHaveLength(0);
});
test('changed manifest with a retained request cannot adopt its prior copy', async () => {
  const h = harness();
  await h.save();
  await expect(h.save({ ...input(), folder: 'Different' })).rejects.toMatchObject({ status: 409 });
  expect(h.send).toHaveBeenCalledTimes(2);
});
test('a pending or blocked scanner is recorded honestly without widening the private audience', async () => {
  const h = harness();
  h.controls.scan = 'pending';
  expect((await h.save()).result).toMatchObject({
    lifecycleStatus: 'quarantined',
    scanStatus: 'pending',
  });
  expect(h.state.destinations[0]!.viewerUserIds).toEqual([ctx.userId]);
});
