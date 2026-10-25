import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { commitFileAccess, getFileAccessReceipt } from './client-file-access-command.js';
import { fileAccessDigest, parseFileAccessCommand } from './client-file-access-input.js';
import { readHearingRecordDocumentAccess } from '../engagement/hearing-record-document-access.js';

jest.mock('../engagement/hearing-record-document-access.js', () => ({
  readHearingRecordDocumentAccess: jest.fn(),
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-file-actor',
  role: 'standard_user',
} as TenantContext;
const clientId = id(3);
const command = () => ({
  schemaVersion: 1,
  requestId: id(4),
  clientId,
  operation: 'folder-access',
  folder: 'Reviewed',
  files: [
    { id: id(5), expectedRevision: 1 },
    { id: id(6), expectedRevision: 1 },
  ],
  viewerMode: 'restricted',
  viewerUserIds: [id(7)],
});
type Row = Record<string, any>;
function harness() {
  const state = {
    files: [5, 6, 8].map((n) => ({
      id: id(n),
      clientId,
      tenantId: ctx.tenantId,
      prospectId: null,
      fileName: 'Synthetic.txt',
      folder: 'Reviewed',
      metadataRevision: 1,
      viewerMode: 'all',
      viewerUserIds: [] as string[],
      uploadedByUserId: null,
      sourceEntityType: null as string | null,
      sourceEntityId: null as string | null,
      lifecycleStatus: 'ready',
    })),
    receipts: new Map<string, Row>(),
    audits: 0,
    writes: 0,
  };
  const controls = {
    member: true,
    wall: true,
    client: true,
    role: 'standard_user',
    viewers: [id(7)],
    failAudit: false,
    failReceipt: false,
    lostCommit: false,
    failUpdate: undefined as string | undefined,
    casMiss: undefined as string | undefined,
    afterFileLock: undefined as (() => void) | undefined,
    afterRollback: undefined as (() => Promise<void>) | undefined,
  };
  const statements: Array<{ sql: string; values: any[] }> = [];
  const key = (tenant: string, actor: string, request: string) =>
    JSON.stringify([tenant, actor, request]);
  const unpack = (args: any[]) =>
    Array.isArray(args[0])
      ? { sql: args[0].join('?'), values: args.slice(1) }
      : { sql: args[0].sql, values: args[0].values };
  const tx = {
    tenantMembership: {
      findFirst: async ({ where }: Row) =>
        controls.member &&
        where.tenantId === ctx.tenantId &&
        where.userId === ctx.userId &&
        where.user.clerkUserId === ctx.clerkUserId
          ? { role: controls.role }
          : null,
    },
    $queryRawUnsafe: async () => [{ allowed: controls.wall }],
    auditLog: {
      create: async () => {
        if (controls.failAudit) throw new Error('audit unavailable');
        state.audits++;
      },
    },
    $queryRaw: async (...args: any[]) => {
      const { sql, values: v } = unpack(args);
      statements.push({ sql, values: v });
      if (sql.includes('pg_advisory')) {
        if (!sql.includes('::text')) throw new Error('Prisma cannot deserialize void');
        return [{ lock: '' }];
      }
      if (sql.includes('FROM client_file_access_receipts')) {
        const row = state.receipts.get(key(v[0], v[1], v[2]));
        return row ? [structuredClone(row)] : [];
      }
      if (sql.includes('FROM engagement_attachments')) {
        const rows = state.files
          .filter(
            (row) =>
              row.tenantId === v[0] &&
              row.clientId === v[1] &&
              !row.prospectId &&
              v[2].includes(row.id),
          )
          .sort((a, b) => a.id.localeCompare(b.id));
        if (sql.includes('FOR UPDATE')) controls.afterFileLock?.();
        return structuredClone(rows);
      }
      if (sql.includes('UPDATE engagement_attachments')) {
        if (v[4] === controls.failUpdate) throw new Error('update unavailable');
        if (v[4] === controls.casMiss) return [];
        const row = state.files.find((item) => item.id === v[4])!;
        expect(row.metadataRevision).toBe(v[5]);
        if (row.viewerMode !== v[0] || JSON.stringify(row.viewerUserIds) !== JSON.stringify(v[1]))
          row.metadataRevision++;
        row.viewerMode = v[0];
        row.viewerUserIds = [...v[1]];
        state.writes++;
        return [{ revision: row.metadataRevision }];
      }
      if (sql.includes('FROM tenant_memberships tm JOIN users'))
        return controls.member ? [{ role: controls.role }] : [];
      if (sql.includes('FROM tenant_memberships') && sql.includes('ORDER BY user_id'))
        return controls.viewers
          .filter((userId) => v[1].includes(userId))
          .map((userId) => ({ userId }));
      if (sql.includes('FROM clients') && sql.includes('account_owner_version'))
        return controls.client ? [{ version: 0, primary: null }] : [];
      if (sql.includes('FOR SHARE')) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    $executeRaw: async (...args: any[]) => {
      const { sql, values: v } = unpack(args);
      statements.push({ sql, values: v });
      if (sql.includes('pg_advisory') || sql.includes('set_config')) return 1;
      if (!sql.includes('INSERT INTO client_file_access_receipts'))
        throw new Error('Unexpected insert');
      if (controls.failReceipt) throw new Error('receipt unavailable');
      state.receipts.set(key(v[0], v[1], v[2]), {
        requestId: v[2],
        clientId: v[3],
        payloadDigest: v[4],
        operation: v[5],
        status: v[6],
        result: v[7] ? JSON.parse(v[7]) : null,
        createdAt: new Date('2026-10-25T01:00:00.000Z'),
      });
      return 1;
    },
  };
  const withTenant = jest.fn(async (_tenant: string, run: (tx: Row) => Promise<unknown>) => {
    const before = structuredClone(state);
    let result;
    try {
      result = await run(tx);
    } catch (error) {
      Object.assign(state, before);
      const callback = controls.afterRollback;
      controls.afterRollback = undefined;
      await callback?.();
      throw error;
    }
    if (controls.lostCommit) {
      controls.lostCommit = false;
      throw new Error('committed response lost');
    }
    return result;
  });
  return {
    state,
    controls,
    statements,
    tx,
    withTenant,
    prisma: { withTenant } as unknown as PrismaService,
  };
}

beforeEach(() => {
  jest.mocked(readHearingRecordDocumentAccess).mockReset();
});
describe('reviewed file access command', () => {
  test('writes only the reviewed manifest and stores one atomic historical result', async () => {
    const h = harness();
    const result = await commitFileAccess(h.prisma, ctx, clientId, command());
    expect(result).toMatchObject({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      status: 'completed',
      result: { files: [5, 6].map((n) => ({ id: id(n), previousRevision: 1, revision: 2 })) },
    });
    expect(h.state.files[2]).toMatchObject({ metadataRevision: 1, viewerMode: 'all' });
    expect(h.state.audits).toBe(1);
    expect(h.state.receipts.size).toBe(1);
    h.state.files = [];
    await expect(commitFileAccess(h.prisma, ctx, clientId, command())).resolves.toEqual(result);
    await expect(getFileAccessReceipt(h.prisma, ctx, clientId, id(4))).resolves.toEqual(result);
    expect(h.state.writes).toBe(2);
    expect(h.state.audits).toBe(1);
  });
  test('self-removing ACL remains recoverable without granting a new file read', async () => {
    const h = harness();
    const result = await commitFileAccess(h.prisma, ctx, clientId, command());
    await expect(getFileAccessReceipt(h.prisma, ctx, clientId, id(4))).resolves.toEqual(result);
    const next = await commitFileAccess(h.prisma, ctx, clientId, {
      ...command(),
      requestId: id(10),
    });
    expect(next.status).toBe('refused');
    expect(h.state.writes).toBe(2);
  });
  test.each(['failAudit', 'failReceipt'] as const)(
    '%s rolls back files and leaves request retryable',
    async (control) => {
      const h = harness();
      h.controls[control] = true;
      await expect(commitFileAccess(h.prisma, ctx, clientId, command())).rejects.toThrow(
        'unavailable',
      );
      expect(h.state.writes).toBe(0);
      expect(h.state.receipts.size).toBe(0);
      expect(h.state.audits).toBe(0);
      h.controls[control] = false;
      await expect(commitFileAccess(h.prisma, ctx, clientId, command())).resolves.toMatchObject({
        status: 'completed',
      });
    },
  );
  test('a late second-file storage failure rolls back the whole manifest', async () => {
    const h = harness();
    h.controls.failUpdate = id(6);
    await expect(commitFileAccess(h.prisma, ctx, clientId, command())).rejects.toThrow(
      'update unavailable',
    );
    expect(h.state.writes).toBe(0);
    expect(h.state.receipts.size).toBe(0);
    expect(h.state.files.every((row) => row.metadataRevision === 1)).toBe(true);
  });
  test('a late CAS miss stores a no-write refusal after rollback', async () => {
    const h = harness();
    h.controls.casMiss = id(6);
    const result = await commitFileAccess(h.prisma, ctx, clientId, command());
    expect(result).toMatchObject({
      status: 'refused',
      result: null,
      refusal: { code: 'FILE_ACCESS_REFUSED' },
    });
    expect(h.state.writes).toBe(0);
    expect(h.state.audits).toBe(0);
    h.controls.casMiss = undefined;
    await expect(commitFileAccess(h.prisma, ctx, clientId, command())).resolves.toEqual(result);
    expect(h.state.writes).toBe(0);
  });
  test('the concurrent retry committed after rollback wins over refusal recording', async () => {
    const h = harness();
    h.controls.casMiss = id(6);
    h.controls.afterRollback = async () => {
      h.controls.casMiss = undefined;
      await commitFileAccess(h.prisma, ctx, clientId, command());
    };
    await expect(commitFileAccess(h.prisma, ctx, clientId, command())).resolves.toMatchObject({
      status: 'completed',
    });
    expect(h.state.audits).toBe(1);
    expect(h.state.receipts.size).toBe(1);
  });
  test('a lost committed response is recovered without applying access twice', async () => {
    const h = harness();
    h.controls.lostCommit = true;
    await expect(commitFileAccess(h.prisma, ctx, clientId, command())).rejects.toThrow(
      'response lost',
    );
    await expect(commitFileAccess(h.prisma, ctx, clientId, command())).resolves.toMatchObject({
      status: 'completed',
    });
    expect(h.state.writes).toBe(2);
    expect(h.state.audits).toBe(1);
  });
  test('a conflicting retry cannot overwrite a completed outcome', async () => {
    const h = harness();
    await commitFileAccess(h.prisma, ctx, clientId, command());
    await expect(
      commitFileAccess(h.prisma, ctx, clientId, { ...command(), folder: 'Other' }),
    ).rejects.toThrow('another file access');
    expect(h.state.receipts.size).toBe(1);
    expect(h.state.writes).toBe(2);
  });
  test.each(['revision', 'folder', 'deleted', 'prospect', 'private', 'lifecycle', 'viewer'])(
    '%s change refuses the reviewed set without touching any row',
    async (change) => {
      const h = harness();
      if (change === 'revision') h.state.files[1]!.metadataRevision++;
      if (change === 'folder') h.state.files[1]!.folder = 'Moved';
      if (change === 'deleted') h.state.files.splice(1, 1);
      if (change === 'prospect') (h.state.files[1] as Row).prospectId = id(9);
      if (change === 'private') h.state.files[1]!.viewerMode = 'restricted';
      if (change === 'lifecycle') h.state.files[1]!.lifecycleStatus = 'delete_pending';
      if (change === 'viewer') h.controls.viewers = [];
      await expect(commitFileAccess(h.prisma, ctx, clientId, command())).resolves.toMatchObject({
        status: 'refused',
      });
      expect(h.state.writes).toBe(0);
    },
  );
  test.each(['member', 'wall', 'role'] as const)(
    'current %s authority is required even for receipt lookup',
    async (control) => {
      const h = harness();
      await commitFileAccess(h.prisma, ctx, clientId, command());
      if (control === 'role') h.controls.role = 'read_only';
      else h.controls[control] = false;
      await expect(getFileAccessReceipt(h.prisma, ctx, clientId, id(4))).rejects.toThrow();
      await expect(commitFileAccess(h.prisma, ctx, clientId, command())).rejects.toThrow();
      expect(h.state.receipts.size).toBe(1);
      expect(h.state.writes).toBe(2);
    },
  );
  test('post-file-lock authority loss cannot become a durable success or refusal', async () => {
    const h = harness();
    h.controls.afterFileLock = () => {
      h.controls.member = false;
    };
    await expect(commitFileAccess(h.prisma, ctx, clientId, command())).rejects.toThrow();
    expect(h.state.writes).toBe(0);
    expect(h.state.receipts.size).toBe(0);
  });
  test('wrong actor, tenant or client cannot recover another outcome', async () => {
    const h = harness();
    await commitFileAccess(h.prisma, ctx, clientId, command());
    for (const [actor, target] of [
      [{ ...ctx, userId: id(90) }, clientId],
      [{ ...ctx, tenantId: id(91) }, clientId],
      [ctx, id(92)],
    ] as const)
      await expect(getFileAccessReceipt(h.prisma, actor, target, id(4))).rejects.toThrow();
  });
  test('source-bound hearing access is rechecked under the established source locks', async () => {
    const h = harness();
    Object.assign(h.state.files[0]!, {
      sourceEntityType: 'hearing_record_brief',
      sourceEntityId: 'synthetic',
    });
    const access = { eventId: 'synthetic-event', accessLocks: { folders: [], observation: null } };
    jest
      .mocked(readHearingRecordDocumentAccess)
      .mockResolvedValueOnce(access as never)
      .mockResolvedValueOnce({ ...access, eventId: 'changed' } as never);
    await expect(commitFileAccess(h.prisma, ctx, clientId, command())).resolves.toMatchObject({
      status: 'refused',
    });
    expect(h.state.writes).toBe(0);
    const source = h.statements.findIndex((entry) =>
      entry.sql.includes('legiwatch-published-record-commit-v1'),
    );
    const files = h.statements.findIndex(
      (entry) =>
        entry.sql.includes('FROM engagement_attachments') && entry.sql.includes('FOR UPDATE'),
    );
    expect(source).toBeGreaterThan(-1);
    expect(files).toBeGreaterThan(source);
    expect(
      jest
        .mocked(readHearingRecordDocumentAccess)
        .mock.calls.every((call) => call[3] === 'distribute'),
    ).toBe(true);
  });
});

describe('strict access manifest', () => {
  test('canonical order is stable and bound to actor and tenant', () => {
    const parsed = parseFileAccessCommand(clientId, command());
    const reordered = parseFileAccessCommand(clientId, {
      ...command(),
      files: [...command().files].reverse(),
      folder: ' Reviewed ',
    });
    expect(parsed).toEqual(reordered);
    expect(fileAccessDigest(ctx, parsed)).toBe(fileAccessDigest(ctx, reordered));
    expect(fileAccessDigest({ ...ctx, userId: id(90) }, parsed)).not.toBe(
      fileAccessDigest(ctx, parsed),
    );
  });
  test.each([
    { extra: true },
    { clientId: id(90) },
    { files: [] },
    { files: [command().files[0], command().files[0]] },
    { files: [{ id: id(5), expectedRevision: -1 }] },
    { files: [{ id: id(5), expectedRevision: 2_147_483_647 }] },
    { files: [{ id: id(5), expectedRevision: 1, extra: true }] },
    { operation: 'file-access' },
    { operation: 'move' },
    { viewerUserIds: [id(7), id(7)] },
    { viewerMode: 'all' },
    {
      files: Array.from({ length: 101 }, (_, index) => ({
        id: id(100 + index),
        expectedRevision: 1,
      })),
    },
  ])(
    'rejects an unreviewable or ambiguous command %# before opening a transaction',
    async (invalid) => {
      const h = harness();
      await expect(
        commitFileAccess(h.prisma, ctx, clientId, { ...command(), ...invalid }),
      ).rejects.toThrow('Invalid reviewed');
      expect(h.withTenant).not.toHaveBeenCalled();
    },
  );
});
