import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { KeywordSourceRepository } from '../src/sourcedata/keyword-source.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';
import { ReportService } from '../src/tracker/reports/report.service.js';
import { ReportDeliveryService } from '../src/tracker/reports/report-delivery.service.js';
import { KeywordRuleService } from '../src/tracker/keywords/keyword-rule.service.js';
import { KeywordDiscoveryService } from '../src/tracker/keywords/keyword-discovery.service.js';
import { KeywordDeliveryService } from '../src/tracker/keywords/keyword-delivery.service.js';
import { localOccurrence } from '../src/tracker/reports/report-schedule.js';
import type { KeywordRule } from '../src/tracker/keywords/keyword-domain.js';

jest.setTimeout(90000);
describe('Phase 6 typed keyword delivery through the existing runner', () => {
  const p = new PrismaService(),
    folders = new FolderTrackerService(
      p,
      new FolderSourceDataRepository(p),
      new SourceDataRepository(p),
    );
  const reports = new ReportService(folders, new FeatureFlagService(p, new ConfigService())),
    rules = new KeywordRuleService(reports, new KeywordSourceRepository(p)),
    discovery = new KeywordDiscoveryService(rules),
    keywords = new KeywordDeliveryService(rules);
  const email = { sendReport: jest.fn() },
    runner = new ReportDeliveryService(
      reports,
      {} as never,
      email as never,
      undefined,
      undefined,
      undefined,
      keywords,
    );
  const tenant = randomUUID(),
    actor = 'keyword-delivery-' + randomUUID(),
    user = randomUUID(),
    session = 'p6-' + randomUUID().slice(0, 8),
    ctx = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' };
  const oldFetch = global.fetch;
  let folderId: string;
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE6_TEST_DATABASE !== 'disposable' ||
      !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
    )
      throw Error('Disposable local DB required');
    await p.$connect();
    await p.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${tenant},'Synthetic keyword delivery')`;
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${actor},${actor + '@example.invalid'})`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
      for (const feature of [
        'legiwatch_keyword_discovery_v1',
        'legiwatch_keyword_delivery_v1',
        'legiwatch_reports_updates_v1',
      ])
        await tx.featureFlag.create({ data: { tenantId: tenant, feature, enabled: true } });
    });
    folderId = (await folders.create(ctx, { name: 'Synthetic review' })).id;
    process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED = 'true';
    process.env.INTERNAL_SERVICE_SECRET = 'test-only';
  });
  afterAll(async () => {
    global.fetch = oldFetch;
    delete process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED;
    delete process.env.INTERNAL_SERVICE_SECRET;
    await p.$disconnect();
  });
  beforeEach(() => {
    global.fetch = jest.fn(
      async () => ({ ok: true, json: async () => ({ created: 1 }) }) as Response,
    );
    email.sendReport.mockReset();
    email.sendReport.mockResolvedValue({ outcome: 'accepted', messageId: 'synthetic-provider' });
  });
  async function scan(rule: KeywordRule, mode = 'preview') {
    let run = await discovery.start(ctx, rule.id, {
      expectedVersion: rule.version,
      requestKey: randomUUID(),
      mode,
    });
    while (run.state !== 'complete') {
      run = await discovery.advance(ctx, run.id);
      if (run.state === 'stale') throw Error('Unexpected stale fixture');
    }
    return run;
  }
  async function setup(
    cadence = 'realtime',
    channels = { email: false, inApp: true },
    overlap = false,
  ) {
    const bill = 'p6-bill-' + randomUUID(),
      term = 'match' + randomUUID().replaceAll('-', '');
    await p.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES(${bill},'FL',${session},${session},'HB 6','hb6',${term + ' initial'})`;
    const config = {
      scope: { jurisdiction: 'FL', sessionKey: session, fields: ['title'] },
      folderIds: [folderId],
      definitions: [{ id: term, raw: term }],
      aggregation: 'any-v1',
      semanticsReviewed: true,
      mode: 'suggest',
      cadence,
      timezone: cadence === 'end_of_day' ? 'America/New_York' : null,
      localMinutes: cadence === 'end_of_day' ? 1020 : null,
      recipients: [{ userId: actor, ...channels }],
    };
    const prepared: KeywordRule[] = [];
    for (let i = 0; i < (overlap ? 2 : 1); i++) {
      let rule = await rules.save(ctx, { name: 'Synthetic delivery ' + i, config });
      rule = await rules.reviewMappings(ctx, rule.id, {
        expectedVersion: rule.version,
        reviewedOwnerId: actor,
        ownerReviewed: true,
        recipients: config.recipients,
      });
      const run = await scan(rule);
      rule = await discovery.activation(ctx, rule.id, {
        expectedVersion: rule.version,
        action: 'activate',
        baseline: 'from_now',
        previewRunId: run.id,
      });
      const ready = await keywords.readiness(ctx, rule.id);
      expect(ready.issues).toEqual([]);
      await keywords.activation(ctx, rule.id, {
        expectedVersion: rule.version,
        enabled: true,
        previewHash: ready.previewHash,
      });
      prepared.push(rule);
    }
    await p.$executeRaw`UPDATE state_bill SET title=${term + ' revised'} WHERE id=${bill}`;
    for (const rule of prepared) await scan(rule, 'active');
    return { bill, rule: prepared[0]!, rules: prepared };
  }
  const deliveries = () =>
    p.withTenant(tenant, (tx) =>
      tx.legiWatchDelivery.findMany({
        where: { tenantId: tenant, kind: 'bill_keyword' },
        include: { recipients: true },
      }),
    );
  it('preview creates no delivery, active scans deduplicate overlaps, and the typed in-app runner dispatches once', async () => {
    const x = await setup('realtime', { email: false, inApp: true }, true);
    expect(await deliveries()).toHaveLength(0);
    expect((await keywords.enqueue(tenant)).queued).toBe(1);
    expect((await keywords.enqueue(tenant)).queued).toBe(0);
    await discovery.activation(ctx, x.rule.id, {
      action: 'pause',
      expectedVersion: x.rule.version,
    });
    expect((await runner.drain(tenant, 25, new Date(), 'bill_keyword')).attempted).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String((global.fetch as jest.Mock).mock.calls[0]![0])).toContain(
      '/keyword-notification',
    );
    expect((await deliveries())[0]!.recipients[0]!.state).toBe('provider_accepted');
    await runner.drain(tenant, 25, new Date(), 'bill_keyword');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('retains stale occurrences as held and runtime pause produces zero provider calls', async () => {
    const x = await setup();
    await p.$executeRaw`UPDATE state_bill SET title=title||' changed again' WHERE id=${x.bill}`;
    await keywords.enqueue(tenant);
    const row = (await deliveries()).find((d) => (d.composition as any).billId === x.bill)!;
    expect(row.recipients[0]!.state).toBe('held');
    expect(row.recipients[0]!.error).toBeTruthy();
    process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED = 'false';
    expect((await runner.drain(tenant, 25, new Date(), 'bill_keyword')).attempted).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED = 'true';
  });
  it('rechecks channel opt-out after enqueue and records control changes', async () => {
    const x = await setup();
    await keywords.enqueue(tenant);
    await keywords.activation(ctx, x.rule.id, { enabled: false, expectedVersion: x.rule.version });
    const result = await runner.drain(tenant, 25, new Date(), 'bill_keyword');
    expect(result.held).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
    const history = await folders.withActor(
      ctx,
      (tx) =>
        tx.$queryRaw<
          any[]
        >`SELECT * FROM intel_legiwatch_keyword_control_history WHERE rule_id=${x.rule.id}`,
    );
    expect(history.length).toBeGreaterThanOrEqual(3);
    const retained = await keywords.history(ctx, x.rule.id);
    expect(retained.deliveries).toHaveLength(1);
    const ready = await keywords.readiness(ctx, x.rule.id);
    await keywords.activation(ctx, x.rule.id, {
      enabled: true,
      expectedVersion: x.rule.version,
      previewHash: ready.previewHash,
    });
    await runner.retryHeld(ctx, retained.deliveries[0]!.recipients[0]!.id, {
      contentHash: retained.deliveries[0]!.contentHash,
      reason: 'Reviewed restored staff channel and current source',
    });
    await runner.drain(tenant, 25, new Date(), 'bill_keyword');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps an unconfirmed provider result uncertain until explicit reconciliation', async () => {
    const x = await setup();
    await keywords.enqueue(tenant);
    global.fetch = jest.fn(async () => {
      throw Error('connection lost after API commit');
    });
    await runner.drain(tenant, 25, new Date(), 'bill_keyword');
    const row = (await deliveries()).find((d) => (d.composition as any).billId === x.bill)!;
    expect(row.recipients[0]!.state).toBe('uncertain');
    await runner.drain(tenant, 25, new Date(), 'bill_keyword');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not label an API-suppressed inbox notification as delivered', async () => {
    const x = await setup();
    await keywords.enqueue(tenant);
    global.fetch = jest.fn(
      async () => ({ ok: true, json: async () => ({ created: 0, suppressed: true }) }) as Response,
    );
    await runner.drain(tenant, 25, new Date(), 'bill_keyword');
    expect(
      (await deliveries()).find((d) => (d.composition as any).billId === x.bill)!.recipients[0]!
        .state,
    ).toBe('terminal');
  });
  it('groups end-of-day occurrences only at the reviewed local cutoff, including DST', async () => {
    const x = await setup('end_of_day', { email: true, inApp: false });
    await keywords.enqueue(tenant);
    const original = (await deliveries()).find((d) => (d.composition as any).billId === x.bill)!;
    const due = original.recipients[0]!.nextAttemptAt;
    expect(await runner.bundleEndOfDay(tenant, new Date(due.getTime() - 1), 'bill_keyword')).toBe(
      0,
    );
    expect(await runner.bundleEndOfDay(tenant, due, 'bill_keyword')).toBe(1);
    expect(await runner.bundleEndOfDay(tenant, due, 'bill_keyword')).toBe(0);
    await runner.drain(tenant, 25, due, 'bill_keyword');
    expect(email.sendReport).toHaveBeenCalledTimes(1);
    expect(localOccurrence('2026-03-08', 1020, 'America/New_York').toISOString()).toBe(
      '2026-03-08T21:00:00.000Z',
    );
    expect(localOccurrence('2026-11-01', 1020, 'America/New_York').toISOString()).toBe(
      '2026-11-01T22:00:00.000Z',
    );
  });
  it('enforces owner RLS and immutable control history under the application role', async () => {
    const own = await folders.withActor(ctx, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      return tx.$queryRaw<any[]>`SELECT * FROM intel_legiwatch_keyword_control_history`;
    });
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.owner_clerk_id === actor && r.tenant_id === tenant)).toBe(true);
    const other = await folders.withActor({ ...ctx, clerkUserId: 'other' }, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      return tx.$queryRaw<any[]>`SELECT * FROM intel_legiwatch_keyword_control_history`;
    });
    expect(other).toHaveLength(0);
    await expect(
      folders.withActor(ctx, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        await tx.$executeRaw`DELETE FROM intel_legiwatch_keyword_control_history WHERE tenant_id=${tenant}`;
      }),
    ).rejects.toThrow();
    const rule = (await rules.list(ctx))[0]!;
    const source = (await rules.sources.page(rule.config.scope)).rows[0]!;
    await expect(
      folders.withActor(ctx, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        return rules.sources.lockBill(tx, rule.config.scope, source.bill.id);
      }),
    ).resolves.toMatchObject({ bill: { id: source.bill.id } });
  });
});
