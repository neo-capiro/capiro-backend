import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { ReportService } from '../src/tracker/reports/report.service.js';
import { ReportRecipientsService } from '../src/tracker/reports/recipients.service.js';
import { ReportDeliveryService } from '../src/tracker/reports/report-delivery.service.js';
import { CalendarPreparationService } from '../src/tracker/calendar/calendar-preparation.service.js';
import { AgendaRuleService } from '../src/tracker/calendar/agenda-rule.service.js';
import { capturedRule } from '../src/tracker/reports/record-rule.service.js';
import { json, object } from '../src/tracker/reports/report-domain.js';
import type { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';
import type { IntelEmailService } from '../src/intel-alert/intel-email.service.js';
import type { WorkspaceTenantContext } from '../src/auth/tenant-context.js';

describe('Phase 3 private preparation and agenda delivery on PostgreSQL', () => {
  const p = new PrismaService(),
    source = new FolderSourceDataRepository(p),
    folders = new FolderTrackerService(p, source, new SourceDataRepository(p));
  const enabled = jest.fn(async () => true),
    flags = { isEnabled: enabled } as unknown as FeatureFlagService;
  const reports = new ReportService(folders, flags),
    rules = new AgendaRuleService(reports),
    prep = new CalendarPreparationService(folders, flags);
  const send = jest.fn(async () => ({ outcome: 'accepted', messageId: 'test-only' }));
  const delivery = new ReportDeliveryService(reports, new ReportRecipientsService(reports), {
    sendReport: send,
  } as unknown as IntelEmailService);
  const tenant = randomUUID(),
    foreign = randomUUID(),
    suffix = randomUUID().slice(0, 8),
    actor = `calendar_${suffix}`,
    other = `calendar_reader_${suffix}`,
    lowRole = `calendar_rls_${suffix}`;
  const ctx: WorkspaceTenantContext = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' };
  const hearing = `phase3-test-${suffix}`,
    bills = [`fl-2094-hb${suffix}`, `fl-2094-sb${suffix}`],
    folderIds: string[] = [],
    ruleIds: string[] = [];
  const now = new Date(),
    baseline = new Date(now.getTime() - 5000);
  const facts = {
    title: 'Synthetic agenda',
    status: 'scheduled',
    location: 'Room A',
    time: {
      date: now.toISOString().slice(0, 10),
      rawTime: 'Upon adjournment',
      timezone: 'America/New_York',
      precision: 'relative',
      startsAt: null,
      endsAt: null,
    },
    documents: [],
    agenda: bills.map((id, position) => ({
      key: id,
      position,
      kind: 'bill',
      title: id,
      bill: { id, scope: 'state', jurisdiction: 'FL', session: '2094' },
      sourceUrl: 'https://example.gov/notice',
      evidence: {},
    })),
  };
  let snapshotId: string;
  beforeAll(async () => {
    if (process.env.CI !== 'true' && !process.env.DATABASE_URL?.includes('localhost:55463'))
      throw new Error('Disposable PostgreSQL required');
    await p.$connect();
    await p.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${'calendar-' + suffix},'Synthetic calendar'),(${foreign}::uuid,${'foreign-calendar-' + suffix},'Foreign synthetic')`;
      for (const user of [actor, other]) {
        const uid = randomUUID();
        await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${uid}::uuid,${user},${user + '@example.invalid'})`;
        await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${uid}::uuid,'standard_user','active')`;
      }
      for (const id of bills)
        await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,url,source_checked_at,source_check_status,report_source_facts) VALUES(${id},'FL','2094','2094','HB 93','hb93','Synthetic current bill','https://example.gov/bill',${now},'success','{"coverage":{"actions":true,"amendments":true}}'::jsonb)`;
      await tx.$executeRaw`INSERT INTO committee_hearing(id,committee_name,chamber,title,date,geographic_jurisdiction,legislative_session,calendar_revision,calendar_snapshot,calendar_checked_at,calendar_check_state) VALUES(${hearing},'Synthetic committee','Senate','Synthetic agenda',${now},'FL','2094',1,${JSON.stringify(facts)}::jsonb,${now},'complete')`;
      for (const chamber of ['house', 'senate'])
        await tx.$executeRaw`INSERT INTO legislative_calendar_coverage(id,source_id,jurisdiction,chamber,from_date,to_date,status,pages,items,details,attempted_at) VALUES(${randomUUID()}::uuid,${randomUUID()}::uuid,'FL',${chamber},CURRENT_DATE,CURRENT_DATE+14,'complete',1,1,'{}'::jsonb,${now})`;
      await tx.$executeRawUnsafe(
        `CREATE ROLE ${lowRole} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`,
      );
      await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${lowRole}`);
      await tx.$executeRawUnsafe(
        `GRANT SELECT,INSERT ON intel_legiwatch_preparation_snapshot TO ${lowRole}`,
      );
    });
    for (let i = 0; i < 2; i++) {
      const f = await folders.create(ctx, {
        name: `Synthetic agenda folder ${i}`,
        jurisdiction: 'FL',
        defaultSession: '2094',
      });
      folderIds.push(f.id);
      await folders.bulk(ctx, f.id, { action: 'add', billIds: [bills[i]!] });
      const rule = await folders.withActor(ctx, (tx) =>
        tx.legiWatchRecordRule.create({
          data: {
            tenantId: tenant,
            ownerClerkId: actor,
            family: 'agenda',
            name: `Synthetic rule ${i}`,
            folderIds: [f.id],
            recipients: json([{ userId: actor, email: true, inApp: false }]),
            cadence: 'realtime',
            issues: [],
            state: 'needs_review',
          },
        }),
      );
      ruleIds.push(rule.id);
      await rules.activation(ctx, rule.id, { enabled: true, expectedVersion: 0 }, baseline);
    }
    process.env.LEGIWATCH_AGENDA_ALERTS_ENABLED = 'true';
    process.env.TRACKER_ALERTS_ENABLED = 'true';
  }, 60000);
  afterAll(async () => {
    await p.$executeRawUnsafe(`DROP OWNED BY ${lowRole}`);
    await p.$executeRawUnsafe(`DROP ROLE ${lowRole}`);
    await p.$disconnect();
  });
  it('builds preparation without a transcript and freezes authorized folder inputs', async () => {
    const result = await prep.prepare(ctx, hearing, { folderIds });
    snapshotId = String(result.context.snapshotId);
    expect(result.context.mode).toBe('preparation');
    expect(result.context.bills).toHaveLength(2);
    expect(result.context.folderContext).toHaveLength(2);
    await expect(
      p.withTenant(tenant, (tx) =>
        tx.legiWatchPreparationSnapshot.update({
          where: { id: snapshotId },
          data: { calendarRevision: 8 },
        }),
      ),
    ).rejects.toThrow('immutable');
  });
  it('reports a later calendar revision without rewriting the frozen draft inputs', async () => {
    await p.$executeRaw`UPDATE committee_hearing SET calendar_revision=2 WHERE id=${hearing}`;
    expect(await prep.snapshotStatus(ctx, snapshotId)).toMatchObject({
      stale: true,
      preparedRevision: 1,
      currentRevision: 2,
    });
    const frozen = await p.withTenant(tenant, (tx) =>
      tx.legiWatchPreparationSnapshot.findUniqueOrThrow({ where: { id: snapshotId } }),
    );
    expect(object(object(frozen.payload).event).revision).toBe(1);
  });
  it('enforces tenant and snapshot-owner RLS using a role without bypass', async () => {
    const read = (tid: string, user: string) =>
      p.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${lowRole}`);
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${tid},true),set_config('app.folder_actor',${user},true),set_config('app.bypass_rls','off',true)`;
        return tx.legiWatchPreparationSnapshot.findMany();
      });
    expect(await read(foreign, actor)).toEqual([]);
    expect(await read(tenant, other)).toEqual([]);
    expect(await read(tenant, actor)).toHaveLength(1);
  });
  it('keeps all eight captured agenda definitions inactive pending cadence review', () => {
    for (let key = 4; key <= 11; key++) {
      const rule = capturedRule(
        {
          family: 'Tagged Bill Agenda',
          audit_key: `alert-${String(key).padStart(2, '0')}`,
          name: 'Captured name ',
          frequency: [],
          selected_targets: [],
        },
        'agenda',
      );
      expect(rule.name).toBe('Captured name ');
      expect(rule.reviewIssues.length).toBeGreaterThan(0);
    }
    expect(() =>
      capturedRule({ family: 'Tagged Bill Agenda', audit_key: 'alert-12' }, 'agenda'),
    ).toThrow();
  });
  it('replays one transition safely and merges two rules/bills into one recipient intent', async () => {
    const event = randomUUID();
    await p.$executeRaw`INSERT INTO legislative_calendar_transition(id,hearing_id,revision,"before","after",changed_fields,source_url,observed_at) VALUES(${event}::uuid,${hearing},2,${JSON.stringify(facts)}::jsonb,${JSON.stringify({ ...facts, location: 'Room B' })}::jsonb,ARRAY['location'],'https://example.gov/notice',${now})`;
    expect((await rules.detect(tenant, now)).matches).toBe(2);
    expect((await rules.detect(tenant, now)).matches).toBe(0);
    await Promise.all([rules.enqueue(tenant, now), rules.enqueue(tenant, now)]);
    const rows = await p.withTenant(tenant, (tx) =>
      tx.legiWatchDelivery.findMany({ where: { tenantId: tenant, kind: 'agenda' } }),
    );
    expect(rows).toHaveLength(1);
    expect(object(rows[0]!.composition).billIds).toEqual(expect.arrayContaining(bills));
    expect(object(rows[0]!.composition).ruleRefs).toHaveLength(2);
  });
  it('holds an entire mixed-bill packet when just one folder is revoked, then delivers once after access is restored', async () => {
    const row = await p.withTenant(tenant, (tx) =>
      tx.legiWatchDelivery.findFirstOrThrow({ where: { tenantId: tenant, kind: 'agenda' } }),
    );
    const recipient = await p.withTenant(tenant, (tx) =>
      tx.legiWatchDeliveryRecipient.findFirstOrThrow({ where: { deliveryId: row.id } }),
    );
    await p.withTenant(tenant, (tx) =>
      tx.legiWatchFolder.update({ where: { id: folderIds[1] }, data: { archived: true } }),
    );
    await expect(
      folders.withActor(ctx, (tx) =>
        delivery.checkDispatch(tx, ctx, row, recipient.recipient as never, 'email'),
      ),
    ).rejects.toThrow('REVOKED');
    expect(send).not.toHaveBeenCalled();
    await p.withTenant(tenant, (tx) =>
      tx.legiWatchFolder.update({ where: { id: folderIds[1] }, data: { archived: false } }),
    );
    await delivery.drain(tenant, 25, new Date(), 'agenda');
    await delivery.drain(tenant, 25, new Date(), 'agenda');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('turning the Phase 3 flag off prevents new detection, preparation, and dispatch claims', async () => {
    enabled.mockResolvedValue(false);
    expect(await rules.detect(tenant)).toEqual({ rules: 0, matches: 0 });
    await expect(prep.prepare(ctx, hearing, {})).rejects.toThrow();
    expect(await delivery.drain(tenant, 25, new Date(), 'agenda')).toEqual({
      attempted: 0,
      held: 0,
    });
  });
});
