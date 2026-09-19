import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TrackerEmailService } from '../tracker/notifications/tracker-email.service.js';
import { LegiWatchCommitteeNotificationService } from './legiwatch-committee-notification.service.js';

// Explicit disposable local database only. Never infer test authorization from
// the application's DATABASE_URL and never truncate shared application tables.
const testUrl = process.env.LEGIWATCH_COMMITTEE_TEST_DATABASE_URL;
const database = new URL(testUrl || 'postgresql://localhost/capiro_committee_alerts_unconfigured');
if (
  testUrl &&
  (!['localhost', '127.0.0.1'].includes(database.hostname) ||
    !/^\/capiro_committee_alerts_[a-z0-9_]+$/.test(database.pathname))
) {
  throw new Error('Committee alert tests require an explicitly selected local disposable database');
}
const describeDatabase = testUrl ? describe : describe.skip;

describeDatabase('committee alerts through production PrismaService and Postgres', () => {
  it('reconciles publications across tenants and batches and delivers only new eligible email with durable retries', async () => {
    const db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    const checks: string[] = [];
    const deliveries: Array<{ to: string; subject: string; html: string; text: string }> = [];
    let fail = false;
    const transport = {
      async send(to: string, subject: string, html: string, text: string) {
        assert.ok(to.endsWith('@example.invalid'));
        deliveries.push({ to, subject, html, text });
        return fail
          ? { sent: false, error: 'Deliberate transport failure' }
          : { sent: true, messageId: randomUUID() };
      },
    };
    const service = new LegiWatchCommitteeNotificationService(
      db,
      transport as unknown as TrackerEmailService,
      new ConfigService<AppConfig, true>({ LEGIWATCH_APP_BASE_URL: 'https://os.capiro.ai' }),
    );
    try {
      const identity = await db.$queryRawUnsafe<Array<{ name: string; role: string }>>(
        'SELECT current_database() AS name,current_user AS role',
      );
      assert.equal(identity[0]!.name, database.pathname.slice(1));
      const run = randomUUID(),
        ta = randomUUID(),
        tb = randomUUID(),
        ua = randomUUID(),
        ub = randomUUID();
      const parent = 'parent-' + run,
        child = 'child-' + run;
      for (const [tenant, user] of [
        [ta, ua],
        [tb, ub],
      ]) {
        await db.$executeRawUnsafe(
          "INSERT INTO tenants(id,slug,name,status,updated_at) VALUES($1::uuid,$2,'Committee proof','active',now())",
          tenant,
          'committee-' + tenant,
        );
        await db.$executeRawUnsafe(
          'INSERT INTO users(id,clerk_user_id,email,updated_at) VALUES($1::uuid,$2,$3,now())',
          user,
          'clerk-' + user,
          user + '@example.invalid',
        );
        await db.$executeRawUnsafe(
          "INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,updated_at) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'user_admin','active',now())",
          tenant,
          user,
        );
      }
      for (const [code, p] of [
        [parent, null],
        [child, parent],
      ] as Array<[string, string | null]>)
        await db.$executeRawUnsafe(
          "INSERT INTO congress_committee(system_code,thomas_id,name,chamber,is_current,parent_system_code) VALUES($1,$1,'Root proof','house',true,$2)",
          code,
          p,
        );
      async function follow(tenant: string, user: string, code: string) {
        await db.$executeRawUnsafe(
          'INSERT INTO legiwatch_committee_follow(tenant_id,user_id,committee_system_code,client_ids) VALUES($1::uuid,$2,$3,ARRAY[]::uuid[])',
          tenant,
          user,
          code,
        );
      }
      async function publication(
        label: string,
        { type = 'committee_memo_published', old = false } = {},
      ) {
        const key = run + ':' + label;
        await db.$executeRawUnsafe(
          "INSERT INTO committee_site_update(id,committee_system_code,update_type,normalized_title,source_url,content_hash,first_seen_at,last_seen_at,created_at,updated_at) VALUES($1,$2,$3,$4,'https://www.house.gov/',$1,now()-CASE WHEN $5 THEN interval '1 day' ELSE interval '0' END,now(),now()-CASE WHEN $5 THEN interval '1 day' ELSE interval '0' END,now())",
          key,
          parent,
          type,
          label,
          old,
        );
        return 'committee_update:' + key;
      }
      async function rows() {
        return db.$queryRawUnsafe<
          Array<{
            id: string;
            type: string;
            key: string;
            status: string | null;
            attempts: number;
            link: string;
            hearing: string | null;
          }>
        >(
          'SELECT id::text,event_type AS type,dedup_key AS key,email_delivery_status AS status,email_delivery_attempts AS attempts,deep_link AS link,hearing_id AS hearing FROM legiwatch_notification_event WHERE tenant_id=$1::uuid AND user_id=$2 ORDER BY created_at,id',
          ta,
          ua,
        );
      }
      await follow(ta, ua, child);
      await follow(tb, ub, parent);
      const old = await publication('Historical committee memo', { old: true });
      assert.equal(
        (await service.catchUpFollow({ tenantId: ta, userId: ua, committeeSystemCode: child }))
          .inserted,
        1,
      );
      assert.equal((await rows())[0]!.status, null);
      assert.equal((await rows())[0]!.hearing, null);
      assert.ok((await rows())[0]!.link.endsWith('?tab=updates'));
      assert.equal(
        (
          await db.$queryRawUnsafe<Array<{ n: number }>>(
            'SELECT count(*)::int AS n FROM legiwatch_notification_event WHERE tenant_id=$1::uuid',
            tb,
          )
        )[0]!.n,
        0,
      );
      await follow(ta, ua, parent);
      assert.equal(
        (await service.catchUpFollow({ tenantId: ta, userId: ua, committeeSystemCode: parent }))
          .inserted,
        0,
      );
      assert.equal((await rows()).length, 1);
      checks.push(
        'parent publication reaches subcommittee follower once; follow-both dedup; tenant isolation; nullable hearing route',
      );
      await db.$executeRawUnsafe(
        "INSERT INTO committee_site_update(id,committee_system_code,update_type,normalized_title,source_url,content_hash,first_seen_at,last_seen_at,created_at,updated_at) SELECT $1||':'||n,$2,'committee_memo_published','Burst '||n,'https://www.house.gov/',$1||':'||n,now(),now(),now(),now() FROM generate_series(1,425)n",
        run + ':burst',
        parent,
      );
      assert.equal((await service.syncFollow({ committeeSystemCode: child })).inserted, 400);
      assert.equal((await service.syncFollow({ committeeSystemCode: child })).inserted, 25);
      assert.equal((await service.syncFollow({ committeeSystemCode: parent })).inserted, 20); // tenant B initial bounded catch-up
      assert.equal((await rows()).length, 426);
      assert.ok((await rows()).every((r) => r.status === null));
      checks.push(
        '425 new observations survive multiple batches; initial catch-up capped at 20 for existing follower',
      );
      await db.$executeRawUnsafe(
        'INSERT INTO legiwatch_committee_email_preference(tenant_id,user_id,committee_email_enabled,email_address) VALUES($1::uuid,$2,true,$3)',
        ta,
        ua,
        ua + '@example.invalid',
      );
      assert.equal((await service.syncFollow({ committeeSystemCode: child })).inserted, 0);
      assert.equal((await service.drainEmail()).scanned, 0);
      assert.equal(deliveries.length, 0);
      checks.push('enabling email does not upgrade historical or previously in-app-only alerts');
      const future = await publication('Fresh publication <safe>');
      const announcement = await publication('Hearing announced', { type: 'hearing_announced' });
      assert.equal((await service.syncFollow({ committeeSystemCode: child })).inserted, 2);
      assert.equal((await rows()).find((r) => r.key === announcement)!.type, 'new_hearing');
      fail = true;
      const failed = await service.drainEmail();
      assert.equal(failed.retryScheduled, 2);
      assert.equal((await service.drainEmail()).scanned, 0);
      assert.ok(
        (await rows())
          .filter((r) => [future, announcement].includes(r.key))
          .every((r) => r.attempts === 1 && r.status === 'retry_wait'),
      );
      fail = false;
      await db.$executeRawUnsafe(
        "UPDATE legiwatch_notification_event SET email_delivery_next_attempt_at=now()-interval '1 second' WHERE tenant_id=$1::uuid AND email_delivery_status='retry_wait'",
        ta,
      );
      const retried = await service.drainEmail();
      assert.equal(retried.sent, 2);
      assert.ok(
        deliveries.every((r) => r.text.includes('https://os.capiro.ai/legiwatch/committees/')),
      );
      assert.ok(
        deliveries.find((r) => r.subject.includes('<safe>'))!.html.includes('&lt;safe&gt;'),
      );
      checks.push(
        'failed transport persists retry/backoff; later success; absolute safe links and HTML escaping',
      );
      const concurrent = await publication('Concurrent claim');
      await service.syncFollow({ committeeSystemCode: child });
      const before = deliveries.length;
      await Promise.all([service.drainEmail(), service.drainEmail()]);
      assert.equal(deliveries.length - before, 1);
      assert.equal((await rows()).find((r) => r.key === concurrent)!.status, 'sent');
      checks.push('two competing drain workers send one currently leased row');
      const crash = await publication('Recover abandoned lease');
      await service.syncFollow({ committeeSystemCode: child });
      await db.$executeRawUnsafe(
        "UPDATE legiwatch_notification_event SET email_delivery_status='sending',email_delivery_lease_until=now()-interval '1 second',email_delivery_lease_id='abandoned',email_delivery_attempts=1 WHERE tenant_id=$1::uuid AND dedup_key=$2",
        ta,
        crash,
      );
      assert.equal((await service.drainEmail()).sent, 1);
      checks.push('expired sending lease recovers after worker crash');
      const maxed = await publication('Exhausted crash attempts');
      await service.syncFollow({ committeeSystemCode: child });
      await db.$executeRawUnsafe(
        "UPDATE legiwatch_notification_event SET email_delivery_status='sending',email_delivery_lease_until=now()-interval '1 second',email_delivery_lease_id='abandoned',email_delivery_attempts=6 WHERE tenant_id=$1::uuid AND dedup_key=$2",
        ta,
        maxed,
      );
      const beforeMax = deliveries.length;
      assert.equal((await service.drainEmail()).terminalFailures, 1);
      assert.equal(deliveries.length, beforeMax);
      checks.push('crash recovery stops sending after six transport attempts');
      await db.$executeRawUnsafe(
        "INSERT INTO legiwatch_notification_event(tenant_id,user_id,event_type,hearing_id,committee_system_code,title,deep_link,dedup_key) VALUES($1::uuid,$2,'schedule_changed',$3,$4,'Hearing moved','/legiwatch/hearings/'||$3,$3)",
        ta,
        ua,
        run + ':lifecycle',
        parent,
      );
      assert.equal((await service.drainEmail()).sent, 1);
      checks.push('existing committee hearing lifecycle alerts use the same opt-in delivery queue');
      const unfollowed = await publication('Unfollow before drain');
      await service.syncFollow({ committeeSystemCode: child });
      await db.$executeRawUnsafe(
        'DELETE FROM legiwatch_committee_follow WHERE tenant_id=$1::uuid AND user_id=$2',
        ta,
        ua,
      );
      const beforeSuppressed = deliveries.length;
      assert.equal((await service.drainEmail()).suppressed, 1);
      assert.equal(deliveries.length, beforeSuppressed);
      assert.equal((await rows()).find((r) => r.key === unfollowed)!.status, 'suppressed');
      checks.push(
        'unfollow rechecked immediately before delivery and terminal suppression persisted',
      );
    } finally {
      await db.$disconnect();
    }
  }, 30_000);
});
