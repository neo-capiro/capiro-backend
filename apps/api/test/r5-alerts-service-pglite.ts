/** PGlite integration of the actual R5 service using a thin Prisma query adapter. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Prisma } from '@prisma/client';
import { R5DistrictAlertsService, type DistrictAlertEvent } from '../src/district-nexus/r5-action-layer/r5-alerts.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';

const req = createRequire(resolve('apps/api/package.json'));
const { PGlite } = req('@electric-sql/pglite');
const tenant = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const client = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const other = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const since = new Date('2020-01-01');
const event: DistrictAlertEvent = {
  changeId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', dedupeKey: 'original-key',
  changeKind: 'amount_changed', source: 'gsa', sourceLabel: 'GSA FRPP', sourceRecordId: 'rec',
  stateCode: 'TX', districtCode: '08', severity: 'material', isStatewide: false,
  oldState: null, newState: 'changed', observedAt: new Date(), detectedAt: new Date(),
  sourceYear: null, observationKind: 'change', title: 'Original event', sourceFreshness: 'unknown',
  districtLabel: 'TX-08',
};

async function main() {
  const db = await PGlite.create();
  await db.exec(`
    CREATE TABLE intel_feature_flag(feature text, tenant_id text, enabled boolean, PRIMARY KEY(feature,tenant_id));
    CREATE TABLE clients(id uuid PRIMARY KEY, tenant_id uuid, name text, status text, profile_status text);
    CREATE TABLE client_facilities(client_id uuid, tenant_id uuid, state varchar(2), congressional_district varchar(2), geocode_status text, district_source text);
    CREATE TABLE alert_preference(id uuid DEFAULT gen_random_uuid(), tenant_id uuid, client_id uuid, user_id text, triggers text[], materiality text DEFAULT 'medium', UNIQUE(user_id,client_id));
    CREATE TABLE notification_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, client_id uuid, user_id text, alert_id text, channel text, status text, error text, created_at timestamptz DEFAULT now(), UNIQUE(alert_id,user_id,channel));
    CREATE TABLE district_nexus_change(id uuid PRIMARY KEY, dedupe_key text);
    CREATE TABLE district_nexus_alert_payload(notification_log_id uuid PRIMARY KEY REFERENCES notification_log(id), tenant_id uuid, client_id uuid, state_code varchar(2), district_code varchar(8), payload jsonb);
  `);
  await db.query('INSERT INTO clients VALUES ($1,$2,$3,$4,$5),($6,$2,$7,$4,$5)', [client, tenant, 'Pilot', 'active', 'ACTIVE', other, 'Other']);
  await db.query('INSERT INTO client_facilities VALUES ($1,$2,$3,$4,$5,$6)', [client, tenant, 'TX', '08', 'matched', 'geocoded']);
  await db.query('INSERT INTO district_nexus_change VALUES ($1,$2)', [event.changeId, event.dedupeKey]);
  await db.query('INSERT INTO alert_preference(tenant_id,client_id,user_id,triggers) VALUES ($1,$2,$3,$4)', [tenant, client, 'pilot-user', ['district_nexus_change', 'other_trigger']]);
  let active: { query: typeof db.query } | null = null;
  const run = async (sql: string, values: unknown[] = []) => (await (active ?? db).query(sql, values)).rows;
  const raw = async (input: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {

    const sql = 'sql' in input ? input : Prisma.sql(input, ...values.slice(0, input.length - 1));
    let index = 0;
    const text = sql.sql.replaceAll('?', () => `$${++index}`);
    return run(text, sql.values as unknown[]);
  };
  let failPayload = false;
  const tx = {
    $queryRaw: raw,
    $executeRaw: async (sql: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
      if (failPayload) { failPayload = false; throw new Error('payload persistence failed'); }
      return (await raw(sql, ...values)).length;
    },
    client: { findFirstOrThrow: async ({ where }: { where: { id: string; tenantId: string } }) => {
      const rows = await run('SELECT id FROM clients WHERE id=$1 AND tenant_id=$2 AND status<>\'archived\' AND profile_status=\'ACTIVE\'', [where.id, where.tenantId]);
      if (!rows.length) throw new Error('not found');
      return rows[0];
    } },
    clientFacility: { findMany: async ({ where }: { where: { tenantId: string; state: string; congressionalDistrict: string | { not: null } } }) => {
      const rows = await run(`SELECT f.client_id AS "clientId", c.name FROM client_facilities f JOIN clients c ON c.id=f.client_id
        WHERE f.tenant_id=$1 AND f.state=$2 AND f.geocode_status='matched' AND f.district_source='geocoded'
        AND c.status<>'archived' AND c.profile_status='ACTIVE' AND ($3::text IS NULL OR f.congressional_district=$3)`,
        [where.tenantId, where.state, typeof where.congressionalDistrict === 'string' ? where.congressionalDistrict : null]);
      return rows.map((r: { clientId: string; name: string }) => ({ clientId: r.clientId, client: { name: r.name } }));
    } },
    alertPreference: {
      findMany: async () => (await run('SELECT id,user_id AS "userId",triggers,materiality FROM alert_preference WHERE client_id=$1', [client])),
      findUnique: async ({ where }: { where: { userId_clientId: { userId: string; clientId: string } } }) => (await run(
        'SELECT triggers FROM alert_preference WHERE user_id=$1 AND client_id=$2', [where.userId_clientId.userId, where.userId_clientId.clientId]))[0] ?? null,
      upsert: async ({ where, create, update }: { where: { userId_clientId: { userId: string; clientId: string } }; create: { tenantId: string }; update: { triggers: string[] } }) => run(
        'INSERT INTO alert_preference(tenant_id,client_id,user_id,triggers) VALUES ($1,$2,$3,$4) ON CONFLICT(user_id,client_id) DO UPDATE SET triggers=EXCLUDED.triggers',
        [create.tenantId, where.userId_clientId.clientId, where.userId_clientId.userId, update.triggers]),
    },
    notificationLog: {
      findUnique: async ({ where }: { where: { alertId_userId_channel: { alertId: string; userId: string; channel: string } } }) => {
        const k = where.alertId_userId_channel;
        return (await run('SELECT id,status FROM notification_log WHERE alert_id=$1 AND user_id=$2 AND channel=$3', [k.alertId, k.userId, k.channel]))[0] ?? null;
      },
      create: async ({ data }: { data: { tenantId: string; clientId: string; userId: string; alertId: string; channel: string; status: string; error?: string } }) => (await run(
        'INSERT INTO notification_log(tenant_id,client_id,user_id,alert_id,channel,status,error) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [data.tenantId,data.clientId,data.userId,data.alertId,data.channel,data.status,data.error ?? null]))[0],
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => run('UPDATE notification_log SET status=$1 WHERE id=$2', [data.status, where.id]),
      updateMany: async ({ where, data }: { where: { id: string; status: string | { not: string } }; data: { status: string; error?: string | null } }) => {
        const rows = await run('UPDATE notification_log SET status=$1,error=$2 WHERE id=$3 AND status=$4 RETURNING id', [data.status,data.error ?? null,where.id, typeof where.status === 'string' ? where.status : 'failed']);
        return { count: rows.length };
      },
    },
  };
  const prisma = {
    withTenant: async (_tenant: string, fn: (tx: typeof tx) => Promise<unknown>) => db.transaction(async (session: { query: typeof db.query }) => {
      active = session;
      try { return await fn(tx); } finally { active = null; }
    }),
    withSystem: async (fn: (tx: { $queryRaw: typeof raw }) => Promise<unknown>) => fn({ $queryRaw: raw }),
  } as unknown as PrismaService;
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new R5DistrictAlertsService(prisma, config);
  service.findAlertableChanges = async () => [event];
  service.getSourceFreshness = async () => 'unknown';
  const count = async (table: string) => Number((await run(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
  assert.equal(await service.isEnabled(tenant), false);
  assert.equal((await service.emitForTenant(tenant,'pilot',since,true)).delivered, 0);
  await run('INSERT INTO intel_feature_flag VALUES ($1,$2,true),($3,$2,true)', ['district_nexus_v2', tenant, 'district_nexus_r5_alerts']);

  assert.equal(await service.isEnabled(tenant), true);
  assert.equal((await service.findRelevantClients(tenant,event)).length, 1);
  assert.equal((await service.findRelevantClients(tenant,{ ...event, districtCode: '09' })).length, 0);
  assert.equal((await service.findRelevantClients(tenant,{ ...event, isStatewide: true, districtCode: '' })).length, 1);
  await run("UPDATE client_facilities SET geocode_status='no_match'");
  assert.equal((await service.findRelevantClients(tenant,event)).length, 0);
  await run("UPDATE client_facilities SET geocode_status='matched'");
  await run("UPDATE clients SET status='archived' WHERE id=$1", [client]);
  assert.equal((await service.findRelevantClients(tenant,event)).length, 0);
  await run("UPDATE clients SET status='active' WHERE id=$1", [client]);
  const dry = await service.emitForTenant(tenant,'pilot',since,false);
  assert.equal(dry.delivered,1);
  assert.equal(await count('notification_log'),0);
  assert.equal(await count('district_nexus_alert_payload'),0);
  const first = await service.emitForTenant(tenant,'pilot',since,true);

  assert.equal(first.delivered,1);
  assert.equal(await count('notification_log'),1);
  assert.equal(await count('district_nexus_alert_payload'),1);
  assert.equal((await service.emitForTenant(tenant,'pilot',since,true)).delivered,0);
  assert.equal(await count('notification_log'),1);
  assert.equal((await service.listClientAlerts(tenant,client,'TX','08'))[0].title,'Original event');
  await run("UPDATE district_nexus_change SET dedupe_key='changed' WHERE id=$1", [event.changeId]);
  assert.equal((await service.listClientAlerts(tenant,client))[0].title,'Original event');
  await run('DELETE FROM district_nexus_change WHERE id=$1', [event.changeId]);
  assert.equal((await service.listClientAlerts(tenant,client))[0].title,'Event no longer available');
  assert.equal((await service.listClientAlerts(tenant,other)).length,0);
  await service.verifyClientAccess(tenant,client);
  assert.equal(await service.getPreference(tenant,client,'pilot-user'),true);
  assert.equal(await service.setPreference(tenant,client,'pilot-user',false),false);
  assert.equal(await service.getPreference(tenant,client,'pilot-user'),false);
  assert.equal((await service.emitForTenant(tenant,'pilot',since,false)).delivered,0);
  assert.equal(await service.setPreference(tenant,client,'pilot-user',true),true);
  assert.equal(await service.getPreference(tenant,client,'pilot-user'),true);
  const triggers = (await run('SELECT triggers FROM alert_preference WHERE user_id=$1', ['pilot-user']))[0].triggers;
  assert.deepEqual(triggers,['other_trigger','district_nexus_change']);
  await run('UPDATE notification_log SET status=$1 WHERE client_id=$2', ['failed',client]);
  failPayload = true;
  assert.equal((await service.emitForTenant(tenant,'pilot',since,true)).delivered,0);
  assert.equal((await run('SELECT status FROM notification_log'))[0].status,'failed');
  assert.equal((await service.emitForTenant(tenant,'pilot',since,true)).delivered,1);
  assert.equal((await run('SELECT status FROM notification_log'))[0].status,'sent');
  assert.equal(await count('notification_log'),1);
  await run('DELETE FROM intel_feature_flag WHERE feature=$1', ['district_nexus_v2']);
  assert.equal(await service.isEnabled(tenant),false);
  console.log('PASS R5 service PGlite: flags, verified relevance, dry-run, atomic retry, snapshot, preferences (28 assertions)');
  await db.close();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
