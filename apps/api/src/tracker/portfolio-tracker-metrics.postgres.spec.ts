import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { readTrackerMaterialChanges } from '@capiro/shared';
import { PrismaService as IntelPrisma } from '../../../intel-api/src/prisma/prisma.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readClientRecordedActivityIndex } from '../intelligence/client-recorded-activity-index.js';
import { LiveHearingsService } from '../live-hearings/live-hearings.service.js';
import { LegiWatchWave2CoverageService } from '../live-hearings/legiwatch-wave2-coverage.service.js';

// Requires the dedicated synthetic fixture with canonical Core/Intel tables,
// unique indexes and the SQL-owned account-owner compatibility column from
// migration 20260816235000_add_client_account_owner; never a shared/clone DB.
// No full production RLS/FK chain: this proves real driver types, scope predicates
// and producer values, not deployed auth, migration completeness or live freshness.
// Run serially; an interrupted source-error rename needs fixture-owner recovery.
const fixture = 'postgresql://portfolio_metrics_qa@127.0.0.1:55492/portfolio_metrics_test?schema=public';
const target = process.env.PORTFOLIO_METRICS_TEST_DATABASE_URL;
if (target !== undefined && target !== fixture) throw new Error('Refusing non-fixture Portfolio metrics database');

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const A = id(1), USER = id(2), CLIENT = id(3), B = id(4), OTHER_USER = id(5), OTHER_CLIENT = id(6);
const WALLED = id(7), ARCHIVED = id(8);
const actor: TenantContext = { tenantId: A, tenantSlug: 'metrics-a', userId: USER,
  clerkUserId: 'metrics-clerk-a', role: 'standard_user' };
const day = 86400000;

if (target === undefined) {
  test.skip('requires the explicit owned Portfolio metrics PostgreSQL fixture', () => {});
} else {
  describe('Portfolio metric producers with real Core and Intel Prisma drivers', () => {
    let core: PrismaService;
    let intel: IntelPrisma;
    let coverage: LegiWatchWave2CoverageService;
    let end: number;
    let recent: Date;

    beforeAll(async () => {
      core = new PrismaService({ datasources: { db: { url: target } } });
      intel = new IntelPrisma({ datasources: { db: { url: target } } });
      await core.$connect();
      await intel.$connect();
      const [scope] = await core.$queryRawUnsafe<Array<{ db: string; role: string; superuser: boolean; bypass: boolean }>>(
        `SELECT current_database() AS db,current_user AS role,rolsuper AS superuser,rolbypassrls AS bypass
         FROM pg_roles WHERE rolname=current_user`,
      );
      expect(scope).toEqual({ db: 'portfolio_metrics_test', role: 'portfolio_metrics_qa', superuser: false, bypass: false });
      coverage = new LegiWatchWave2CoverageService(core, new LiveHearingsService(core));
    });
    afterAll(async () => {
      await intel?.$disconnect();
      await core?.onModuleDestroy();
    });

    beforeEach(async () => {
      // Exact target and identity were checked before the first fixture write.
      // No CASCADE: an unexpected external dependency must fail, not be erased.
      await core.$executeRawUnsafe(`TRUNCATE mail_messages,mail_threads,meeting_preps,meeting_debriefs,
        outreach_records,engagement_tasks,meetings,engagement_connections,
        intel_watchlist_term,intel_watchlist_topic,intel_watchlist,
        intel_alert,intel_tracked_bill,intelligence_change,tracked_bill,client_watchlist,
        client_memory_access,clients,tenant_memberships,users,tenants,sync_run`);
      end = Date.now(); recent = new Date(end - 2 * day);
      const start = new Date(end - 21 * day), exactEnd = new Date(end);
      await core.$executeRawUnsafe(`INSERT INTO tenants(id,slug,name,status,updated_at)
        VALUES($1::uuid,'metrics-a','Synthetic firm A','active',now()),
        ($2::uuid,'metrics-b','Synthetic firm B','active',now())`, A, B);
      await core.$executeRawUnsafe(`INSERT INTO users(id,clerk_user_id,email,updated_at)
        VALUES($1::uuid,'metrics-clerk-a','metrics-a@example.invalid',now()),
        ($2::uuid,'metrics-clerk-b','metrics-b@example.invalid',now())`, USER, OTHER_USER);
      await core.$executeRawUnsafe(`INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status,updated_at)
        VALUES($1::uuid,$2::uuid,$3::uuid,'standard_user','active',now()),
        ($4::uuid,$5::uuid,$6::uuid,'standard_user','active',now())`, id(9), A, USER, id(10), B, OTHER_USER);
      await core.$executeRawUnsafe(`INSERT INTO clients(id,tenant_id,name,status,memory_wall,updated_at)
        VALUES($1::uuid,$2::uuid,'Synthetic open','active',false,now()),
        ($3::uuid,$4::uuid,'Synthetic other firm','active',false,now()),
        ($5::uuid,$2::uuid,'Synthetic wall','active',true,now()),
        ($6::uuid,$2::uuid,'Synthetic archive','archived',false,now())`, CLIENT, A, OTHER_CLIENT, B, WALLED, ARCHIVED);
      await core.$executeRawUnsafe(`INSERT INTO tracked_bill(id,tenant_id,client_id,bill_id,updated_at)
        VALUES($1::uuid,$2::uuid,$3::uuid,'119-hr-1',now()),
        ($4::uuid,$2::uuid,$3::uuid,'119-hr-2',now()),
        ($5::uuid,$6::uuid,$7::uuid,'119-hr-1',now())`, id(11), A, CLIENT, id(12), id(13), B, OTHER_CLIENT);
      await core.$executeRawUnsafe(`INSERT INTO intelligence_change
        (id,source,change_type,title,description,data,related_client_ids,detected_at) VALUES
        (gen_random_uuid(),'congress_bill','bill_text_updated','Synthetic','Synthetic',
          '{"bill_id":"119-hr-1"}',ARRAY[$1::uuid],$2::timestamptz),
        (gen_random_uuid(),'congress_bill','bill_text_updated','Synthetic','Synthetic',
          '{"bill_id":"119-hr-1"}',ARRAY[$1::uuid],$3::timestamptz),
        (gen_random_uuid(),'congress_bill','bill_text_updated','Synthetic','Synthetic',
          '{"bill_id":"119-hr-2"}',ARRAY[$1::uuid],$4::timestamptz),
        (gen_random_uuid(),'congress_bill','bill_text_updated','Synthetic','Synthetic',
          '{"bill_id":"119-hr-999"}',ARRAY[$1::uuid],$2::timestamptz),
        (gen_random_uuid(),'congress_bill','bill_text_updated','Synthetic','Synthetic',
          '{"bill_id":"119-hr-2"}',ARRAY[$5::uuid],$2::timestamptz)`, CLIENT, recent, start, exactEnd, OTHER_CLIENT);
      await core.$executeRawUnsafe(`INSERT INTO intel_tracked_bill(id,tenant_id,client_id,bill_id,source,updated_at)
        VALUES('metrics-intel-1',$1,$2,'119-hr-1','congress',now()),
        ('metrics-intel-2',$1,$2,'fl-hb-1','state',now()),
        ('metrics-intel-other',$3,$4,'119-hr-1','congress',now())`, A, CLIENT, B, OTHER_CLIENT);
      await core.$executeRawUnsafe(`INSERT INTO intel_alert
        (id,tenant_id,client_id,source_type,source_ref,kind,severity,materiality,title,change_type,created_at) VALUES
        ('metrics-event-1',$1,$2,'bill','119-hr-1','change','info','material','Synthetic','bill_text_updated',$3::timestamptz),
        ('metrics-event-2',$1,$2,'bill','119-hr-1','change','info','material','Synthetic','bill_text_updated',$4::timestamptz),
        ('metrics-event-end',$1,$2,'state_bill','fl-hb-1','change','info','material','Synthetic','bill_text_updated',$5::timestamptz),
        ('metrics-event-untracked',$1,$2,'bill','119-hr-999','change','info','material','Synthetic','bill_text_updated',$3::timestamptz),
        ('metrics-event-other',$6,$7,'bill','119-hr-1','change','info','material','Synthetic','bill_text_updated',$3::timestamptz)`,
      A, CLIENT, recent, start, exactEnd, B, OTHER_CLIENT);
      await core.$executeRawUnsafe(`INSERT INTO intel_watchlist(id,tenant_id,client_id,name,created_by,updated_at,jurisdictions,active)
        VALUES('metrics-watch-a',$1,$2,'Synthetic monitoring','metrics-clerk-a',now(),ARRAY['US'],true),
        ('metrics-watch-b',$3,$4,'Other firm monitoring','metrics-clerk-b',now(),ARRAY['US'],true)`, A, CLIENT, B, OTHER_CLIENT);
      await core.$executeRawUnsafe(`INSERT INTO intel_watchlist_topic(id,watchlist_id,tenant_id,label)
        VALUES('metrics-topic-a','metrics-watch-a',$1,'Synthetic bills'),
        ('metrics-topic-b','metrics-watch-b',$2,'Other firm bills')`, A, B);
      await core.$executeRawUnsafe(`INSERT INTO intel_watchlist_term(id,watchlist_id,tenant_id,topic_id,term_type,value)
        VALUES('metrics-term-a','metrics-watch-a',$1,'metrics-topic-a','bill','119-hr-1'),
        ('metrics-term-b','metrics-watch-b',$2,'metrics-topic-b','bill','119-hr-1')`, A, B);
      await core.$executeRawUnsafe(`INSERT INTO sync_run(id,source,started_at,finished_at,status)
        VALUES($1::uuid,'sync-congress',now()-interval '1 minute',now(),'success')`, id(14));
    });

    const read = (backend: 'core' | 'intelligence', ctx = actor, clientId = CLIENT) =>
      readTrackerMaterialChanges(backend === 'core' ? core : intel, ctx, clientId, backend, {}, () => end);

    test.each(['core', 'intelligence'] as const)('%s counts real distinct tracked identities in the fixed half-open window', async backend => {
      // Duplicate events for the same identity count once; exactEnd is excluded.
      const result = await read(backend);
      expect(result).toMatchObject({ metric: 'tracker.material_changes', version: 1, backend, clientId: CLIENT,
        count: 1, sourceObservedAt: recent.toISOString(), complete: true, capped: false,
        asOf: new Date(end).toISOString(), observedAt: new Date(end).toISOString(),
        window: { start: new Date(end - 21 * day).toISOString(), end: new Date(end).toISOString(), bounds: '[start,end)', days: 21 } });
    });

    test.each(['core', 'intelligence'] as const)('%s applies current identity, tenant, archive, membership and wall authority', async backend => {
      for (const clientId of [OTHER_CLIENT, WALLED, ARCHIVED])
        await expect(read(backend, actor, clientId)).rejects.toMatchObject({ reason: 'client_not_readable' });
      await expect(read(backend, { ...actor, userId: OTHER_USER })).rejects.toMatchObject({ reason: 'client_not_readable' });
      await expect(read(backend, { ...actor, clerkUserId: 'metrics-clerk-b' })).rejects.toMatchObject({ reason: 'client_not_readable' });
      await expect(read(backend, { ...actor, userId: OTHER_USER, clerkUserId: 'metrics-clerk-b' })).rejects.toMatchObject({ reason: 'client_not_readable' });
      await core.$executeRawUnsafe(`UPDATE tenants SET status='suspended' WHERE id=$1::uuid`, A);
      await expect(read(backend)).rejects.toMatchObject({ reason: 'client_not_readable' });
      await core.$executeRawUnsafe(`UPDATE tenants SET status='active' WHERE id=$1::uuid`, A);
      await core.$executeRawUnsafe(`UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1::uuid`, A);
      await expect(read(backend)).rejects.toMatchObject({ reason: 'client_not_readable' });
      await core.$executeRawUnsafe(`UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1::uuid`, A);
      await core.$executeRawUnsafe(`INSERT INTO tracked_bill(id,tenant_id,client_id,bill_id,updated_at)
        VALUES($1::uuid,$2::uuid,$3::uuid,'119-hr-3',now())`, id(17), A, WALLED);
      await core.$executeRawUnsafe(`INSERT INTO intelligence_change
        (id,source,change_type,title,description,data,related_client_ids,detected_at)
        VALUES(gen_random_uuid(),'congress_bill','bill_text_updated','Synthetic','Synthetic',
          '{"bill_id":"119-hr-3"}',ARRAY[$1::uuid],$2::timestamptz)`, WALLED, recent);
      await core.$executeRawUnsafe(`INSERT INTO intel_tracked_bill(id,tenant_id,client_id,bill_id,source,updated_at)
        VALUES('metrics-intel-wall',$1,$2,'119-hr-3','congress',now())`, A, WALLED);
      await core.$executeRawUnsafe(`INSERT INTO intel_alert
        (id,tenant_id,client_id,source_type,source_ref,kind,severity,materiality,title,change_type,created_at)
        VALUES('metrics-wall-event',$1,$2,'bill','119-hr-3','change','info','material','Synthetic','bill_text_updated',$3::timestamptz)`, A, WALLED, recent);
      await expect(read(backend, actor, WALLED)).rejects.toMatchObject({ reason: 'client_not_readable' });
      await core.$executeRawUnsafe(`INSERT INTO client_memory_access(id,tenant_id,client_id,user_id)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`, id(15), A, WALLED, USER);
      await expect(read(backend, actor, WALLED)).resolves.toMatchObject({ count: 1, sourceObservedAt: recent.toISOString(), complete: true });
      await core.$executeRawUnsafe(`DELETE FROM client_memory_access WHERE client_id=$1::uuid`, WALLED);
      await core.$executeRawUnsafe(`UPDATE tenant_memberships SET role='capiro_admin' WHERE tenant_id=$1::uuid`, A);
      try {
        await expect(read(backend, { ...actor, role: 'capiro_admin' }, WALLED)).rejects.toMatchObject({ reason: 'client_not_readable' });
      } finally {
        await core.$executeRawUnsafe(`UPDATE tenant_memberships SET role='standard_user' WHERE tenant_id=$1::uuid`, A);
      }
    });

    test('coverage joins real Intel configuration to Core scope and source freshness', async () => {
      const value = await coverage.watchlistCoverage(actor, CLIENT, 'intelligence');
      expect(value).toMatchObject({ backend: 'intelligence', clientId: CLIENT,
        configuration: { model: 'intel_watchlist', configured: true, complete: true, topicCount: 1 },
        overall: { coveredConcepts: 1, totalConcepts: 1, percentage: 100, status: 'COVERED' },
        concepts: [{ conceptId: 'metrics-topic-a', signalFamilies: ['bill'], status: 'COVERED' }] });
      expect(Number.isFinite(Date.parse(value.asOf))).toBe(true);
      await expect(coverage.watchlistCoverage(actor, CLIENT, 'core')).resolves.toMatchObject({
        overall: { status: 'NOT_CONFIGURED', percentage: null } });
      await core.$executeRawUnsafe(`INSERT INTO client_watchlist(id,tenant_id,client_id,tags,updated_at)
        VALUES($1::uuid,$2::uuid,$3::uuid,'[{"tag":"Synthetic"}]'::jsonb,now())`, id(16), A, CLIENT);
      await expect(coverage.watchlistCoverage(actor, CLIENT, 'core')).resolves.toMatchObject({
        configuration: { model: 'client_watchlist', configured: true, complete: false },
        overall: { status: 'UNSUPPORTED', percentage: null } });
      await expect(coverage.watchlistCoverage(actor, OTHER_CLIENT, 'intelligence')).rejects.toMatchObject({ status: 404 });
    });

    test('coverage withholds a complete percentage for flat terms and preserves stale and empty states', async () => {
      await core.$executeRawUnsafe(`INSERT INTO intel_watchlist_term(id,watchlist_id,tenant_id,term_type,value)
        VALUES('metrics-flat','metrics-watch-a',$1,'bill','119-hr-2')`, A);
      await expect(coverage.watchlistCoverage(actor, CLIENT, 'intelligence')).resolves.toMatchObject({
        configuration: { complete: false, flatTermCount: 1 }, overall: { status: 'PARTIAL', percentage: null } });
      await core.$executeRawUnsafe(`DELETE FROM intel_watchlist_term WHERE id='metrics-flat'`);
      await core.$executeRawUnsafe(`UPDATE sync_run SET finished_at=now()-interval '8 days' WHERE source='sync-congress'`);
      await expect(coverage.watchlistCoverage(actor, CLIENT, 'intelligence')).resolves.toMatchObject({
        overall: { status: 'STALE', coveredConcepts: 0 }, concepts: [{ status: 'STALE' }] });
      await core.$executeRawUnsafe(`DELETE FROM intel_watchlist_term WHERE watchlist_id='metrics-watch-a'`);
      await core.$executeRawUnsafe(`DELETE FROM intel_watchlist_topic WHERE watchlist_id='metrics-watch-a'`);
      await core.$executeRawUnsafe(`DELETE FROM intel_watchlist WHERE id='metrics-watch-a'`);
      await expect(coverage.watchlistCoverage(actor, CLIENT, 'intelligence')).resolves.toMatchObject({
        configuration: { configured: false }, overall: { status: 'NOT_CONFIGURED', percentage: null } });
    });

    test('an actual PostgreSQL source error rejects instead of becoming complete zero', async () => {
      await core.$executeRawUnsafe('ALTER TABLE intel_alert RENAME TO portfolio_fixture_missing_alert');
      try {
        await expect(read('intelligence')).rejects.toMatchObject({ reason: 'source_unavailable' });
      } finally {
        await core.$executeRawUnsafe('ALTER TABLE portfolio_fixture_missing_alert RENAME TO intel_alert');
      }
    });

    test('recorded activity withholds all scores when the real source exceeds its capacity', async () => {
      await core.$executeRawUnsafe(`INSERT INTO meetings
        (id,tenant_id,client_id,created_by_user_id,subject,starts_at,ends_at,status,updated_at)
        SELECT gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'Synthetic capacity',
          $4::timestamptz,$4::timestamptz+interval '1 hour','completed',now()
        FROM generate_series(1,251)`, A, CLIENT, USER, recent);
      await expect(readClientRecordedActivityIndex(core, actor, CLIENT, undefined, () => new Date(end))).resolves.toMatchObject({
        status: 'incomplete', reason: 'capacity', score: null, priorScore: null,
        breakdown: null, priorBreakdown: null, trend: null });
    });

    test('recorded activity uses real owned metadata and rejects removed mail, peer activity and denied scope', async () => {
      const peer = await core.user.create({ data: { clerkUserId: 'metrics-peer', email: 'metrics-peer@example.invalid' } });
      await core.tenantMembership.create({ data: { tenantId: A, userId: peer.id, role: 'standard_user', status: 'active' } });
      const ownConnection = await core.integrationConnection.create({ data: {
        tenantId: A, provider: 'google_workspace', status: 'connected', createdByUserId: USER } });
      const peerConnection = await core.integrationConnection.create({ data: {
        tenantId: A, provider: 'google_workspace', status: 'connected', createdByUserId: peer.id } });
      for (const [creator, connection, date] of [
        [USER, ownConnection.id, recent], [USER, ownConnection.id, new Date(end - 9 * day)],
        [peer.id, peerConnection.id, recent],
      ] as const) {
        await core.meeting.create({ data: { tenantId: A, clientId: CLIENT, createdByUserId: creator,
          connectionId: connection, subject: 'Synthetic meeting', startsAt: date,
          endsAt: new Date(date.getTime() + 3600000), status: 'completed', source: 'google' } });
      }
      for (const [connection, removed] of [[ownConnection.id, false], [peerConnection.id, false], [ownConnection.id, true]] as const) {
        const thread = await core.mailThread.create({ data: { tenantId: A, clientId: CLIENT,
          connectionId: connection, source: 'google', subject: 'Synthetic mail', lastMessageAt: recent } });
        await core.mailMessage.create({ data: { tenantId: A, threadId: thread.id,
          connectionId: connection, source: 'google', removedAt: removed ? recent : null } });
      }
      const result = await readClientRecordedActivityIndex(core, actor, CLIENT, undefined, () => new Date(end));
      // One owned meeting (15) plus one active owned mail thread (2); the prior
      // week has one meeting. Peer metadata and removed messages must not count.
      expect(result).toMatchObject({ version: 1, measure: 'recorded_activity_index', status: 'complete',
        scope: { tenantId: A, actorUserId: USER, clientId: CLIENT }, score: 17, priorScore: 15, trend: 'stable',
        breakdown: { meetings: 1, emails: 1, tasksCompleted: 0, debriefs: 0, outreachSent: 0 },
        priorBreakdown: { meetings: 1, emails: 0, tasksCompleted: 0, debriefs: 0, outreachSent: 0 } });
      for (const clientId of [OTHER_CLIENT, WALLED, ARCHIVED])
        await expect(readClientRecordedActivityIndex(core, actor, clientId)).rejects.toMatchObject({ status: 404 });
      await core.$executeRawUnsafe(`UPDATE tenant_memberships SET role='capiro_admin' WHERE tenant_id=$1::uuid AND user_id=$2::uuid`, A, USER);
      try {
        await expect(readClientRecordedActivityIndex(core, { ...actor, role: 'capiro_admin' }, WALLED)).rejects.toMatchObject({ status: 404 });
      } finally {
        await core.$executeRawUnsafe(`UPDATE tenant_memberships SET role='standard_user' WHERE tenant_id=$1::uuid AND user_id=$2::uuid`, A, USER);
      }
      await core.$executeRawUnsafe(`UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1::uuid`, A);
      try {
        await expect(readClientRecordedActivityIndex(core, actor, CLIENT)).rejects.toMatchObject({ status: 403 });
      } finally {
        await core.$executeRawUnsafe(`UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1::uuid`, A);
      }
    });
  });
}
