import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { DraftAccessService } from '../src/tracker/delivery/draft-access.service.js';
import { RecipientsService } from '../src/tracker/delivery/recipients.service.js';
import { DeliveryService } from '../src/tracker/delivery/delivery.service.js';
import { RecordRuleService } from '../src/tracker/delivery/record-rule.service.js';
import type { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';
import type { IntelEmailService } from '../src/intel-alert/intel-email.service.js';
import type { WorkspaceTenantContext } from '../src/auth/tenant-context.js';

// Uses a disposable, fully migrated PostgreSQL 16 database. The provider is
// stubbed at the network boundary; every claim, scope check and write is real.
describe('Monitoring rules and recipients: PostgreSQL authorization and delivery', () => {
  const prisma = new PrismaService(),
    source = new FolderSourceDataRepository(prisma);
  const folders = new FolderTrackerService(prisma, source, new SourceDataRepository(prisma));
  const enabled = jest.fn(async () => true),
    send = jest.fn(async () => ({ outcome: 'accepted', messageId: 'synthetic-provider-id' }));
  const reports = new DraftAccessService(folders, {
    isEnabled: enabled,
  } as unknown as FeatureFlagService);
  const recipients = new RecipientsService(reports),
    delivery = new DeliveryService(reports, recipients, {
      sendReport: send,
    } as unknown as IntelEmailService);
  const rules = new RecordRuleService(reports);
  const tenant = randomUUID(),
    foreign = randomUUID(),
    suffix = randomUUID().slice(0, 8),
    actor = `reports_${suffix}`,
    other = `reader_${suffix}`,
    lowRole = `report_rls_${suffix}`;
  const ctx: WorkspaceTenantContext = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' };
  const bill = `fl-2095-hb${suffix}`,
    second = `fl-2095-sb${suffix}`,
    now = new Date(),
    cutoff = now.toISOString().slice(0, 10);
  let folderId: string;
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('localhost:55462') && process.env.CI !== 'true')
      throw new Error('Disposable PostgreSQL URL required');
    await prisma.$connect();
    await prisma.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${'report-' + suffix},'Synthetic reports'),(${foreign}::uuid,${'foreign-report-' + suffix},'Foreign synthetic')`;
      for (const user of [actor, other]) {
        const uid = randomUUID();
        await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${uid}::uuid,${user},${user + '@example.invalid'})`;
        await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${uid}::uuid,'standard_user','active')`;
      }
      for (const id of [bill, second])
        await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,description,url,source_checked_at,source_check_status,report_source_facts) VALUES(${id},'FL','2095','2095','HB 93','hb93','Synthetic published measure','Source description','https://example.gov/bill',${now},'success','{"coverage":{"actions":true,"amendments":true,"committees":true,"relations":true},"committees":[],"relations":[]}'::jsonb)`;
      await tx.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES(${randomUUID()}::uuid,${bill},'action','a1','r1',${cutoff},1,'{"text":"Published action","url":"https://example.gov/action"}'::jsonb,${now})`;
      await tx.$executeRawUnsafe(
        `CREATE ROLE ${lowRole} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`,
      );
      await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${lowRole}`);
      await tx.$executeRawUnsafe(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON intel_legiwatch_report,intel_legiwatch_report_run,intel_legiwatch_report_list TO ${lowRole}`,
      );
    });
    folderId = (
      await folders.create(ctx, {
        name: 'Synthetic folder',
        jurisdiction: 'FL',
        defaultSession: '2095',
      })
    ).id;
    await folders.bulk(ctx, folderId, { action: 'add', billIds: [bill] });
  }, 60000);
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP OWNED BY ${lowRole}`);
    await prisma.$executeRawUnsafe(`DROP ROLE ${lowRole}`);
    await prisma.$disconnect();
  });
  beforeEach(() => {
    enabled.mockResolvedValue(true);
    send.mockClear();
    send.mockResolvedValue({ outcome: 'accepted', messageId: 'synthetic-provider-id' });
  });
  it('enforces tenant RLS and private-list visibility with a non-bypass role', async () => {
    const list = await recipients.saveList(ctx, { name: 'Private', private: true, contactIds: [] });
    const read = (tenantId: string, actorId: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${lowRole}`);
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.bypass_rls','off',true),set_config('app.folder_actor',${actorId},true),set_config('app.folder_admin','off',true)`;
        return {
          lists: await tx.legiWatchReportList.findMany(),
        };
      });
    expect((await read(foreign, actor)).lists).toEqual([]);
    expect((await read(tenant, other)).lists).toEqual([]);
    expect((await read(tenant, actor)).lists.map((l) => l.id)).toContain(list.id);
  });
  it('preserves aliases and empty lists, and deduplicates exact Bcc destinations', async () => {
    const email = `alias-${suffix}@example.invalid`;
    const a = await recipients.saveContact(ctx, { name: 'Alias one', email, verified: true }),
      b = await recipients.saveContact(ctx, {
        name: 'Alias two',
        email: email.toUpperCase(),
        verified: true,
      });
    const list = await recipients.saveList(ctx, {
      name: 'Two identities',
      private: false,
      contactIds: [a.id, b.id],
    });
    const rows = await folders.withActor(ctx, (tx) =>
      recipients.resolve(tx, ctx, [{ kind: 'list', id: list.id, role: 'bcc' }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contacts).toHaveLength(2);
    expect(rows[0]!.role).toBe('bcc');
    const empty = await recipients.saveList(ctx, { name: 'Empty', contactIds: [] });
    expect(
      await folders.withActor(ctx, (tx) =>
        recipients.resolve(tx, ctx, [{ kind: 'list', id: empty.id, role: 'to' }]),
      ),
    ).toEqual([]);
  });
  it('detects folder-only same-day records without a legacy tracked bill and keeps replay idempotent', async () => {
    const r = await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchRecordRule.create({
        data: {
          tenantId: tenant,
          ownerClerkId: actor,
          name: 'Folder action records',
          folderIds: [folderId],
          recipients: [{ userId: other, email: true, inApp: true }],
          cadence: 'realtime',
          issues: [],
        },
      }),
    );
    // Explicit boundaries keep the seeded baseline record outside this window
    // on both fast native runners and slower local environments.
    const baseline = new Date();
    await rules.activation(ctx, r.id, { enabled: true, expectedVersion: r.version }, baseline);
    const firstObserved = new Date(baseline.getTime() + 1);
    for (const n of [1, 2])
      await prisma.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES(${randomUUID()}::uuid,${bill},'action',${'late' + n},'v1',${cutoff},${n + 1},${JSON.stringify({ text: `Same-day action ${n}`, url: 'https://example.gov/action' })}::jsonb,${firstObserved})`;
    expect(await prisma.trackedBill.count({ where: { tenantId: tenant } })).toBe(0);
    await rules.detect(tenant, firstObserved);
    await rules.detect(tenant, firstObserved);
    const matches = await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchRecordMatch.findMany({ where: { ruleId: r.id } }),
    );
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.eventKey)).toHaveLength(
      new Set(matches.map((m) => m.eventKey)).size,
    );
  });
  it('deduplicates compatible overlapping rules and sends one due digest with late-dated amendments', async () => {
    await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchRecordRule.updateMany({ where: { tenantId: tenant }, data: { state: 'paused' } }),
    );
    const baseline = new Date();
    for (const name of ['Digest one', 'Digest two']) {
      const r = await prisma.withTenant(tenant, (tx) =>
        tx.legiWatchRecordRule.create({
          data: {
            tenantId: tenant,
            ownerClerkId: actor,
            name,
            folderIds: [folderId],
            recipients: [{ userId: other, email: true, inApp: false }],
            cadence: 'end_of_day',
            timezone: 'America/New_York',
            localMinutes: 0,
            issues: [],
          },
        }),
      );
      await rules.activation(ctx, r.id, { enabled: true, expectedVersion: r.version }, baseline);
    }
    for (const n of [81, 82])
      await prisma.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES(${randomUUID()}::uuid,${bill},'amendment',${'amendment:' + n},'v1','2026-08-01',${n},${JSON.stringify({ text: `Published amendment ${n}`, url: 'https://example.gov/amendment' })}::jsonb,${new Date(baseline.getTime() + 1)})`;
    await rules.detect(tenant, new Date(Date.now() + 100));
    await rules.enqueue(tenant);
    const queued = await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchDelivery.findMany({
        where: {
          tenantId: tenant,
          kind: 'bill_record',
          composition: { path: ['cadence'], equals: 'end_of_day' },
        },
      }),
    );
    expect(queued).toHaveLength(2);
    expect(
      queued.every((d) => (d.composition as { ruleRefs: unknown[] }).ruleRefs.length === 2),
    ).toBe(true);
    const oldKill = process.env.TRACKER_ALERTS_ENABLED,
      oldScope = process.env.LEGIWATCH_RECORD_ALERT_SOURCE_TYPES;
    process.env.TRACKER_ALERTS_ENABLED = 'true';
    process.env.LEGIWATCH_RECORD_ALERT_SOURCE_TYPES = 'state_bill';
    try {
      await delivery.drain(tenant, 25, new Date(), 'bill_record');
      await delivery.drain(tenant, 25, new Date(), 'bill_record');
    } finally {
      if (oldKill === undefined) delete process.env.TRACKER_ALERTS_ENABLED;
      else process.env.TRACKER_ALERTS_ENABLED = oldKill;
      if (oldScope === undefined) delete process.env.LEGIWATCH_RECORD_ALERT_SOURCE_TYPES;
      else process.env.LEGIWATCH_RECORD_ALERT_SOURCE_TYPES = oldScope;
    }
    expect(send).toHaveBeenCalledTimes(1);
    const bundle = await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchDelivery.findFirstOrThrow({
        where: {
          tenantId: tenant,
          composition: { path: ['cadence'], equals: 'end_of_day_digest' },
        },
        include: { recipients: true },
      }),
    );
    expect((bundle.composition as { records: unknown[] }).records).toHaveLength(2);
    expect(bundle.recipients[0]!.state).toBe('provider_accepted');
  });
});
