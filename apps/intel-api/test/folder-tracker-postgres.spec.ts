import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { FolderImportService } from '../src/tracker/folders/folder-import.service.js';
import type { WorkspaceTenantContext } from '../src/auth/tenant-context.js';

// The CI job supplies disposable PostgreSQL. No skipped database tests.
describe('folder tracker PostgreSQL isolation and replay', () => {
  const prisma = new PrismaService();
  const source = new FolderSourceDataRepository(prisma);
  const svc = new FolderTrackerService(prisma, source, new SourceDataRepository(prisma));
  const importer = new FolderImportService(svc);
  const tenant = randomUUID(),
    foreign = randomUUID(),
    suffix = randomUUID().slice(0, 8);
  const actor = 'folder_owner_' + suffix,
    other = 'folder_other_' + suffix;
  const ctx: WorkspaceTenantContext = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' };
  let folderId: string, secondId: string;
  const billIds = ['fl-2099-hb2', 'fl-2099-hb10', 'fl-2099-hb101'];
  const aliasBills = [
    ['fl-2097-h0027', 'FL', '2097', 'H0027'],
    ['fl-2097-s0028', 'FL', '2097', 'S0028'],
    ['fl-2097-hcb27', 'FL', '2097', 'HCB27'],
    ['fl-2096-h0027', 'FL', '2096', 'H0027'],
    ['ga-2097-h0027', 'GA', '2097', 'H0027'],
  ];
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Disposable DATABASE_URL is required');
    await prisma.$connect();
    await prisma.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES (${tenant}::uuid,${'folder-' + suffix},'Synthetic folder tenant'),(${foreign}::uuid,${'foreign-' + suffix},'Synthetic foreign tenant')`;
      for (const clerk of [actor, other]) {
        const uid = randomUUID();
        await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES (${uid}::uuid,${clerk},${clerk + '@example.invalid'})`;
        await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES (${tenant}::uuid,${uid}::uuid,'standard_user','active')`;
      }
      for (const [index, id] of billIds.entries())
        await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES (${id},'FL','2099 Regular Session','2099',${'HB ' + [2, 10, 101][index]},${'hb' + [2, 10, 101][index]},${'Synthetic measure ' + index}) ON CONFLICT(id) DO NOTHING`;
      for (const [id, state, session, number] of aliasBills)
        await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES (${id},${state},${session},${session},${number},${number!.toLowerCase()},'Synthetic alias measure') ON CONFLICT(id) DO NOTHING`;
    });
    folderId = (await svc.create(ctx, { name: 'Duplicate name' })).id;
    secondId = (await svc.create(ctx, { name: 'Duplicate name' })).id;
  }, 30000);
  afterAll(async () => {
    await prisma.withSystem(async (tx) => {
      await tx.legiWatchSourceMapping.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchImportItem.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchImportRun.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchStagedConfiguration.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchFolderBill.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchFolder.deleteMany({ where: { tenantId: tenant } });
      await tx.$executeRawUnsafe('DELETE FROM state_bill WHERE id = ANY($1::text[])', aliasBills.map(([id]) => id));
      await tx.$executeRaw`DELETE FROM tenant_memberships WHERE tenant_id=${tenant}::uuid`;
      await tx.$executeRaw`DELETE FROM users WHERE clerk_user_id IN (${actor},${other})`;
      await tx.$executeRaw`DELETE FROM tenants WHERE id IN (${tenant}::uuid,${foreign}::uuid)`;
    });
    await prisma.$disconnect();
  });
  it('resolves Florida display aliases to existing IDs with session and proposal boundaries', async () => {
    const rows = await svc.resolve({ jurisdiction: 'FL', sessionKey: '2097', billNumbers: 'HB 0027, H27, SB28, HCB27, SAB28, GOS27, BUC27, WMC27' });
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'duplicate', 'resolved', 'resolved', 'unresolved', 'unresolved', 'unresolved', 'unresolved']);
    expect(rows[0]?.bill?.id).toBe('fl-2097-h0027');
    expect(rows[2]?.bill?.id).toBe('fl-2097-s0028');
    expect(rows[3]?.bill?.id).toBe('fl-2097-hcb27');
    expect((await svc.resolve({ jurisdiction: 'FL', sessionKey: '2096', billNumbers: 'HB27' }))[0]?.bill?.id).toBe('fl-2096-h0027');
    expect((await svc.resolve({ jurisdiction: 'GA', sessionKey: '2097', billNumbers: 'HB27' }))[0]?.status).toBe('unresolved');
    expect((await svc.board(ctx, { jurisdiction: 'FL', sessionKey: '2097', q: 'HB 0027' }, true)).rows.map((b) => b.id)).toEqual(['fl-2097-h0027']);
  });
  it('requires reconciliation if two canonical IDs share a Florida alias', async () => {
    const id = 'fl-2097-hb27';
    await prisma.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES (${id},'FL','2097','2097','HB27','hb27','Synthetic duplicate identity')`;
    try {
      const [row] = await svc.resolve({ jurisdiction: 'FL', sessionKey: '2097', billNumbers: 'HB27' });
      expect(row?.status).toBe('ambiguous');
      expect(row?.bill).toBeNull();
    } finally {
      await prisma.$executeRaw`DELETE FROM state_bill WHERE id=${id}`;
    }
  });
  it('preserves duplicate folder names and rejects a foreign folder reference', async () => {
    expect(folderId).not.toBe(secondId);
    await expect(svc.context({ ...ctx, tenantId: foreign }, folderId, billIds[0]!)).rejects.toThrow(
      'FOLDER_NOT_FOUND',
    );
  });
  it('adds idempotently without creating alert-eligible tracked rows', async () => {
    const before = await prisma.trackedBill.count({ where: { tenantId: tenant } });
    expect(
      (await svc.bulk(ctx, folderId, { action: 'add', billIds })).results.every(
        (r) => r.status === 'added',
      ),
    ).toBe(true);
    expect(
      (await svc.bulk(ctx, folderId, { action: 'add', billIds })).results.every(
        (r) => r.status === 'already_present',
      ),
    ).toBe(true);
    expect(await prisma.trackedBill.count({ where: { tenantId: tenant } })).toBe(before);
  });
  it('sorts bill numbers naturally across pages with exact totals and scoped cursors', async () => {
    const query = { folderId, jurisdiction: 'FL', sessionKey: '2099', limit: 1 };
    const one = await svc.board(ctx, query);
    expect(one.total).toBe(3);
    expect(one.rows[0]?.number).toBe('HB 2');
    const two = await svc.board(ctx, { ...query, cursor: one.nextCursor! });
    expect(two.rows[0]?.number).toBe('HB 10');
    await expect(
      svc.board(ctx, { ...query, folderId: secondId, cursor: one.nextCursor! }),
    ).rejects.toThrow('CURSOR_SCOPE_CHANGED');
    expect((await svc.board(ctx, { ...query, q: 'measure 2' })).total).toBe(1);
  });
  it('maintains independent folder context and detects stale edits', async () => {
    await svc.bulk(ctx, secondId, { action: 'add', billIds: [billIds[0]!] });
    await svc.updateContext(ctx, folderId, billIds[0]!, {
      expectedVersion: 0,
      topPriority: true,
      importance: 'high',
      position: 'oppose',
      internalComments: '=HYPERLINK("private")',
      externalComments: 'Line 1\nLine 2',
    });
    expect((await svc.context(ctx, secondId, billIds[0]!)).assignment?.topPriority).toBe(false);
    await expect(
      svc.updateContext(ctx, folderId, billIds[0]!, {
        expectedVersion: 0,
        topPriority: false,
        importance: 'normal',
        position: 'none',
        internalComments: 'stale',
        externalComments: '',
      }),
    ).rejects.toThrow('CONTEXT_CHANGED_RELOAD');
  });
  it('exports exactly selected rows with separate comment opt-ins and formula safety', async () => {
    const a = (await svc.context(ctx, folderId, billIds[0]!)).assignment!;
    const base = {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      scope: 'selected' as const,
      selectedIds: [a.id],
      includeInternalComments: false,
      includeExternalComments: true,
    };
    const out = await svc.export(ctx, base);
    expect(out.count).toBe(1);
    expect(out.csv).not.toContain('HYPERLINK');
    expect(out.csv).toContain('Line 1\nLine 2');
    expect((await svc.export(ctx, { ...base, includeInternalComments: true })).csv).toContain(
      "'=HYPERLINK",
    );
  });
  it('enforces other-user read-only across edits and bulk removal', async () => {
    const f = (await svc.list(ctx)).find((f) => f.id === secondId)!;
    await svc.update(ctx, secondId, {
      name: f.name,
      otherUserAccess: 'read_only',
      expectedVersion: f.version,
    });
    const result = await svc.bulk({ ...ctx, clerkUserId: other, role: 'org:member' }, secondId, {
      action: 'remove',
      billIds: [billIds[0]!],
    });
    expect(result.results[0]?.status).toBe('not_permitted');
    expect(
      (await svc.bulk(ctx, secondId, { action: 'remove', billIds: [billIds[0]!] })).results[0]
        ?.status,
    ).toBe('removed');
    expect((await svc.context(ctx, folderId, billIds[0]!)).assignment).not.toBeNull();
  });
  it('previews unprovisioned ownership as blocked and stages configuration without provisioning', async () => {
    const preview = await importer.preview(ctx, {
      targetTenantId: tenant,
      sourceAccount: 'synthetic-account',
      captureId: 'capture-1',
      sourceHash: 'a'.repeat(64),
      mappingManifest: {
        tenantId: tenant,
        sourceAccount: 'synthetic-account',
        sourceTimezone: null,
        owners: {},
        clients: {},
        sessions: { '2099': { jurisdiction: 'FL', sessionKey: '2099' } },
      },
      items: [
        {
          kind: 'folder',
          sourceId: 'source-folder-1',
          payload: {
            name: 'Unresolved folder',
            form_owner_id: 'unprovisioned',
            other_user_access: 'read_and_change',
          },
        },
        {
          kind: 'user',
          sourceId: 'source-user-1',
          payload: { name: 'Synthetic staged user', email: 'staged@example.invalid' },
        },
      ],
    });
    expect(preview.items.find((i) => i.kind === 'folder')?.status).toBe('blocked');
    const stagedUser = preview.items.find((i) => i.kind === 'user')!;
    const applied = await importer.apply(ctx, preview.run.id, {
      targetTenantId: tenant,
      mappingHash: preview.run.mappingHash,
      itemIds: [stagedUser.id],
    });
    expect(applied.items.find((i) => i.id === stagedUser.id)?.status).toBe('applied');
    await importer.apply(ctx, preview.run.id, {
      targetTenantId: tenant,
      mappingHash: preview.run.mappingHash,
      itemIds: [stagedUser.id],
    });
    expect(
      await prisma.legiWatchStagedConfiguration.count({
        where: { tenantId: tenant, kind: 'user' },
      }),
    ).toBe(1);
    expect(
      await prisma.$queryRaw<
        Array<{ n: number }>
      >`SELECT count(*)::int AS n FROM users WHERE email='staged@example.invalid'`,
    ).toEqual([{ n: 0 }]);
  });
  it('rejects non-admin and cross-tenant import attempts', async () => {
    await expect(importer.runs({ ...ctx, role: 'org:member' })).rejects.toThrow(
      'IMPORT_REQUIRES_TENANT_ADMIN',
    );
    await expect(
      importer.apply(ctx, randomUUID(), {
        targetTenantId: foreign,
        mappingHash: 'a'.repeat(64),
        itemIds: [randomUUID()],
      }),
    ).rejects.toThrow('IMPORT_TARGET_MISMATCH');
  });
});
