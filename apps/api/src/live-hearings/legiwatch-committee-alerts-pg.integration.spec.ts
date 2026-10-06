import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { insertSiteUpdates } from '../hearing-discovery/canonical-hearing.repository.js';
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
      await publication('Official news with unknown publication date', {
        type: 'committee_news_published',
      });
      assert.equal((await service.syncFollow({ committeeSystemCode: child })).inserted, 0);
      assert.equal((await rows()).length, 1);
      checks.push(
        'undated committee news backfill stays in the feed without creating false fresh alerts',
      );
      const completedHearing = run + ':completed',
        upcomingHearing = run + ':upcoming';
      for (const [hearingId, status] of [
        [completedHearing, 'completed'],
        [upcomingHearing, 'scheduled'],
      ]) {
        await db.$executeRawUnsafe(
          "INSERT INTO committee_hearing(id,chamber,committee_name,title,date,event_status) VALUES($1,'Senate','Publication proof','Publication proof',CURRENT_DATE,$2)",
          hearingId,
          status,
        );
      }
      const documentCases: Array<[string, string, string, boolean]> = [
        ['completed testimony', 'witness_testimony_published', completedHearing, false],
        ['completed memo', 'committee_memo_published', completedHearing, false],
        ['upcoming testimony', 'witness_testimony_published', upcomingHearing, false],
        ['dated completed testimony', 'witness_testimony_published', completedHearing, true],
      ];
      const documentKeys: string[] = [];
      for (const [label, type, hearingId, dated] of documentCases) {
        const key = await publication(label, { type });
        documentKeys.push(key);
        await db.$executeRawUnsafe(
          'UPDATE committee_site_update SET hearing_id=$1,official_published_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END WHERE content_hash=$3',
          hearingId,
          dated,
          key.replace('committee_update:', ''),
        );
      }
      assert.equal((await service.syncFollow({ committeeSystemCode: child })).inserted, 2);
      const documentAlerts = (await rows())
        .filter((row) => documentKeys.includes(row.key))
        .map((row) => row.key)
        .sort();
      assert.deepEqual(documentAlerts, documentKeys.slice(2).sort());
      // Remove only this test's fixtures before the existing batch-size assertions.
      await db.$executeRawUnsafe(
        'DELETE FROM legiwatch_notification_event WHERE tenant_id=$1::uuid AND dedup_key=ANY($2::text[])',
        ta,
        documentKeys,
      );
      await db.$executeRawUnsafe(
        'DELETE FROM committee_site_update WHERE hearing_id=ANY($1::text[])',
        [completedHearing, upcomingHearing],
      );
      await db.$executeRawUnsafe('DELETE FROM committee_hearing WHERE id=ANY($1::text[])', [
        completedHearing,
        upcomingHearing,
      ]);
      checks.push(
        'completed undated testimony/memo backfill is silent; upcoming undated and dated completed testimony remain eligible',
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

  it('delivers namespaced Florida committee updates idempotently and tenant-locally', async () => {
    const db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    const deliveries: string[] = [];
    const service = new LegiWatchCommitteeNotificationService(
      db,
      {
        send: async (to: string) => {
          deliveries.push(to);
          return { sent: true, messageId: randomUUID() };
        },
      } as unknown as TrackerEmailService,
      new ConfigService<AppConfig, true>({ LEGIWATCH_APP_BASE_URL: 'https://os.capiro.ai' }),
    );
    const run = randomUUID();
    const committeeId = `official-${run}`;
    const committeeKey = `state:FL:${committeeId}`;
    const aliasId = `legacy-${run}`;
    const aliasKey = `state:FL:${aliasId}`;
    const tenants = [randomUUID(), randomUUID()];
    const users = [randomUUID(), randomUUID()];
    try {
      await db.$executeRawUnsafe(
        "INSERT INTO state_committee(id,state,chamber,name,official_source_key,legislative_session,source_evidence,last_synced_at) VALUES($1,'FL','senate','Florida proof',$2,'2099',$3::jsonb,now())",
        committeeId,
        `FL:2099:${run}`,
        JSON.stringify({ directory: { aliasIds: [aliasId] } }),
      );
      await db.$executeRawUnsafe(
        "INSERT INTO state_committee(id,state,chamber,name,legislative_session,last_synced_at) VALUES($1,'FL','senate','Legacy Florida proof','2099',now())",
        aliasId,
      );
      for (let i = 0; i < tenants.length; i++) {
        await db.$executeRawUnsafe(
          "INSERT INTO tenants(id,slug,name,status,updated_at) VALUES($1::uuid,$2,'Florida alert proof','active',now())",
          tenants[i],
          `fl-alert-${tenants[i]}`,
        );
        await db.$executeRawUnsafe(
          'INSERT INTO users(id,clerk_user_id,email,updated_at) VALUES($1::uuid,$2,$3,now())',
          users[i],
          `clerk-${users[i]}`,
          `${users[i]}@example.invalid`,
        );
        await db.$executeRawUnsafe(
          "INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,updated_at) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'user_admin','active',now())",
          tenants[i],
          users[i],
        );
        await db.$executeRawUnsafe(
          "INSERT INTO legiwatch_committee_email_preference(tenant_id,user_id,committee_email_enabled,email_address,updated_at) VALUES($1::uuid,$2,true,$3,clock_timestamp()-interval '1 second')",
          tenants[i],
          users[i],
          `${users[i]}@example.invalid`,
        );
        await db.$executeRawUnsafe(
          'INSERT INTO legiwatch_committee_follow(tenant_id,user_id,committee_system_code,client_ids) VALUES($1::uuid,$2,$3,ARRAY[]::uuid[])',
          tenants[i],
          users[i],
          committeeKey,
        );
      }
      const publish = async (label: string, streamCode = committeeKey) => {
        const hash = `${run}:${label}`;
        await db.$executeRawUnsafe(
          "INSERT INTO committee_site_update(id,committee_system_code,update_type,normalized_title,source_url,content_hash,first_seen_at,last_seen_at,created_at,updated_at) VALUES($1,$2,'committee_memo_published',$3,'https://www.flsenate.gov/Committees/',$1,now(),now(),now(),now())",
          hash,
          streamCode,
          label,
        );
      };
      const count = async (index: number) =>
        (
          await db.$queryRawUnsafe<Array<{ n: number }>>(
            'SELECT count(*)::int AS n FROM legiwatch_notification_event WHERE tenant_id=$1::uuid AND user_id=$2',
            tenants[index],
            users[index],
          )
        )[0]!.n;

      await publish('Initial Florida packet');
      for (let i = 0; i < tenants.length; i++)
        expect(
          await service.catchUpFollow({
            tenantId: tenants[i]!,
            userId: users[i]!,
            committeeSystemCode: committeeKey,
          }),
        ).toEqual({ inserted: 1 });
      expect(await count(0)).toBe(1);
      expect(await count(1)).toBe(1);
      const links = await db.$queryRawUnsafe<Array<{ link: string }>>(
        'SELECT deep_link AS link FROM legiwatch_notification_event WHERE tenant_id=$1::uuid',
        tenants[0],
      );
      expect(links[0]!.link).toBe(`/legiwatch/committees/FL/${committeeId}?tab=updates`);

      // The official room aggregates this verified legacy/provider alias. Its
      // official Follow must consume the same stream and keep an official deep
      // link rather than stranding the alert on the alias identity.
      await publish('Fresh Florida packet', aliasKey);
      expect(await service.syncFollow({ committeeSystemCode: committeeKey })).toEqual({
        recipients: 2,
        inserted: 2,
      });
      expect(await service.syncFollow({ committeeSystemCode: committeeKey })).toEqual({
        recipients: 2,
        inserted: 0,
      });
      expect(await count(0)).toBe(2);
      expect(await count(1)).toBe(2);
      const fresh = await db.$queryRawUnsafe<
        Array<{ code: string; link: string; status: string | null }>
      >(
        'SELECT committee_system_code AS code,deep_link AS link,email_delivery_status AS status FROM legiwatch_notification_event WHERE tenant_id=$1::uuid AND dedup_key=$2',
        tenants[0],
        `committee_update:${run}:Fresh Florida packet`,
      );
      expect(fresh).toEqual([
        {
          code: committeeKey,
          link: `/legiwatch/committees/FL/${committeeId}?tab=updates`,
          status: 'queued',
        },
      ]);
      expect(await service.drainEmail()).toMatchObject({ sent: 2 });
      expect(new Set(deliveries)).toEqual(
        new Set(users.map((userId) => `${userId}@example.invalid`)),
      );

      await db.$executeRawUnsafe(
        'DELETE FROM legiwatch_committee_follow WHERE tenant_id=$1::uuid AND user_id=$2',
        tenants[0],
        users[0],
      );
      await publish('After tenant A unfollowed', aliasKey);
      expect(await service.syncFollow({ committeeSystemCode: committeeKey })).toEqual({
        recipients: 1,
        inserted: 1,
      });
      expect(await count(0)).toBe(2);
      expect(await count(1)).toBe(3);
      expect(await service.drainEmail()).toMatchObject({ sent: 1 });
      expect(deliveries).toHaveLength(3);
    } finally {
      await db.$disconnect();
    }
  }, 30_000);

  it('classifies a publication racing follow creation against the atomic boundary', async () => {
    const db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    const deliveries: string[] = [];
    const service = new LegiWatchCommitteeNotificationService(
      db,
      {
        send: async (to: string) => {
          deliveries.push(to);
          return { sent: true, messageId: randomUUID() };
        },
      } as unknown as TrackerEmailService,
      new ConfigService<AppConfig, true>({ LEGIWATCH_APP_BASE_URL: 'https://os.capiro.ai' }),
    );
    const run = randomUUID();
    const tenant = randomUUID();
    const user = randomUUID();
    const committeeKey = `state:FL:budget/../rules?client=${run}#top`;
    let release!: () => void;
    let boundaryStored!: () => void;
    let boundaryError: unknown;
    const releaseGate = new Promise<void>((resolve) => (release = resolve));
    const boundaryGate = new Promise<void>((resolve) => (boundaryStored = resolve));
    try {
      await db.$executeRawUnsafe(
        "INSERT INTO tenants(id,slug,name,status,updated_at) VALUES($1::uuid,$2,'Boundary proof','active',now())",
        tenant,
        `boundary-${tenant}`,
      );
      await db.$executeRawUnsafe(
        'INSERT INTO users(id,clerk_user_id,email,updated_at) VALUES($1::uuid,$2,$3,now())',
        user,
        `clerk-${user}`,
        `${user}@example.invalid`,
      );
      await db.$executeRawUnsafe(
        "INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,updated_at) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'user_admin','active',now())",
        tenant,
        user,
      );
      await db.$executeRawUnsafe(
        "INSERT INTO legiwatch_committee_email_preference(tenant_id,user_id,committee_email_enabled,email_address,updated_at) VALUES($1::uuid,$2,true,$3,clock_timestamp()-interval '1 second')",
        tenant,
        user,
        `${user}@example.invalid`,
      );
      const historicalHash = `${run}:historical`;
      await db.$executeRawUnsafe(
        "INSERT INTO committee_site_update(id,committee_system_code,update_type,normalized_title,source_url,content_hash,first_seen_at,last_seen_at,created_at,updated_at) VALUES($1,$2,'committee_memo_published','Historical packet','https://www.flsenate.gov/',$1,clock_timestamp()-interval '1 second',clock_timestamp(),clock_timestamp()-interval '1 second',clock_timestamp())",
        historicalHash,
        committeeKey,
      );

      const followTransaction = db
        .withTenant(tenant, async (tx) => {
          await tx.$executeRaw`
            INSERT INTO legiwatch_committee_follow
              (tenant_id,user_id,committee_system_code,client_ids,created_at,updated_at)
            VALUES (${tenant}::uuid,${user},${committeeKey},ARRAY[]::uuid[],clock_timestamp(),clock_timestamp())`;
          expect(
            await service.initializeFollow(tx, {
              tenantId: tenant,
              userId: user,
              committeeSystemCode: committeeKey,
            }),
          ).toBe(1);
          boundaryStored();
          await releaseGate;
        })
        .catch((error) => {
          boundaryError = error;
          boundaryStored();
        });
      await boundaryGate;
      if (boundaryError) throw boundaryError;

      const freshHash = `${run}:fresh`;
      await db.$executeRawUnsafe(
        "INSERT INTO committee_site_update(id,committee_system_code,update_type,normalized_title,source_url,content_hash,first_seen_at,last_seen_at,created_at,updated_at) VALUES($1,$2,'committee_memo_published','Fresh packet','https://www.flsenate.gov/',$1,clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp())",
        freshHash,
        committeeKey,
      );
      release();
      await followTransaction;

      expect(await service.syncFollow({ committeeSystemCode: committeeKey })).toEqual({
        recipients: 1,
        inserted: 1,
      });
      const rows = await db.$queryRawUnsafe<
        Array<{ key: string; status: string | null; link: string }>
      >(
        'SELECT dedup_key AS key,email_delivery_status AS status,deep_link AS link FROM legiwatch_notification_event WHERE tenant_id=$1::uuid ORDER BY created_at,id',
        tenant,
      );
      expect(rows).toEqual([
        {
          key: `committee_update:${historicalHash}`,
          status: null,
          link: `/legiwatch/committees/FL/budget%2F..%2Frules%3Fclient%3D${run}%23top?tab=updates`,
        },
        {
          key: `committee_update:${freshHash}`,
          status: 'queued',
          link: `/legiwatch/committees/FL/budget%2F..%2Frules%3Fclient%3D${run}%23top?tab=updates`,
        },
      ]);
      expect((await service.drainEmail()).sent).toBe(1);
      expect(deliveries).toEqual([`${user}@example.invalid`]);
    } finally {
      release?.();
      await db.$disconnect();
    }
  }, 30_000);

  it('delivers a producer transaction that begins before the follow boundary and commits after it', async () => {
    const db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    const producer = new PrismaService({ datasources: { db: { url: testUrl! } } });
    const deliveries: string[] = [];
    const service = new LegiWatchCommitteeNotificationService(
      db,
      {
        send: async (to: string) => {
          deliveries.push(to);
          return { sent: true, messageId: randomUUID() };
        },
      } as unknown as TrackerEmailService,
      new ConfigService<AppConfig, true>({ LEGIWATCH_APP_BASE_URL: 'https://os.capiro.ai' }),
    );
    const run = randomUUID();
    const tenant = randomUUID();
    const user = randomUUID();
    const committeeKey = `state:FL:late-commit-${run}`;
    const updateHash = `${run}:late-commit`;

    let producerStarted!: () => void;
    let allowProducerInsert!: () => void;
    let producerAttempted!: () => void;
    let boundaryStored!: () => void;
    let allowFollowCommit!: () => void;
    const producerStartedGate = new Promise<void>((resolve) => (producerStarted = resolve));
    const producerInsertGate = new Promise<void>((resolve) => (allowProducerInsert = resolve));
    const producerAttemptGate = new Promise<void>((resolve) => (producerAttempted = resolve));
    const boundaryGate = new Promise<void>((resolve) => (boundaryStored = resolve));
    const followCommitGate = new Promise<void>((resolve) => (allowFollowCommit = resolve));
    let producerTransaction: Promise<void> | undefined;
    let followTransaction: Promise<void> | undefined;

    try {
      await db.$executeRawUnsafe(
        "INSERT INTO tenants(id,slug,name,status,updated_at) VALUES($1::uuid,$2,'Late commit proof','active',clock_timestamp())",
        tenant,
        `late-commit-${tenant}`,
      );
      await db.$executeRawUnsafe(
        'INSERT INTO users(id,clerk_user_id,email,updated_at) VALUES($1::uuid,$2,$3,clock_timestamp())',
        user,
        `clerk-${user}`,
        `${user}@example.invalid`,
      );
      await db.$executeRawUnsafe(
        "INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,updated_at) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'user_admin','active',clock_timestamp())",
        tenant,
        user,
      );
      await db.$executeRawUnsafe(
        "INSERT INTO legiwatch_committee_email_preference(tenant_id,user_id,committee_email_enabled,email_address,updated_at) VALUES($1::uuid,$2,true,$3,clock_timestamp()-interval '1 second')",
        tenant,
        user,
        `${user}@example.invalid`,
      );

      // Connection 1 starts before the follow exists, establishing the exact
      // PostgreSQL transaction_timestamp() ordering that previously lost rows.
      producerTransaction = producer.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT transaction_timestamp()`;
        producerStarted();
        await producerInsertGate;
        producerAttempted();
        expect(
          await insertSiteUpdates(
            tx,
            [
              {
                committeeSystemCode: committeeKey,
                hearingId: null,
                updateType: 'committee_memo_published',
                normalizedTitle: 'Late-committing Florida packet',
                normalizedSummary: 'Committed after the follow boundary.',
                sourceUrl: 'https://www.flsenate.gov/Committees/',
                officialPublishedAt: null,
                previousValue: null,
                newValue: null,
                contentHash: updateHash,
                parserVersion: 'late-commit-proof',
              },
            ],
            // Deliberately old source-observation time. Alert ordering must use
            // the post-lock persisted timestamp, not this caller timestamp.
            new Date('2000-01-01T00:00:00.000Z'),
            null,
          ),
        ).toBe(1);
      });
      await producerStartedGate;

      // Connection 2 wins the committee-stream lock, records the boundary and
      // holds the transaction open while the older producer attempts its write.
      followTransaction = db.withTenant(tenant, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO legiwatch_committee_follow
            (tenant_id,user_id,committee_system_code,client_ids,created_at,updated_at)
          VALUES (${tenant}::uuid,${user},${committeeKey},ARRAY[]::uuid[],
            clock_timestamp(),clock_timestamp())`;
        expect(
          await service.initializeFollow(tx, {
            tenantId: tenant,
            userId: user,
            committeeSystemCode: committeeKey,
          }),
        ).toBe(0);
        boundaryStored();
        await followCommitGate;
      });
      await boundaryGate;

      allowProducerInsert();
      await producerAttemptGate;
      // The producer is now blocked on the follow's advisory lock. Releasing
      // this gate commits the boundary first; producer persistence follows.
      allowFollowCommit();
      await followTransaction;
      await producerTransaction;

      expect(await service.syncFollow({ committeeSystemCode: committeeKey })).toEqual({
        recipients: 1,
        inserted: 1,
      });
      const rows = await db.$queryRawUnsafe<
        Array<{ key: string; status: string | null; createdAt: Date; boundary: Date }>
      >(
        `SELECT n.dedup_key AS key,n.email_delivery_status AS status,
          u.created_at AS "createdAt",f.alert_started_at AS boundary
         FROM legiwatch_notification_event n
         JOIN committee_site_update u ON n.dedup_key='committee_update:'||u.content_hash
         JOIN legiwatch_committee_follow f
           ON f.tenant_id=n.tenant_id AND f.user_id=n.user_id
          AND lower(f.committee_system_code)=lower(n.committee_system_code)
         WHERE n.tenant_id=$1::uuid AND n.user_id=$2`,
        tenant,
        user,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        key: `committee_update:${updateHash}`,
        status: 'queued',
      });
      expect(rows[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[0]!.boundary.getTime());
      expect((await service.drainEmail()).sent).toBe(1);
      expect(deliveries).toEqual([`${user}@example.invalid`]);
    } finally {
      allowProducerInsert?.();
      allowFollowCommit?.();
      await Promise.allSettled(
        [producerTransaction, followTransaction].filter((promise): promise is Promise<void> =>
          Boolean(promise),
        ),
      );
      await Promise.all([producer.$disconnect(), db.$disconnect()]);
    }
  }, 30_000);
});
