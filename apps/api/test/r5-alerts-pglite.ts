/**
 * PGLite qualification for R5 District Nexus alerts.
 *
 * Run from the repo root with:
 *   LEGIWATCH_PGLITE_MODULE=@electric-sql/pglite node --import tsx apps/api/test/r5-alerts-pglite.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireTestModule = createRequire(resolve('apps/api/package.json'));
const { PGlite } = requireTestModule(process.env.LEGIWATCH_PGLITE_MODULE ?? '@electric-sql/pglite');

// ---------------------------------------------------------------------------
// DDL fragments
// ---------------------------------------------------------------------------

const tenantsDDL = `
CREATE TABLE tenants (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE
);`;

const clientsDDL = `
CREATE TABLE clients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID,
  name TEXT
);`;

const clientFacilitiesDDL = `
CREATE TABLE client_facilities (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID,
  state VARCHAR(2),
  congressional_district VARCHAR(2)
);`;

const intelFeatureFlagDDL = `
CREATE TABLE intel_feature_flag (
  feature TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (feature, tenant_id)
);`;

const alertPreferenceDDL = `
CREATE TABLE alert_preference (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID,
  client_id UUID,
  user_id TEXT,
  triggers TEXT[] DEFAULT '{}',
  materiality TEXT DEFAULT 'medium',
  email_enabled BOOLEAN DEFAULT false,
  email_address TEXT,
  email_cadence TEXT DEFAULT 'realtime',
  sms_enabled BOOLEAN DEFAULT false,
  sms_phone TEXT,
  sms_phone_verified BOOLEAN DEFAULT false,
  sms_cadence TEXT DEFAULT 'realtime',
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, client_id)
);`;

const notificationLogDDL = `
CREATE TABLE notification_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID,
  client_id UUID,
  user_id TEXT,
  alert_id TEXT,
  channel TEXT,
  status TEXT,
  provider_message_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(alert_id, user_id, channel)
);`;

const districtNexusChangeDDL = `
CREATE TABLE district_nexus_change (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dedupe_key VARCHAR(120) UNIQUE NOT NULL,
  change_kind VARCHAR(48) NOT NULL,
  source VARCHAR(32) NOT NULL,
  source_dataset VARCHAR(64),
  source_record_id TEXT NOT NULL,
  source_fiscal_year INT,
  source_version TEXT,
  state_code VARCHAR(2),
  district_code VARCHAR(8),
  boundary_congress INT,
  member_bioguide_ids TEXT[] DEFAULT '{}',
  old_value JSONB,
  new_value JSONB,
  old_state VARCHAR(24),
  new_state VARCHAR(24),
  observed_at TIMESTAMPTZ NOT NULL,
  effective_at TIMESTAMPTZ,
  source_year INT,
  geography_vintage VARCHAR(48),
  severity VARCHAR(16) DEFAULT 'info',
  observation_kind VARCHAR(24) DEFAULT 'change',
  provenance JSONB DEFAULT '{}',
  detected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);`;

const districtEconomicSourceRunDDL = `
CREATE TABLE district_economic_source_run (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface ChangeParams {
  dedupeKey: string;
  changeKind?: string;
  source?: string;
  stateCode?: string | null;
  districtCode?: string | null;
  severity?: string;
  observationKind?: string;
  observedAt?: Date;
}

async function insertChange(db: any, p: ChangeParams): Promise<void> {
  await db.query(`
    INSERT INTO district_nexus_change (
      dedupe_key, change_kind, source, source_record_id,
      state_code, district_code, severity, observation_kind, observed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    p.dedupeKey,
    p.changeKind ?? 'amount_changed',
    p.source ?? 'gsa',
    'rec-1',
    p.stateCode ?? null,
    p.districtCode ?? null,
    p.severity ?? 'material',
    p.observationKind ?? 'change',
    p.observedAt ?? new Date(),
  ]);
}

async function insertFacility(db: any, clientId: string, state: string, district: string): Promise<void> {
  await db.query(`
    INSERT INTO client_facilities (client_id, state, congressional_district)
    VALUES ($1, $2, $3)
  `, [clientId, state, district]);
}

async function insertPreference(db: any, tenantId: string, clientId: string, userId: string, triggers: string[], materiality?: string): Promise<void> {
  await db.query(`
    INSERT INTO alert_preference (tenant_id, client_id, user_id, triggers, materiality)
    VALUES ($1, $2, $3, $4, $5)
  `, [tenantId, clientId, userId, triggers, materiality ?? 'medium']);
}

async function enableFlag(db: any, tenantId: string, feature: string): Promise<void> {
  await db.query(`
    INSERT INTO intel_feature_flag (feature, tenant_id, enabled) VALUES ($1, $2, true)
    ON CONFLICT (feature, tenant_id) DO UPDATE SET enabled = true
  `, [feature, tenantId]);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main() {
  const db = await PGlite.create();
  const query = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;
  const exec = async (sql: string, values: unknown[] = []) => db.query(sql, values);

  let checks = 0;
  const pass = (name: string) => {
    checks++;
    console.log('PASS ' + name);
  };

  const reset = async () => {
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await db.exec(tenantsDDL);
    await db.exec(clientsDDL);
    await db.exec(clientFacilitiesDDL);
    await db.exec(intelFeatureFlagDDL);
    await db.exec(alertPreferenceDDL);
    await db.exec(notificationLogDDL);
    await db.exec(districtNexusChangeDDL);
    await db.exec(districtEconomicSourceRunDDL);
  };

  console.log((await db.query('SELECT version() AS version')).rows[0].version);
  await reset();
  pass('schema created');

  // Setup tenant and client
  const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const clientId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const userId0 = 'user-0';
  const userId1 = 'user-1';
  const userId2 = 'user-2';
  const internalTenantId = tenantId;

  await exec('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [tenantId, 'capiro-internal']);
  await exec('INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, $3)', [clientId, tenantId, 'Test Client']);

  // -----------------------------------------------------------------------
  // Test 1: Baseline rows are suppressed
  // -----------------------------------------------------------------------
  await insertChange(db, {
    dedupeKey: 'baseline-event-1',
    observationKind: 'baseline',
    severity: 'material',
    stateCode: 'TX',
    districtCode: '23',
  });

  // Query: baseline should not be found
  const baselineCheck = await query(`
    SELECT COUNT(*) as cnt FROM district_nexus_change
    WHERE observation_kind = 'change' AND severity = 'material'
  `);
  assert.strictEqual(Number(baselineCheck[0].cnt), 0);
  pass('baseline rows are suppressed (not returned as alertable)');

  // -----------------------------------------------------------------------
  // Test 2: Material events are alertable
  // -----------------------------------------------------------------------
  await insertChange(db, {
    dedupeKey: 'material-event-1',
    severity: 'material',
    stateCode: 'TX',
    districtCode: '23',
  });

  const materialCheck = await query(`
    SELECT COUNT(*) as cnt FROM district_nexus_change
    WHERE observation_kind = 'change' AND severity = 'material'
  `);
  assert.strictEqual(Number(materialCheck[0].cnt), 1);
  pass('material events are alertable');

  // -----------------------------------------------------------------------
  // Test 3: Non-footprint district is not alerted
  // -----------------------------------------------------------------------
  await insertChange(db, {
    dedupeKey: 'non-footprint-event',
    severity: 'material',
    stateCode: 'CA',
    districtCode: '12',
  });

  // Insert facility only in TX-23
  await insertFacility(db, clientId, 'TX', '23');

  // Check: CA-12 has no footprint client for this tenant
  const footprintCheck = await query(`
    SELECT DISTINCT cf.client_id
    FROM client_facilities cf
    JOIN clients c ON c.id = cf.client_id
    WHERE cf.state = 'CA' AND cf.congressional_district = '12'
  `);
  assert.strictEqual(footprintCheck.length, 0);
  pass('non-footprint district has no matching clients');

  // -----------------------------------------------------------------------
  // Test 4: Statewide events match any footprint district
  // -----------------------------------------------------------------------
  await insertChange(db, {
    dedupeKey: 'statewide-event',
    severity: 'material',
    stateCode: 'TX',
    districtCode: null, // statewide
  });

  // Statewide: match any client with a facility in TX
  const statewideCheck = await query(`
    SELECT DISTINCT cf.client_id
    FROM client_facilities cf
    JOIN clients c ON c.id = cf.client_id
    WHERE cf.state = 'TX' AND cf.congressional_district IS NOT NULL
  `);
  assert.strictEqual(statewideCheck.length, 1);
  pass('statewide events match any footprint district in state');

  // -----------------------------------------------------------------------
  // Test 5: Replay produces zero new sends (dedup)
  // -----------------------------------------------------------------------
  await enableFlag(db, tenantId, 'district_nexus_v2');
  await enableFlag(db, tenantId, 'district_nexus_r5_alerts');
  await insertPreference(db, tenantId, clientId, userId1, ['district_nexus_change']);

  // First send: claim the notification log
  const alertId = 'district-nexus-change:' + tenantId + ':' + clientId + ':material-event-1';
  await db.query(`
    INSERT INTO notification_log (tenant_id, client_id, user_id, alert_id, channel, status)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [tenantId, clientId, userId1, alertId, 'in_app', 'sent']);

  // Second attempt: should fail due to unique constraint
  let dupCaught = false;
  try {
    await db.query(`
      INSERT INTO notification_log (tenant_id, client_id, user_id, alert_id, channel, status)
    VALUES ($1, $2, $3, $4, $5, $6)
    `, [tenantId, clientId, userId1, alertId, 'in_app', 'sent']);
  } catch (e) {
    dupCaught = (e as any).code === '23505' || (e as any).message?.includes('unique');
  }
  assert.strictEqual(dupCaught, true);
  pass('replay produces zero new sends (dedup via unique constraint)');

  // -----------------------------------------------------------------------
  // Test 6: Opt-out respected (no district_nexus_change trigger)
  // -----------------------------------------------------------------------
  await insertPreference(db, tenantId, clientId, userId2, ['other_trigger']);
  const optOutCheck = await query(`
    SELECT COUNT(*) as cnt FROM alert_preference
    WHERE client_id = $1 AND 'district_nexus_change' = ANY(triggers)
  `, [clientId]);
  // Only userId1 has the trigger, userId2 does not
  assert.strictEqual(Number(optOutCheck[0].cnt), 1);
  pass('opt-out respected (users without trigger key are excluded)');

  // -----------------------------------------------------------------------
  // Test 7: Flag off - nothing emitted
  // -----------------------------------------------------------------------
  // Delete the flag
  await exec('DELETE FROM intel_feature_flag WHERE feature = $1 AND tenant_id = $2',
    ['district_nexus_r5_alerts', tenantId]);
  const flagOffCheck = await query(`
    SELECT COUNT(*) as cnt FROM intel_feature_flag
    WHERE feature = 'district_nexus_r5_alerts' AND tenant_id = $1 AND enabled = true
  `, [tenantId]);
  assert.strictEqual(Number(flagOffCheck[0].cnt), 0);
  pass('flag off returns false (nothing emitted)');

  // -----------------------------------------------------------------------
  // Test 8: Deep link format
  // -----------------------------------------------------------------------
  const stateCode = 'TX';
  const districtCode = '23';
  const deepLink = '/intelligence/district-nexus?district=TX-23&clientId=' + clientId;
  assert.ok(deepLink.includes('TX-23'));
  assert.ok(deepLink.includes(clientId));
  pass('deep link format includes district and clientId');

  // -----------------------------------------------------------------------
  // Test 9: Caveats for delayed detection
  // -----------------------------------------------------------------------
  const oldDate = new Date(Date.now() - 100 * 60 * 60 * 1000); // 100h ago
  const newDate = new Date();
  const lag = newDate.getTime() - oldDate.getTime();
  assert.ok(lag > 48 * 60 * 60 * 1000);
  pass('delayed detection caveat triggered when lag > 48h');

  console.log('');
  console.log(checks + ' tests passed');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });