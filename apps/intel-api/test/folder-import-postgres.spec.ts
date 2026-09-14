import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { FolderImportService } from '../src/tracker/folders/folder-import.service.js';
import { FolderReportService } from '../src/tracker/folders/folder-report.service.js';
import type { WorkspaceTenantContext } from '../src/auth/tenant-context.js';
import type { FolderImportItemDto } from '../src/tracker/folders/folder-import.dto.js';

describe('folder import PostgreSQL recovery and database permissions', () => {
  const prisma = new PrismaService(),
    tenant = randomUUID(),
    foreign = randomUUID(),
    suffix = randomUUID().slice(0, 8);
  const actor = 'import_owner_' + suffix,
    other = 'import_other_' + suffix,
    role = 'phase1_rls_' + suffix;
  const ctx: WorkspaceTenantContext = {
    tenantId: tenant,
    clerkUserId: actor,
    role: 'capiro_admin',
  };
  const source = new FolderSourceDataRepository(prisma),
    folders = new FolderTrackerService(prisma, source, new SourceDataRepository(prisma));
  const imports = new FolderImportService(folders),
    reports = new FolderReportService(folders, imports);
  const bill = 'fl-2098-hb42';
  const manifest = {
    tenantId: tenant,
    sourceAccount: 'synthetic-' + suffix,
    sourceTimezone: null,
    owners: { owner: actor },
    clients: {},
    sessions: { '2098': { jurisdiction: 'FL', sessionKey: '2098' } },
  };
  const rawFolder = {
    name: 'Synthetic priority',
    form_owner_id: 'owner',
    other_user_access: 'read_and_change',
    form_default_session: 'Current Lobbytools Session',
    form_archived: false,
  };
  const preview = (
    capture: string,
    items: FolderImportItemDto[],
    mapping: Record<string, unknown> = manifest,
  ) =>
    imports.preview(ctx, {
      targetTenantId: tenant,
      sourceAccount: manifest.sourceAccount,
      captureId: capture,
      sourceHash: capture.padEnd(64, '0'),
      mappingManifest: mapping,
      items,
    });
  const apply = async (p: Awaited<ReturnType<typeof preview>>) => {
    // Parent folders first; checkpointed assignment/staged application follows.
    for (const item of [...p.items].sort(
      (a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder'),
    ))
      await imports.apply(ctx, p.run.id, {
        targetTenantId: tenant,
        mappingHash: p.run.mappingHash,
        itemIds: [item.id],
      });
    return imports.reconcile(ctx, p.run.id);
  };
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Disposable PostgreSQL required');
    await prisma.$connect();
    await prisma.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES (${tenant}::uuid,${'import-' + suffix},'Synthetic'),(${foreign}::uuid,${'other-' + suffix},'Synthetic other')`;
      for (const user of [actor, other]) {
        const uid = randomUUID();
        await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${uid}::uuid,${user},${user + '@example.invalid'})`;
        await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${uid}::uuid,'standard_user','active')`;
      }
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber,description) VALUES(${bill},'FL','2098','2098','HB 42','hb42','Synthetic healthcare bill','lower','Structured source summary') ON CONFLICT(id) DO NOTHING`;
      await tx.$executeRaw`DELETE FROM state_bill_action WHERE bill_key=${bill}`;
      for (const [day, order] of [
        ['2098-06-21', 1],
        ['2098-06-22', 2],
        ['2098-06-26', 3],
        ['2098-06-27', 4],
      ] as const)
        await tx.$executeRaw`INSERT INTO state_bill_action(bill_key,date,text,order_key) VALUES(${bill},${day}::date,${'Action ' + order},${order})`;
      await tx.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
      await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.$executeRawUnsafe(`GRANT SELECT ON users,tenant_memberships,clients TO ${role}`);
      await tx.$executeRawUnsafe(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON intel_legiwatch_folder,intel_legiwatch_folder_bill,intel_legiwatch_staged_configuration TO ${role}`,
      );
    });
  }, 30000);
  afterAll(async () => {
    await prisma.withSystem(async (tx) => {
      await tx.legiWatchImportItem.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchSourceMapping.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchImportRun.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchStagedConfiguration.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchFolderBill.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchFolder.deleteMany({ where: { tenantId: tenant } });
      await tx.$executeRaw`DELETE FROM tenant_memberships WHERE tenant_id=${tenant}::uuid`;
      await tx.$executeRaw`DELETE FROM users WHERE clerk_user_id IN (${actor},${other})`;
      await tx.$executeRaw`DELETE FROM tenants WHERE id IN (${tenant}::uuid,${foreign}::uuid)`;
      await tx.$executeRawUnsafe(`DROP OWNED BY ${role}`);
      await tx.$executeRawUnsafe(`DROP ROLE ${role}`);
    });
    await prisma.$disconnect();
  });
  it('reconciles later snapshots by durable source ID and detects mapping-only changes', async () => {
    const items: FolderImportItemDto[] = [{ kind: 'folder', sourceId: 'f1', payload: rawFolder }];
    const first = await apply(await preview('a', items)),
      id = first.items[0]!.targetId!;
    const same = await apply(await preview('b', items));
    expect(same.items[0]?.status).toBe('unchanged');
    expect(same.items[0]?.targetId).toBe(id);
    const changed = await apply(
      await preview('c', items, { ...manifest, owners: { owner: other } }),
    );
    expect(changed.items[0]?.status).toBe('applied');
    expect((await folders.list(ctx)).find((f) => f.id === id)?.ownerClerkId).toBe(other);
    expect(await prisma.legiWatchFolder.count({ where: { tenantId: tenant } })).toBe(1);
  });
  it('preserves a private edit across changed snapshots, pause/resume and interruption', async () => {
    const items: FolderImportItemDto[] = [
      { kind: 'folder', sourceId: 'f2', payload: rawFolder },
      {
        kind: 'assignment',
        sourceId: 'f2:2098:source42',
        payload: {
          folder_id: 'f2',
          session: '2098',
          bill_number: 'HB 42',
          top_priority: true,
          importance: 'HIGH',
          position: 'OPPOSE',
          internal_comments: 'Imported',
          external_comments: 'Two\nlines',
        },
      },
    ];
    const p = await preview('d', items);
    const f = p.items.find((i) => i.kind === 'folder')!;
    await imports.apply(ctx, p.run.id, {
      targetTenantId: tenant,
      mappingHash: p.run.mappingHash,
      itemIds: [f.id],
    });
    const resumed = await apply(p);
    const assignment = resumed.items.find((i) => i.kind === 'assignment')!;
    expect(assignment.status).toBe('applied');
    const target = await prisma.legiWatchFolderBill.findUniqueOrThrow({
      where: { id: assignment.targetId! },
    });
    await folders.updateContext(ctx, target.folderId, bill, {
      expectedVersion: 0,
      topPriority: false,
      importance: 'normal',
      position: 'support',
      internalComments: 'Staff edit',
      externalComments: '',
    });
    const again = await apply(await preview('e', items));
    expect(again.items.find((i) => i.kind === 'assignment')?.status).toBe('conflict');
    expect((await folders.context(ctx, target.folderId, bill)).assignment?.internalComments).toBe(
      'Staff edit',
    );
    await imports.pause(ctx, p.run.id, true);
    await expect(
      imports.apply(ctx, p.run.id, {
        targetTenantId: tenant,
        mappingHash: p.run.mappingHash,
        itemIds: [f.id],
      }),
    ).rejects.toThrow('IMPORT_RUN_PAUSED');
    await imports.pause(ctx, p.run.id, false);
    await apply(p);
    expect(
      await prisma.legiWatchFolderBill.count({
        where: { tenantId: tenant, folderId: target.folderId },
      }),
    ).toBe(1);
  });
  it('compensates untouched staging and retains post-import edits', async () => {
    const p = await apply(
      await preview('f', [
        { kind: 'contact', sourceId: 'contact1', payload: { name: 'Synthetic' } },
        { kind: 'contact', sourceId: 'contact2', payload: { name: 'Synthetic edited' } },
      ]),
    );
    const edited = p.items.find((i) => i.sourceId === 'contact2')!;
    await prisma.legiWatchStagedConfiguration.update({
      where: { id: edited.targetId! },
      data: { version: 1, payload: { name: 'Local edit' } },
    });
    const input = {
      targetTenantId: tenant,
      mappingHash: p.run.mappingHash,
      itemIds: p.items.map((i) => i.id),
    };
    await expect(imports.compensate(ctx, p.run.id, input)).rejects.toThrow(
      'PAUSE_RUN_BEFORE_COMPENSATION',
    );
    await imports.pause(ctx, p.run.id, true);
    const out = await imports.compensate(ctx, p.run.id, input);
    expect(out.items.find((i) => i.sourceId === 'contact1')?.status).toBe('compensated');
    expect(out.items.find((i) => i.sourceId === 'contact2')?.status).toBe('compensation_conflict');
    expect(
      (
        await prisma.legiWatchStagedConfiguration.findUniqueOrThrow({
          where: { id: edited.targetId! },
        })
      ).payload,
    ).toEqual({ name: 'Local edit' });
  });
  it('previews the captured report semantics with inclusive date-only boundaries and no internal notes', async () => {
    const p = await preview('1', [
      {
        kind: 'assignment',
        sourceId: 'report:2098:42',
        payload: {
          folder_id: 'report-folder',
          folder_name: 'Synthetic report folder',
          session: '2098',
          bill_number: 'HB 42',
          top_priority: false,
          importance: 'OFF',
          position: 'OFF',
          internal_comments: 'MUST NOT LEAK',
          report_bill_comments: 'No comments.',
        },
      },
      {
        kind: 'report',
        sourceId: 'synthetic-report',
        payload: {
          name: 'Synthetic Acadia settings',
          folder_ids: ['report-folder'],
          session: '2098',
          committee_references: 'Off:',
          actions: 'Last 5 Days Actions:',
          related_bills: 'Off:',
          show_summary: true,
          order: 'Last action date',
          bill_link_access: 'Only LobbyTools subscribers can view bill links',
          other_checked_flags: [],
        },
      },
    ]);
    const reportItem = p.items.find((i) => i.kind === 'report')!;
    const reportPayload = (await imports.details(ctx, p.run.id, reportItem.id)).payload as any;
    await prisma.legiWatchImportItem.update({
      where: { id: reportItem.id },
      data: {
        payload: {
          ...reportPayload,
          raw: {
            ...reportPayload.raw,
            captured_folder_counts: [{ folder_id: 'report-folder', session: '2098', count: 1 }],
          },
        },
      },
    });
    const out = await reports.preview(ctx, p.run.id, 'synthetic-report', '2098-06-26');
    expect(out.complete).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.actions.map((a) => a.date)).toEqual(['2098-06-26', '2098-06-22']);
    expect(out.rows[0]?.summary).toBe('Structured source summary');
    expect(JSON.stringify(out)).not.toContain('MUST NOT LEAK');
    expect(out.rows[0]?.reportCommentObservation).toBeNull();
    await expect(
      reports.preview({ ...ctx, tenantId: foreign }, p.run.id, 'synthetic-report', '2098-06-26'),
    ).rejects.toThrow('REPORT_NOT_FOUND');
    await prisma.legiWatchImportItem.update({
      where: { id: reportItem.id },
      data: {
        payload: {
          ...reportPayload,
          raw: {
            ...reportPayload.raw,
            captured_folder_counts: [{ folder_id: 'report-folder', session: '2098', count: 11 }],
          },
        },
      },
    });
    const partial = await reports.preview(ctx, p.run.id, 'synthetic-report', '2098-06-26');
    expect(partial.complete).toBe(false);
    expect(partial.expectedAssignments).toBe(11);
    expect(partial.exceptions).toEqual([
      { sourceId: 'report-folder', reason: 'Captured 11 assignments; import contains 1' },
    ]);
    await prisma.$executeRaw`UPDATE state_bill SET description=NULL WHERE id=${bill}`;
    const missingSummary = await reports.preview(ctx, p.run.id, 'synthetic-report', '2098-06-26');
    expect(missingSummary.complete).toBe(false);
    expect(missingSummary.exceptions.some((e) => e.reason.includes('Source summary'))).toBe(true);
    await prisma.$executeRaw`UPDATE state_bill SET description='Structured source summary' WHERE id=${bill}`;
  });
  it('preserves assignment identity when a corrected session mapping resolves another bill', async () => {
    const alternate = 'fl-2098-special-hb42';
    await prisma.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber) VALUES(${alternate},'FL','2098 special','2098-special','HB 42','hb42','Special session bill','lower') ON CONFLICT(id) DO NOTHING`;
    const items: FolderImportItemDto[] = [
      { kind: 'folder', sourceId: 'remap-folder', payload: rawFolder },
      {
        kind: 'assignment',
        sourceId: 'remap-folder:2098:42',
        payload: {
          folder_id: 'remap-folder',
          session: '2098',
          bill_number: 'HB 42',
          top_priority: false,
          importance: 'OFF',
          position: 'OFF',
        },
      },
    ];
    const first = await apply(await preview('remap1', items));
    const a = first.items.find((i) => i.kind === 'assignment')!;
    const second = await apply(
      await preview('remap2', items, {
        ...manifest,
        sessions: { '2098': { jurisdiction: 'FL', sessionKey: '2098-special' } },
      }),
    );
    expect(second.items.find((i) => i.kind === 'assignment')?.reason).toBe(
      'ASSIGNMENT_IDENTITY_REMAP_REQUIRES_REVIEW',
    );
    const retained = await prisma.legiWatchFolderBill.findUniqueOrThrow({
      where: { id: a.targetId! },
    });
    expect(retained.billId).toBe(bill);
    expect(retained.sessionKey).toBe('2098');
    expect(retained.version).toBe(0);
  });
  it('prevents compensation from archiving another owner read-only folder even for a bypass-RLS administrator', async () => {
    const p = await apply(
      await preview(
        'comp-permission',
        [
          {
            kind: 'folder',
            sourceId: 'comp-readonly',
            payload: { ...rawFolder, other_user_access: 'read_only' },
          },
        ],
        { ...manifest, owners: { owner: other } },
      ),
    );
    const f = p.items[0]!;
    await imports.pause(ctx, p.run.id, true);
    const result = await imports.compensate(ctx, p.run.id, {
      targetTenantId: tenant,
      mappingHash: p.run.mappingHash,
      itemIds: [f.id],
    });
    expect(result.items[0]?.reason).toBe('FOLDER_NOT_WRITABLE');
    expect(
      (await prisma.legiWatchFolder.findUniqueOrThrow({ where: { id: f.targetId! } })).archived,
    ).toBe(false);
    const reimport = await apply(
      await preview(
        'readonly-snapshot',
        [
          {
            kind: 'folder',
            sourceId: 'comp-readonly',
            payload: {
              ...rawFolder,
              name: 'Forbidden rename',
              form_archived: true,
              other_user_access: 'read_only',
            },
          },
        ],
        { ...manifest, owners: { owner: other } },
      ),
    );
    expect(reimport.items[0]?.reason).toBe('FOLDER_NOT_WRITABLE');
    const retained = await prisma.legiWatchFolder.findUniqueOrThrow({ where: { id: f.targetId! } });
    expect(retained.archived).toBe(false);
    expect(retained.name).toBe(rawFolder.name);
  });
  it('imports a supplied prior-session capture separately and preserves manual removals on replay', async () => {
    const sessionId = 700000000 + Math.floor(Math.random() * 10000000),
      sessionKey = '2024x' + sessionId,
      historicalBill = 'fl-' + sessionKey + '-hb42';
    await prisma.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO state_session(id,state,legiscan_session_id,session_key,name,year_start,year_end,special,prior) VALUES(${'FL-' + sessionId},'FL',${sessionId},${sessionKey},'Synthetic prior',2024,2024,true,true)`;
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber,description) VALUES(${historicalBill},'FL',${sessionKey},${sessionKey},'HB 42','hb42','Synthetic prior bill','lower','Historical fixture')`;
    });
    const parent = await apply(
      await preview('history-parent', [
        { kind: 'folder', sourceId: 'history-folder', payload: rawFolder },
      ]),
    );
    const folderId = parent.items[0]!.targetId!;
    await folders.bulk(ctx, folderId, { action: 'add', billIds: [bill] });
    const mapping = {
      ...manifest,
      purpose: 'historical_client_assignments',
      sessions: { prior: { jurisdiction: 'FL', sessionKey, providerSessionId: sessionId } },
    };
    const item: FolderImportItemDto = {
      kind: 'assignment',
      sourceId: 'same-export-row',
      payload: {
        folder_id: 'history-folder',
        session: 'prior',
        bill_number: 'HB 42',
        evidence_file: 'synthetic/history-2024.csv',
        top_priority: false,
        importance: 'OFF',
        position: 'OFF',
      },
    };
    await expect(
      preview(
        'missing-history',
        [{ ...item, payload: { ...item.payload, evidence_file: undefined } }],
        mapping,
      ),
    ).rejects.toThrow('SPECIFIC_HISTORICAL_EXPORT_AND_SESSION_REQUIRED');
    await expect(
      preview('wrong-history', [item], {
        ...mapping,
        sessions: { prior: { jurisdiction: 'FL', sessionKey, providerSessionId: sessionId + 1 } },
      }),
    ).rejects.toThrow('CANONICAL_PRIOR_SESSION_NOT_RECONCILED');
    const first = await apply(await preview('history-2024', [item], mapping));
    expect(first.items[0]!.sourceId).toBe('history-2024:prior:same-export-row');
    expect(first.items[0]!.status).toBe('applied');
    expect(
      (await prisma.legiWatchFolderBill.findMany({ where: { tenantId: tenant, folderId } }))
        .map((r) => r.billId)
        .sort(),
    ).toEqual([bill, historicalBill].sort());
    await folders.bulk(ctx, folderId, { action: 'remove', billIds: [historicalBill] });
    await apply(await preview('history-2024-recapture', [item], mapping));
    expect(
      await prisma.legiWatchFolderBill.count({
        where: { tenantId: tenant, folderId, billId: historicalBill },
      }),
    ).toBe(0);
    expect(
      await prisma.legiWatchFolderBill.count({
        where: { tenantId: tenant, folderId, billId: bill },
      }),
    ).toBe(1);
  });
  it('enforces real RLS reads, readonly writes and owner-only access changes with a non-bypass database role', async () => {
    const f = await folders.create(ctx, { name: 'Restricted', otherUserAccess: 'read_only' });
    await folders.bulk(ctx, f.id, { action: 'add', billIds: [bill] });
    const lowRole = async <T>(tenantId: string, fn: (tx: any) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.bypass_rls','off',true),set_config('app.folder_actor',${other},true),set_config('app.folder_admin','off',true)`;
        return fn(tx);
      });
    expect(
      await lowRole(
        foreign,
        (tx) => tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE id=${f.id}`,
      ),
    ).toEqual([]);
    expect(
      await lowRole(
        tenant,
        (tx) =>
          tx.$executeRaw`UPDATE intel_legiwatch_folder_bill SET internal_comments='Forbidden' WHERE folder_id=${f.id}`,
      ),
    ).toBe(0);
    expect(
      await lowRole(
        tenant,
        (tx) => tx.$queryRaw`SELECT id FROM intel_legiwatch_staged_configuration`,
      ),
    ).toEqual([]);
    const writable = await folders.create(ctx, { name: 'Shared', otherUserAccess: 'read_change' });
    await expect(
      lowRole(
        tenant,
        (tx) =>
          tx.$executeRaw`UPDATE intel_legiwatch_folder SET other_user_access='read_only' WHERE id=${writable.id}`,
      ),
    ).rejects.toThrow('Only folder owner can change access');
    await expect(
      prisma.$executeRaw`INSERT INTO intel_legiwatch_folder_bill(id,tenant_id,folder_id,bill_id,jurisdiction,session_key,updated_by,updated_at) VALUES(${randomUUID()},${foreign},${f.id},${bill},'FL','2098',${actor},now())`,
    ).rejects.toThrow();
  });
});
