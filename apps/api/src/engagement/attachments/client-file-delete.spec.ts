import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  requireOwnerActor,
  requireOwnerClient,
} from '../../clients/client-ordered-owner.access.js';
import { lockFileAccessRows } from '../../clients/client-file-access-authority.js';
import {
  assertFileKeyNotDeleted,
  deleteClientFile,
  readClientFileDelete,
  type ClientFileDeleteOwner,
} from './client-file-delete.js';
import { clientFileDeleteDigest, parseClientFileDelete } from './client-file-delete.input.js';
import { inspectFileDeleteObject, removeFileDeleteObject } from './client-file-delete.storage.js';

jest.mock('../../clients/client-ordered-owner.access.js', () => ({
  requireOwnerActor: jest.fn(),
  requireOwnerClient: jest.fn(),
}));
jest.mock('../../clients/client-file-access-authority.js', () => ({
  lockFileAccessRows: jest.fn(),
}));
jest.mock('./client-file-delete.storage.js', () => ({
  inspectFileDeleteObject: jest.fn(),
  removeFileDeleteObject: jest.fn(),
}));

type Row = Record<string, any>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-delete-owner',
  role: 'standard_user',
} as TenantContext;
const clientId = id(3),
  attachmentId = id(4),
  requestId = id(5);
const timestamp = '2026-10-25T00:00:00.000Z';
const input = () => ({ schemaVersion: 1, requestId, clientId, expectedRevision: 3 });
const clone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value), (key, v) =>
    ['createdAt', 'completedAt'].includes(key) && v ? new Date(v) : v,
  );

function harness() {
  jest.clearAllMocks();
  const state = {
    file: {
      id: attachmentId,
      tenantId: ctx.tenantId,
      clientId,
      prospectId: null,
      meetingId: null,
      mailMessageId: null,
      bucket: 'synthetic-bucket',
      s3Key: 'synthetic-client/reviewed.txt',
      metadataRevision: 3,
      lifecycleStatus: 'ready',
      sourceEntityType: null,
      sharedAt: new Date(timestamp),
      sharedByUserId: ctx.userId,
    } as Row | null,
    receipts: [] as Row[],
    chunks: ['synthetic-indexed-chunk'],
    audits: [] as Row[],
  };
  const controls = {
    member: true,
    role: ctx.role,
    client: true,
    wall: true,
    viewer: true,
    parents: true,
    loseDelete: false,
    failAudit: false,
    phantomPending: false,
    phantomComplete: false,
    afterInspect: undefined as undefined | (() => void),
    afterRemove: undefined as undefined | (() => void),
    afterCommit: undefined as undefined | ((kind: string) => void),
    beforeTransaction: undefined as undefined | ((number: number) => void),
    afterFileLock: undefined as undefined | (() => void),
  };
  const events: Array<{ kind: string; transaction: number; status?: string }> = [];
  let transaction = 0,
    activeTransaction = 0;
  const actor = jest.mocked(requireOwnerActor).mockImplementation(async (_tx, actorCtx) => {
    if (!controls.member || actorCtx.role !== controls.role)
      throw new ForbiddenException('Account owner access denied');
  });
  const client = jest
    .mocked(requireOwnerClient)
    .mockImplementation(async (tx, actorCtx, selected) => {
      await actor(tx, actorCtx);
      if (!controls.client || !controls.wall || selected !== clientId)
        throw new NotFoundException('Client not found');
      return { version: 0, primary: null };
    });
  const access = jest
    .mocked(lockFileAccessRows)
    .mockImplementation(async (tx, actorCtx, selected) => {
      await client(tx, actorCtx, selected, false, false, 'share');
      controls.afterFileLock?.();
      await actor(tx, actorCtx);
      if (!controls.viewer) throw new NotFoundException('A reviewed file is unavailable');
      return [];
    });
  const unpack = (args: any[]) =>
    Array.isArray(args[0])
      ? { sql: args[0].join('?'), values: args.slice(1) }
      : { sql: args[0].sql, values: args[0].values };
  const makeTx = (working: typeof state, number: number) => ({
    working,
    engagementAttachment: {
      findFirst: jest.fn(async ({ where, select }: Row) => {
        const row = working.file;
        if (!row || row.id !== where.id || row.tenantId !== where.tenantId) return null;
        return clone(Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])));
      }),
      delete: jest.fn(async ({ where }: Row) => {
        if (working.file?.id !== where.id) throw new Error('Attachment missing');
        const row = working.file;
        working.file = null;
        return row;
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: Row) => {
        if (controls.failAudit) throw new Error('Audit insert failed');
        working.audits.push(clone(data));
        return data;
      }),
    },
    $queryRaw: async (...args: any[]) => {
      const { sql, values: v } = unpack(args);
      if (sql.includes('pg_advisory')) return [];
      if (sql.includes('SELECT EXISTS'))
        return [
          {
            present: working.receipts.some(
              (row) =>
                row.tenantId === v[0] && row.object.bucket === v[1] && row.object.key === v[2],
            ),
          },
        ];
      if (sql.includes('FROM client_file_deletions')) {
        const rows = working.receipts.filter(
          (row) => row.tenantId === v[0] && row.actorUserId === v[1] && row.requestId === v[2],
        );
        events.push({ kind: 'receipt-read', transaction: number, status: rows[0]?.status });
        return clone(rows.map(({ tenantId: _tenant, actorUserId: _actor, ...row }) => row));
      }
      if (sql.includes('UPDATE engagement_attachments')) {
        const row = working.file;
        if (!row || row.tenantId !== v[0] || row.id !== v[1] || row.metadataRevision !== v[2])
          return [];
        row.lifecycleStatus = 'delete_pending';
        row.sharedAt = null;
        row.sharedByUserId = null;
        row.metadataRevision += 1;
        events.push({ kind: 'claim', transaction: number });
        return [{ revision: row.metadataRevision }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    $executeRaw: async (...args: any[]) => {
      const { sql, values: v } = unpack(args);
      if (sql.includes('pg_advisory')) return 1;
      if (sql.includes('INSERT INTO client_file_deletions')) {
        working.receipts.push({
          tenantId: v[0],
          actorUserId: v[1],
          requestId: v[2],
          clientId: v[3],
          attachmentId: v[4],
          payloadDigest: v[5],
          command: JSON.parse(v[6]),
          source: JSON.parse(v[7]),
          object: JSON.parse(v[8]),
          claimedRevision: v[9],
          status: 'pending',
          createdAt: new Date(timestamp),
          completedAt: null,
        });
        return 1;
      }
      if (sql.includes('UPDATE client_file_deletions')) {
        const row = working.receipts.find(
          (r) =>
            r.tenantId === v[0] &&
            r.actorUserId === v[1] &&
            r.requestId === v[2] &&
            r.status === 'pending',
        );
        if (!row) return 0;
        row.status = 'completed';
        row.completedAt = new Date(timestamp);
        return 1;
      }
      throw new Error(`Unexpected write: ${sql}`);
    },
  });
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (tx: any) => Promise<any>) => {
      const number = ++transaction;
      controls.beforeTransaction?.(number);
      const before = clone(state),
        working = clone(state);
      activeTransaction = number;
      let result;
      try {
        result = await fn(makeTx(working, number));
      } catch (error) {
        events.push({ kind: 'rollback', transaction: number });
        throw error;
      } finally {
        activeTransaction = 0;
      }
      const pending = working.receipts.length > before.receipts.length;
      const completed = working.receipts.some(
        (row, i) => row.status === 'completed' && before.receipts[i]?.status !== 'completed',
      );
      const kind = pending ? 'pending' : completed ? 'completed' : 'read';
      if (!(pending && controls.phantomPending) && !(completed && controls.phantomComplete))
        Object.assign(state, working);
      events.push({ kind: `commit-${kind}`, transaction: number });
      controls.afterCommit?.(kind);
      return result;
    }),
  };
  const retainedObject = {
    bucket: state.file!.bucket,
    key: state.file!.s3Key,
    etag: '"reviewed-etag"',
  };
  const inspect = jest.mocked(inspectFileDeleteObject).mockImplementation(async () => {
    expect(activeTransaction).toBe(0);
    events.push({ kind: 'inspect', transaction: 0 });
    controls.afterInspect?.();
    return clone(retainedObject);
  });
  const remove = jest.mocked(removeFileDeleteObject).mockImplementation(async () => {
    expect(activeTransaction).toBe(0);
    events.push({ kind: 'remove', transaction: 0 });
    controls.afterRemove?.();
    if (controls.loseDelete) throw new Error('Lost storage response');
  });
  const parents = jest.fn(async () => {
    if (!controls.parents) throw new NotFoundException('File parent unavailable');
  });
  const purgeChunks = jest.fn(async (tx: any, tenant: string, attachment: string) => {
    expect([tenant, attachment]).toEqual([ctx.tenantId, attachmentId]);
    tx.working.chunks = [];
    events.push({ kind: 'purge', transaction: activeTransaction });
  });
  const owner = {
    prisma,
    s3: {},
    bucket: retainedObject.bucket,
    parents,
    purgeChunks,
  } as unknown as ClientFileDeleteOwner;
  return {
    state,
    controls,
    events,
    owner,
    prisma,
    inspect,
    remove,
    actor,
    client,
    access,
    parents,
    purgeChunks,
    retainedObject,
    save: (raw: unknown = input()) => deleteClientFile(owner, ctx, attachmentId, raw),
    read: (readCtx = ctx, selected = requestId) => readClientFileDelete(owner, readCtx, selected),
    guardKey: (bucket = retainedObject.bucket, key = retainedObject.key, guardCtx = ctx) =>
      prisma.withTenant(guardCtx.tenantId, (tx) =>
        assertFileKeyNotDeleted(tx, guardCtx, bucket, key),
      ),
  };
}

test('canonical commands produce the same digest independently of input property order', () => {
  const command = parseClientFileDelete(attachmentId, input());
  const reordered = parseClientFileDelete(attachmentId, {
    expectedRevision: 3,
    clientId,
    requestId,
    schemaVersion: 1,
  });
  expect(command).toEqual({ ...input(), attachmentId });
  expect(clientFileDeleteDigest(ctx, command)).toMatch(/^[a-f0-9]{64}$/);
  expect(clientFileDeleteDigest(ctx, reordered)).toBe(clientFileDeleteDigest(ctx, command));
  for (const changed of [
    { ...command, clientId: id(6) },
    { ...command, attachmentId: id(6) },
    { ...command, requestId: id(6) },
    { ...command, expectedRevision: 4 },
  ])
    expect(clientFileDeleteDigest(ctx, changed)).not.toBe(clientFileDeleteDigest(ctx, command));
  for (const changed of [
    { ...ctx, tenantId: id(6) },
    { ...ctx, userId: id(6) },
  ])
    expect(clientFileDeleteDigest(changed, command)).not.toBe(clientFileDeleteDigest(ctx, command));
});

test.each([
  null,
  [],
  {},
  { ...input(), extra: true },
  { ...input(), attachmentId },
  { ...input(), schemaVersion: 2 },
  { ...input(), expectedRevision: '3' },
  { ...input(), expectedRevision: -1 },
  { ...input(), expectedRevision: 1.5 },
  { ...input(), expectedRevision: 2_147_483_647 },
  { ...input(), requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
  { ...input(), clientId: ` ${clientId}` },
])(
  'invalid or noncanonical delete input rejects before authority or provider work: %j',
  async (raw) => {
    const h = harness();
    await expect(h.save(raw)).rejects.toMatchObject({ status: 400 });
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  },
);

test('invalid attachment and receipt UUIDs reject before opening a transaction', async () => {
  const h = harness();
  await expect(deleteClientFile(h.owner, ctx, 'not-a-uuid', input())).rejects.toMatchObject({
    status: 400,
  });
  await expect(h.read(ctx, 'not-a-uuid')).rejects.toMatchObject({ status: 400 });
  expect(h.prisma.withTenant).not.toHaveBeenCalled();
});

test('persists and independently reads the claim before deletion, then atomically removes metadata and chunks', async () => {
  const h = harness();
  h.controls.afterRemove = () => {
    expect(h.state.file).toMatchObject({
      lifecycleStatus: 'delete_pending',
      metadataRevision: 4,
      sharedAt: null,
      sharedByUserId: null,
    });
    expect(h.state.receipts[0]).toMatchObject({
      status: 'pending',
      object: h.retainedObject,
      claimedRevision: 4,
    });
    expect(h.state.chunks).toEqual([]);
    const committed = h.events.find((event) => event.kind === 'commit-pending')!;
    expect(
      h.events.some(
        (event) =>
          event.kind === 'receipt-read' &&
          event.status === 'pending' &&
          event.transaction > committed.transaction,
      ),
    ).toBe(true);
    // A concurrent indexer may have produced another chunk since the claim.
    h.state.chunks.push('synthetic-late-chunk');
  };
  const result = await h.save();
  expect(result).toMatchObject({
    status: 'completed',
    expectedRevision: 3,
    result: { attachmentId, objectAbsent: true, indexedChunksAbsent: true },
  });
  expect(h.remove).toHaveBeenCalledWith(h.owner.s3, h.retainedObject);
  expect(h.state.file).toBeNull();
  expect(h.state.chunks).toEqual([]);
  expect(h.purgeChunks).toHaveBeenCalledTimes(2);
  expect(h.state.audits).toHaveLength(1);
  expect(h.state.audits[0]).toMatchObject({
    action: 'client.file.deleted',
    entityId: attachmentId,
    requestId,
  });
  expect(h.access).toHaveBeenCalledWith(
    expect.anything(),
    ctx,
    clientId,
    [attachmentId],
    'distribute',
  );
  expect(await h.read()).toEqual(result);
});

test('completed replay returns the retained result without inspecting or deleting storage again', async () => {
  const h = harness(),
    completed = await h.save();
  expect(await h.save()).toEqual(completed);
  expect(h.inspect).toHaveBeenCalledTimes(1);
  expect(h.remove).toHaveBeenCalledTimes(1);
  expect(h.state.audits).toHaveLength(1);
});

test('reused request with a different command conflicts before additional storage work', async () => {
  const h = harness();
  h.controls.loseDelete = true;
  await expect(h.save()).rejects.toThrow('Lost storage response');
  await expect(h.save({ ...input(), expectedRevision: 4 })).rejects.toMatchObject({ status: 409 });
  expect(h.inspect).toHaveBeenCalledTimes(1);
  expect(h.remove).toHaveBeenCalledTimes(1);
});

test.each(['member', 'client', 'wall', 'viewer', 'parents'] as const)(
  'current %s denial prevents inspection, claim, and deletion',
  async (key) => {
    const h = harness();
    h.controls[key] = false;
    await expect(h.save()).rejects.toMatchObject({ status: key === 'member' ? 403 : 404 });
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.state.receipts).toEqual([]);
  },
);

test.each(['member', 'viewer', 'revision'] as const)(
  'rechecks %s after object inspection before retaining a claim',
  async (key) => {
    const h = harness();
    h.controls.afterInspect = () => {
      if (key === 'revision') h.state.file!.metadataRevision += 1;
      else h.controls[key] = false;
    };
    await expect(h.save()).rejects.toMatchObject({
      status: key === 'member' ? 403 : key === 'viewer' ? 404 : 409,
    });
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.state.receipts).toEqual([]);
  },
);

test('rechecks current actor after a file authority lock wait', async () => {
  const h = harness();
  h.controls.afterFileLock = () => {
    h.controls.member = false;
  };
  await expect(h.save()).rejects.toMatchObject({ status: 403 });
  expect(h.inspect).not.toHaveBeenCalled();
});

test('a stale reviewed revision rejects before object inspection', async () => {
  const h = harness();
  await expect(h.save({ ...input(), expectedRevision: 2 })).rejects.toMatchObject({ status: 409 });
  expect(h.inspect).not.toHaveBeenCalled();
  expect(h.remove).not.toHaveBeenCalled();
  expect(h.state.receipts).toEqual([]);
});

test.each(['member', 'viewer', 'revision'] as const)(
  'rechecks %s on an exact pending retry before provider deletion',
  async (key) => {
    const h = harness();
    h.controls.loseDelete = true;
    await expect(h.save()).rejects.toThrow('Lost storage response');
    if (key === 'revision') h.state.file!.metadataRevision += 1;
    else h.controls[key] = false;
    await expect(h.save()).rejects.toMatchObject({
      status: key === 'member' ? 403 : key === 'viewer' ? 404 : 409,
    });
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.state.receipts[0]!.status).toBe('pending');
  },
);

test.each(['member', 'wall'] as const)(
  'completed receipt read and replay require current %s authority',
  async (key) => {
    const h = harness();
    await h.save();
    h.controls[key] = false;
    await expect(h.read()).rejects.toMatchObject({ status: key === 'member' ? 403 : 404 });
    await expect(h.save()).rejects.toMatchObject({ status: key === 'member' ? 403 : 404 });
    expect(h.remove).toHaveBeenCalledTimes(1);
  },
);

test('receipt lookup remains scoped to the original tenant and actor', async () => {
  const h = harness();
  await h.save();
  await expect(h.read({ ...ctx, tenantId: id(8) })).rejects.toMatchObject({ status: 404 });
  await expect(h.read({ ...ctx, userId: id(8) })).rejects.toMatchObject({ status: 404 });
});

test.each(['phantomPending', 'phantomComplete'] as const)(
  '%s callback success cannot stand in for committed state',
  async (key) => {
    const h = harness();
    h.controls[key] = true;
    await expect(h.save()).rejects.toMatchObject({ status: 503 });
    if (key === 'phantomPending') {
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.state.receipts).toEqual([]);
      expect(h.state.file?.lifecycleStatus).toBe('ready');
      expect(h.state.chunks).toHaveLength(1);
    } else {
      expect(h.remove).toHaveBeenCalledTimes(1);
      expect((await h.read()).status).toBe('pending');
      expect(h.state.file?.lifecycleStatus).toBe('delete_pending');
      expect(h.state.audits).toEqual([]);
    }
  },
);

test.each(['pending', 'completed'])(
  'mismatched %s persisted snapshot is unresolved',
  async (kind) => {
    const h = harness();
    h.controls.afterCommit = (committed) => {
      if (committed === kind) h.state.receipts[0]!.object.key = 'unexpected-retained-key';
    };
    await expect(h.save()).rejects.toMatchObject({ status: 503 });
    expect(h.remove).toHaveBeenCalledTimes(kind === 'pending' ? 0 : 1);
  },
);

test('a changed command and digest in the committed proof are unresolved, not request reuse', async () => {
  const h = harness();
  h.controls.afterCommit = (kind) => {
    if (kind !== 'pending') return;
    h.state.receipts[0]!.command.expectedRevision = 4;
    h.state.receipts[0]!.payloadDigest = 'f'.repeat(64);
  };
  await expect(h.save()).rejects.toMatchObject({ status: 503 });
  expect(h.remove).not.toHaveBeenCalled();
});

test.each([false, true])(
  'completion before independent readback accepts only the original claim under current authority (identity changed: %s)',
  async (identityChanged) => {
    const h = harness();
    h.controls.afterCommit = (kind) => {
      if (kind !== 'pending') return;
      h.state.receipts[0]!.status = 'completed';
      h.state.receipts[0]!.completedAt = new Date(timestamp);
      h.state.file = null;
      if (identityChanged) h.state.receipts[0]!.object.key = 'unexpected-completed-key';
    };
    if (identityChanged) await expect(h.save()).rejects.toMatchObject({ status: 503 });
    else {
      expect((await h.save()).status).toBe('completed');
      h.controls.wall = false;
      await expect(h.save()).rejects.toMatchObject({ status: 404 });
    }
    expect(h.remove).not.toHaveBeenCalled();
  },
);

test('missing completed readback does not report success', async () => {
  const h = harness();
  h.controls.afterCommit = (kind) => {
    if (kind === 'completed') h.state.receipts = [];
  };
  await expect(h.save()).rejects.toMatchObject({ status: 503 });
  expect(h.remove).toHaveBeenCalledTimes(1);
});

test('lost provider acknowledgment retains the exact claim and retry does not inspect a new object', async () => {
  const h = harness();
  h.controls.loseDelete = true;
  await expect(h.save()).rejects.toThrow('Lost storage response');
  const pending = await h.read(),
    retained = clone(h.state.receipts[0]!);
  expect(pending).toMatchObject({ status: 'pending', completedAt: null, result: null });
  expect(h.state.chunks).toEqual([]);
  expect(h.state.file?.lifecycleStatus).toBe('delete_pending');
  expect(h.state.audits).toEqual([]);
  h.controls.loseDelete = false;
  expect(await h.save()).toMatchObject({
    status: 'completed',
    payloadDigest: pending.payloadDigest,
  });
  expect(h.inspect).toHaveBeenCalledTimes(1);
  expect(h.remove.mock.calls.map(([, object]) => object)).toEqual([
    retained.object,
    retained.object,
  ]);
  expect(h.state.receipts[0]!.source).toEqual(retained.source);
});

test('pending retry can finish after metadata removal, while retaining current client authority', async () => {
  const h = harness();
  h.controls.loseDelete = true;
  await expect(h.save()).rejects.toThrow('Lost storage response');
  h.state.file = null;
  h.state.chunks = ['synthetic-late-chunk'];
  h.controls.wall = false;
  await expect(h.save()).rejects.toMatchObject({ status: 404 });
  expect(h.remove).toHaveBeenCalledTimes(1);
  h.controls.wall = true;
  h.controls.loseDelete = false;
  expect((await h.save()).status).toBe('completed');
  expect(h.state.file).toBeNull();
  expect(h.state.chunks).toEqual([]);
});

test.each(['member', 'viewer'] as const)(
  'authority revoked during provider work leaves a pending result for recovery: %s',
  async (key) => {
    const h = harness();
    h.controls.afterRemove = () => {
      h.controls[key] = false;
    };
    await expect(h.save()).rejects.toMatchObject({ status: key === 'member' ? 403 : 404 });
    expect(h.state.receipts[0]!.status).toBe('pending');
    expect(h.state.file?.lifecycleStatus).toBe('delete_pending');
    expect(h.state.audits).toEqual([]);
  },
);

test('final transaction failure preserves pending metadata for a later exact retry', async () => {
  const h = harness();
  h.controls.failAudit = true;
  await expect(h.save()).rejects.toThrow('Audit insert failed');
  expect((await h.read()).status).toBe('pending');
  expect(h.state.file?.lifecycleStatus).toBe('delete_pending');
  h.controls.failAudit = false;
  expect((await h.save()).status).toBe('completed');
  expect(h.inspect).toHaveBeenCalledTimes(1);
  expect(h.state.audits).toHaveLength(1);
});

test('a concurrent completion before the provider recheck short-circuits storage deletion', async () => {
  const h = harness();
  let concurrentCompleted = false;
  h.controls.beforeTransaction = () => {
    const committedClaim = h.events.find((event) => event.kind === 'commit-pending');
    const lastEvent = h.events.at(-1);
    if (
      concurrentCompleted ||
      !committedClaim ||
      lastEvent?.kind !== 'commit-read' ||
      lastEvent.transaction <= committedClaim.transaction
    )
      return;
    concurrentCompleted = true;
    h.state.receipts[0]!.status = 'completed';
    h.state.receipts[0]!.completedAt = new Date(timestamp);
    h.state.file = null;
  };
  expect((await h.save()).status).toBe('completed');
  expect(h.remove).not.toHaveBeenCalled();
});

test.each(['pending', 'completed'])(
  'a %s deletion retires only its exact tenant, bucket, and upload key',
  async (status) => {
    const h = harness();
    if (status === 'pending') {
      h.controls.loseDelete = true;
      await expect(h.save()).rejects.toThrow('Lost storage response');
    } else await h.save();
    await expect(h.guardKey()).rejects.toMatchObject({ status: 409 });
    await expect(h.guardKey('different-bucket')).resolves.toBeUndefined();
    await expect(h.guardKey(undefined, 'different-key')).resolves.toBeUndefined();
    await expect(
      h.guardKey(undefined, undefined, { ...ctx, tenantId: id(8) }),
    ).resolves.toBeUndefined();
    await expect(h.guardKey(undefined, undefined, { ...ctx, userId: id(8) })).rejects.toMatchObject(
      { status: 409 },
    );
  },
);
