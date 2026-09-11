import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { ReportService } from '../src/tracker/reports/report.service.js';
import { ReportRecipientsService } from '../src/tracker/reports/recipients.service.js';
import { ReportDeliveryService } from '../src/tracker/reports/report-delivery.service.js';
import { ReportSubscriptionService } from '../src/tracker/reports/report-subscription.service.js';
import { RecordRuleService } from '../src/tracker/reports/record-rule.service.js';
import { settings, type ReportDocument } from '../src/tracker/reports/report-domain.js';
import * as reportDomain from '../src/tracker/reports/report-domain.js';
import type { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';
import type { IntelEmailService } from '../src/intel-alert/intel-email.service.js';
import type { WorkspaceTenantContext } from '../src/auth/tenant-context.js';

// Uses a disposable, fully migrated PostgreSQL 16 database. The provider is
// stubbed at the network boundary; every claim, scope check and write is real.
describe('Phase 2 reports: PostgreSQL authorization, delivery and recovery', () => {
  const prisma = new PrismaService(),
    source = new FolderSourceDataRepository(prisma);
  const folders = new FolderTrackerService(prisma, source, new SourceDataRepository(prisma));
  const enabled = jest.fn(async () => true),
    send = jest.fn(async () => ({ outcome: 'accepted', messageId: 'synthetic-provider-id' }));
  const reports = new ReportService(folders, {
    isEnabled: enabled,
  } as unknown as FeatureFlagService);
  const recipients = new ReportRecipientsService(reports),
    delivery = new ReportDeliveryService(reports, recipients, {
      sendReport: send,
    } as unknown as IntelEmailService);
  const schedules = new ReportSubscriptionService(reports, recipients, delivery),
    rules = new RecordRuleService(reports);
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
  let folderId: string, reportId: string;
  const selection = [{ kind: 'manual', email: `${suffix}@example.invalid`, role: 'bcc' }];
  async function generate() {
    return reports.generate(ctx, reportId, { cutoff, audience: 'external' });
  }
  async function approved() {
    const run = await generate(),
      b = { subject: 'Synthetic report', introduction: 'For review', selection };
    const review = await delivery.preview(ctx, run.id, b);
    return { run, b: { ...b, approvalHash: review.approvalHash } };
  }
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
    reportId = (
      await reports.save(ctx, {
        name: 'Synthetic report',
        folderIds: [folderId],
        jurisdiction: 'FL',
        sessionKey: '2095',
        settings: settings({}),
      })
    ).id;
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
  it('hydrates canonical published records and creates an immutable external run', async () => {
    const run = await generate(),
      doc = run.snapshot as unknown as ReportDocument;
    expect(run.complete).toBe(true);
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]!.actions[0]!.text).toBe('Published action');
    expect(run.rendered.text).toContain('Source description');
    await expect(
      prisma.withTenant(tenant, (tx) =>
        tx.legiWatchReportRun.update({ where: { id: run.id }, data: { cutoff: '2000-01-01' } }),
      ),
    ).rejects.toThrow('immutable');
    await expect(reports.run({ ...ctx, tenantId: foreign }, run.id)).rejects.toThrow();
  });
  it('serializes a worker generation identity and returns the same frozen run on retry', async () => {
    const key = 'generation-' + suffix;
    const runs = await Promise.all([
      reports.generate(ctx, reportId, { cutoff }, now, key),
      reports.generate(ctx, reportId, { cutoff }, now, key),
    ]);
    expect(runs[0]!.id).toBe(runs[1]!.id);
    expect(runs[0]!.contentHash).toBe(runs[1]!.contentHash);
  });
  it('retains the exact export and delivery bytes after the renderer changes', async () => {
    const run = await generate();
    const renderer = jest
      .spyOn(reportDomain, 'renderReport')
      .mockReturnValue({ html: '<body>New renderer</body>', text: 'New renderer' });
    try {
      expect((await reports.run(ctx, run.id)).rendered).toEqual(run.rendered);
      const preview = await delivery.preview(ctx, run.id, {
        subject: 'Frozen export',
        introduction: '',
        selection,
      });
      expect(preview.composition.html).toContain('Source description');
      expect(preview.composition.html).not.toContain('New renderer');
      expect(preview.composition.contentHash).toBe(run.contentHash);
    } finally {
      renderer.mockRestore();
    }
  });
  it('enforces tenant RLS and private-list visibility with a non-bypass role', async () => {
    const list = await recipients.saveList(ctx, { name: 'Private', private: true, contactIds: [] });
    const read = (tenantId: string, actorId: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${lowRole}`);
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.bypass_rls','off',true),set_config('app.folder_actor',${actorId},true),set_config('app.folder_admin','off',true)`;
        return {
          reports: await tx.legiWatchReport.findMany(),
          lists: await tx.legiWatchReportList.findMany(),
        };
      });
    expect((await read(foreign, actor)).reports).toEqual([]);
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
  it('holds stale recipient review after a list edit', async () => {
    const c = await recipients.saveContact(ctx, {
      name: 'Reviewed',
      email: `review-${suffix}@example.invalid`,
      verified: true,
    });
    const list = await recipients.saveList(ctx, { name: 'Reviewed list', contactIds: [c.id] });
    const run = await generate(),
      b = { subject: 'Review', selection: [{ kind: 'list', id: list.id, role: 'bcc' }] };
    const preview = await delivery.preview(ctx, run.id, b);
    await recipients.saveList(
      ctx,
      { ...list, name: 'Changed list', expectedVersion: list.version },
      list.id,
    );
    await expect(
      delivery.approve(ctx, run.id, { ...b, approvalHash: preview.approvalHash }),
    ).rejects.toThrow('COMPOSITION_CHANGED');
  });
  it('claims one recipient across duplicate approvals and concurrent workers', async () => {
    const a = await approved();
    const queued = await Promise.all([
      delivery.approve(ctx, a.run.id, a.b),
      delivery.approve(ctx, a.run.id, a.b),
    ]);
    expect(queued[0]!.id).toBe(queued[1]!.id);
    await Promise.all([delivery.drain(tenant), delivery.drain(tenant)]);
    expect(send).toHaveBeenCalledTimes(1);
    const history = await delivery.history(ctx, a.run.id);
    expect(history[0]!.recipients[0]!.state).toBe('provider_accepted');
    expect(history[0]!.recipients[0]!.providerId).toBe('synthetic-provider-id');
  });
  it('quarantines uncertain outcomes and never automatically retries them', async () => {
    const a = await approved();
    await delivery.approve(ctx, a.run.id, a.b);
    send.mockResolvedValue({ outcome: 'uncertain', messageId: '' });
    await delivery.drain(tenant);
    await delivery.drain(tenant);
    expect(send).toHaveBeenCalledTimes(1);
    const row = (await delivery.history(ctx, a.run.id))[0]!.recipients[0]!;
    expect(row.state).toBe('uncertain');
    await delivery.reconcile(ctx, row.id, {
      outcome: 'provider_accepted',
      providerId: 'verified-provider-id',
      reason: 'Synthetic provider audit verified acceptance',
    });
    expect((await delivery.history(ctx, a.run.id))[0]!.recipients[0]!.acceptedAt).not.toBeNull();
  });
  it('does not reclaim an active lease, and fences an expired dispatch marker', async () => {
    const a = await approved(),
      d = await delivery.approve(ctx, a.run.id, a.b);
    await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchDeliveryRecipient.updateMany({
        where: { deliveryId: d.id },
        data: { state: 'claimed', leaseToken: 'active', leaseUntil: new Date(Date.now() + 60000) },
      }),
    );
    await delivery.drain(tenant);
    expect(send).not.toHaveBeenCalled();
    await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchDeliveryRecipient.updateMany({
        where: { deliveryId: d.id },
        data: {
          state: 'sending',
          dispatchStartedAt: new Date(),
          leaseUntil: new Date(Date.now() - 1000),
        },
      }),
    );
    await delivery.drain(tenant);
    expect(send).not.toHaveBeenCalled();
    expect((await delivery.history(ctx, a.run.id))[0]!.recipients[0]!.state).toBe('uncertain');
  });
  it('holds approved delivery when new live membership changes the reviewed scope', async () => {
    const a = await approved();
    await delivery.approve(ctx, a.run.id, a.b);
    await folders.bulk(ctx, folderId, { action: 'add', billIds: [second] });
    await delivery.drain(tenant);
    expect(send).not.toHaveBeenCalled();
    const row = (await delivery.history(ctx, a.run.id))[0]!.recipients[0]!;
    expect(row.state).toBe('held');
    expect(row.error).toBe('FOLDER_SCOPE_CHANGED');
    expect((await generate()).snapshot).not.toEqual(a.run.snapshot);
    await folders.bulk(ctx, folderId, { action: 'remove', billIds: [second] });
  });
  it('starts schedules disabled and creates one occurrence for concurrent due calls', async () => {
    const sub = await schedules.save(ctx, {
      reportId,
      mode: 'draft',
      timezone: 'America/New_York',
      localMinutes: 480,
      subject: 'Draft',
    });
    expect(sub.enabled).toBe(false);
    const active = await schedules.activation(ctx, sub.id, {
      enabled: true,
      expectedVersion: sub.version,
    });
    const intended = new Date(Date.now() + 1000);
    await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchReportSubscription.update({
        where: { id: sub.id },
        data: { nextDueAt: intended },
      }),
    );
    await Promise.all([
      schedules.due(tenant, 25, new Date(intended.getTime() + 1000)),
      schedules.due(tenant, 25, new Date(intended.getTime() + 1000)),
    ]);
    const history = await schedules.history(ctx, sub.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.state).toBe('no_change');
    expect(history[0]!.runId).toBeTruthy();
    await schedules.activation(ctx, sub.id, { enabled: false, expectedVersion: active.version });
  });
  it('holds an unsent frozen run if the current source refresh failed', async () => {
    const a = await approved();
    await delivery.approve(ctx, a.run.id, a.b);
    try {
      await prisma.$executeRaw`UPDATE state_bill SET source_check_status='failed' WHERE id=${bill}`;
      await delivery.drain(tenant);
      expect(send).not.toHaveBeenCalled();
      expect((await delivery.history(ctx, a.run.id))[0]!.recipients[0]!.error).toBe(
        'SOURCE_CHECK_INCOMPLETE',
      );
    } finally {
      await prisma.$executeRaw`UPDATE state_bill SET source_check_status='success' WHERE id=${bill}`;
    }
  });
  it('holds automatic delivery when a subscription is paused after enqueue', async () => {
    const sub = await schedules.save(ctx, {
      reportId,
      mode: 'send',
      timezone: 'America/New_York',
      localMinutes: 480,
      subject: 'Scheduled',
      selection,
    });
    await expect(
      schedules.activation(ctx, sub.id, { enabled: true, expectedVersion: sub.version }),
    ).rejects.toThrow('EXPLICIT_AUTOMATIC_SEND');
    const active = await schedules.activation(ctx, sub.id, {
      enabled: true,
      expectedVersion: sub.version,
      confirmSend: true,
    });
    const a = await approved(),
      preview = await delivery.preview(ctx, a.run.id, a.b);
    await delivery.enqueue(ctx, preview.composition, 'paused-' + suffix, {
      id: sub.id,
      version: active.version,
    });
    await schedules.activation(ctx, sub.id, { enabled: false, expectedVersion: active.version });
    await delivery.drain(tenant);
    expect(send).not.toHaveBeenCalled();
    expect((await delivery.history(ctx, a.run.id))[0]!.recipients[0]!.error).toBe(
      'SUBSCRIPTION_CHANGED_OR_PAUSED',
    );
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
    const baseline = new Date(Date.now() - 2000);
    await rules.activation(ctx, r.id, { enabled: true, expectedVersion: r.version }, baseline);
    const firstObserved = new Date();
    for (const n of [1, 2])
      await prisma.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES(${randomUUID()}::uuid,${bill},'action',${'late' + n},'v1',${cutoff},${n + 1},${JSON.stringify({ text: `Same-day action ${n}`, url: 'https://example.gov/action' })}::jsonb,${firstObserved})`;
    expect(await prisma.trackedBill.count({ where: { tenantId: tenant } })).toBe(0);
    await rules.detect(tenant);
    await rules.detect(tenant);
    const matches = await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchRecordMatch.findMany({ where: { ruleId: r.id } }),
    );
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.eventKey)).toHaveLength(
      new Set(matches.map((m) => m.eventKey)).size,
    );
  });
  it('promotes 80 contact identities, 25 lists and 51 memberships without losing aliases or replaying edits', async () => {
    const account = `synthetic-${suffix}`;
    const base = { tenantId: tenant, sourceAccount: account, provenance: { fixture: true } };
    await prisma.withTenant(tenant, (tx) =>
      tx.legiWatchStagedConfiguration.createMany({
        data: [
          ...Array.from({ length: 80 }, (_, i) => ({
            ...base,
            kind: 'contact',
            sourceId: String(i),
            payload: {
              full_name: `Synthetic contact ${i}`,
              email: `${i === 2 ? 1 : i}-${suffix}@example.invalid`,
            },
          })),
          ...Array.from({ length: 25 }, (_, i) => ({
            ...base,
            kind: 'mailing_list',
            sourceId: String(i),
            payload: { name: `Synthetic list ${i}`, visibility: i < 4 ? 'Private' : 'Public' },
          })),
          ...Array.from({ length: 51 }, (_, i) => ({
            ...base,
            kind: 'list_membership',
            sourceId: String(i),
            payload: { mailing_list_id: String(i % 24), contact_id: String(i) },
          })),
        ],
      }),
    );
    expect(await recipients.promote(ctx, account)).toEqual({
      contacts: 80,
      lists: 25,
      memberships: 51,
      unresolved: [],
      allNewContactsUnverified: true,
    });
    const directory = await recipients.directory(ctx),
      imported = directory.contacts.filter((c) => c.name.startsWith('Synthetic contact '));
    expect(imported).toHaveLength(80);
    expect(imported.every((c) => !c.verified)).toBe(true);
    expect(imported.filter((c) => c.email === `1-${suffix}@example.invalid`)).toHaveLength(2);
    expect(directory.lists.find((l) => l.name === 'Synthetic list 24')!.contactIds).toEqual([]);
    const changed = imported[0]!;
    await recipients.saveContact(
      ctx,
      { ...changed, name: 'Staff edit preserved', expectedVersion: changed.version },
      changed.id,
    );
    expect(await recipients.promote(ctx, account)).toMatchObject({
      contacts: 0,
      lists: 0,
      memberships: 0,
    });
    expect((await recipients.directory(ctx)).contacts.find((c) => c.id === changed.id)!.name).toBe(
      'Staff edit preserved',
    );
  }, 60000);
  it('creates five daily drafts at local cutoffs and excludes worker wakeup delay from the change window', async () => {
    const saved = await schedules.save(ctx, {
      reportId,
      mode: 'draft',
      timezone: 'America/New_York',
      localMinutes: 480,
      subject: 'Five-cycle qualification',
      selection: [],
      sendNoChange: true,
    });
    await schedules.activation(ctx, saved.id, { enabled: true, expectedVersion: saved.version });
    let previous = (await schedules.list(ctx)).find((s) => s.id === saved.id)!.baselineAt!;
    const runIds = new Set<string>();
    try {
      for (let day = 0; day < 5; day++) {
        const sub = (await schedules.list(ctx)).find((s) => s.id === saved.id)!;
        const due = sub.nextDueAt!,
          wakeup = new Date(due.getTime() + 180000);
        await prisma.$executeRaw`UPDATE state_bill SET source_checked_at=${wakeup},source_check_status='success' WHERE id=ANY(${[bill, second]}::text[])`;
        await schedules.due(tenant, 25, wakeup);
        const history = await schedules.history(ctx, saved.id),
          occurrence = history[0]!;
        expect(history).toHaveLength(day + 1);
        expect(occurrence.state).toBe('draft');
        expect(occurrence.windowEnd).toEqual(due);
        expect(occurrence.windowStart).toEqual(previous);
        expect(occurrence.runId).toBeTruthy();
        runIds.add(occurrence.runId!);
        previous = due;
      }
      expect(runIds.size).toBe(5);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await prisma.$executeRaw`UPDATE state_bill SET source_checked_at=${now} WHERE id=ANY(${[bill, second]}::text[])`;
      const sub = (await schedules.list(ctx)).find((s) => s.id === saved.id)!;
      await schedules.activation(ctx, saved.id, { enabled: false, expectedVersion: sub.version });
    }
  }, 60000);
  it('rechecks a held delivery without replacing its frozen intent', async () => {
    const a = await approved();
    await delivery.approve(ctx, a.run.id, a.b);
    await prisma.$executeRaw`UPDATE state_bill SET source_check_status='failed' WHERE id=${bill}`;
    await delivery.drain(tenant);
    const first = (await delivery.history(ctx, a.run.id))[0]!,
      recipient = first.recipients[0]!;
    expect(recipient.state).toBe('held');
    await prisma.$executeRaw`UPDATE state_bill SET source_check_status='success',source_checked_at=${new Date()} WHERE id=${bill}`;
    await expect(
      delivery.retryHeld(ctx, recipient.id, {
        reason: 'Freshness checked',
        contentHash: 'different',
      }),
    ).rejects.toThrow('REVIEWED_CONTENT_CHANGED');
    await delivery.retryHeld(ctx, recipient.id, {
      reason: 'Freshness checked',
      contentHash: first.contentHash,
    });
    await delivery.drain(tenant);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await delivery.history(ctx, a.run.id))[0]!.id).toBe(first.id);
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
