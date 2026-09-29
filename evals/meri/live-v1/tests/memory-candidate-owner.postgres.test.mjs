import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import { createAdapter } from '../fixture-provisioning/memory-candidate-runtime.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { planFixture, applyFixture, verifyFixture } from '../fixture-provisioning/provisioner.mjs';
import { AUTHORIZED_TENANTS, APPLY_CONFIRMATION } from '../fixture-provisioning/contract.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const configPath = process.env.MERI_FIXTURE_POSTGRES_CONFIG;
const TENANT = AUTHORIZED_TENANTS.T1.id;
const USER = '44444444-4444-4444-8444-444444444444';
const CLIENT = '11111111-1111-4111-8111-111111111111';

describe('built canonical memory candidate command runtime', { skip: !configPath }, () => {
  const schema = `meri_candidate_${randomUUID().replaceAll('-', '')}`;
  let pool, adapter, manifest, config;
  const beforeEnv = {
    database: process.env.DATABASE_URL,
    namespace: process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE,
  };

  before(async () => {
    const database = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(database.host, '127.0.0.1');
    assert.equal(database.port, 55433);
    assert.equal(database.database, 'postgres');
    assert.match(schema, /^meri_candidate_[a-f0-9]{32}$/u);
    pool = new Pool(database);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`
      CREATE TABLE "${schema}".tenants(id uuid PRIMARY KEY, slug text);
      CREATE TABLE "${schema}".tenant_memberships(tenant_id uuid, user_id uuid, status text);
      CREATE TABLE "${schema}".clients(id uuid PRIMARY KEY, tenant_id uuid, memory_wall boolean NOT NULL DEFAULT false);
      CREATE TABLE "${schema}".client_memory_access(tenant_id uuid, client_id uuid, user_id uuid);
      CREATE TABLE "${schema}".clio_memory(id uuid, tenant_id uuid, scope text, key text, owner_user_id uuid, client_id uuid);
      CREATE TABLE "${schema}".memory_candidate(
        id uuid PRIMARY KEY, tenant_id uuid, proposed_by uuid, source_kind text,
        scope text, client_id uuid, payload_jsonb jsonb, provenance_jsonb jsonb,
        duplicate_of_id uuid, status text, confidence float,
        source_type text, source_id text, memory_class text DEFAULT 'legacy_unclassified',
        memory_authority text DEFAULT 'legacy_unclassified', contradicts_memory_item_id uuid,
        conflict_status text, committed_memory_id uuid, committed_memory_item_id uuid,
        decided_at timestamptz, created_at timestamptz DEFAULT now(),
        governed_status text DEFAULT 'suggested', instructions_allowed boolean DEFAULT false,
        approved_at timestamptz, approved_by_user_id uuid
      )`);
    await pool.query(`INSERT INTO "${schema}".tenants VALUES ($1,$2),($3,$4)`, [
      TENANT,
      AUTHORIZED_TENANTS.T1.slug,
      AUTHORIZED_TENANTS.T2.id,
      AUTHORIZED_TENANTS.T2.slug,
    ]);
    await pool.query(`INSERT INTO "${schema}".tenant_memberships VALUES ($1,$2,'active')`, [
      TENANT,
      USER,
    ]);
    await pool.query(`INSERT INTO "${schema}".clients(id,tenant_id) VALUES ($1,$2),($3,$2)`, [
      CLIENT,
      TENANT,
      '22222222-2222-4222-8222-222222222222',
    ]);
    const url = new URL(`postgresql://${database.host}:${database.port}/${database.database}`);
    url.username = database.user;
    url.password = database.password;
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.href;
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'meri-foundation-20260928';
    config = {
      target: 'capiro-dev',
      fixtureNamespace: 'meri-foundation-20260928',
      tenants: AUTHORIZED_TENANTS,
      clients: {
        ASTER: { tenantId: 'T1', physicalId: CLIENT },
        BLUEHAVEN: { tenantId: 'T1', physicalId: '22222222-2222-4222-8222-222222222222' },
        CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
      },
      actors: { PAT: { tenantId: 'T1', userId: USER } },
      availableOwners: ['memory_candidate'],
    };
    manifest = await buildFixtureManifest(config);
    adapter = await createAdapter({ config });
  });

  after(async () => {
    await adapter?.close();
    for (const [key, value] of [
      ['DATABASE_URL', beforeEnv.database],
      ['MERI_SYNTHETIC_FIXTURE_NAMESPACE', beforeEnv.namespace],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (pool) {
      assert.match(schema, /^meri_candidate_[a-f0-9]{32}$/u);
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  it('creates and verifies pending client, firm and private proposals through the real service', async () => {
    const plan = await planFixture({ manifest, adapter });
    const result = await applyFixture({
      manifest,
      adapter,
      plan,
      confirmation: APPLY_CONFIRMATION,
    });
    assert.equal(
      result.status,
      'complete',
      JSON.stringify(
        result.records.filter((r) => r.outcome !== 'committed' && r.outcome !== 'verified_absent'),
      ),
    );
    const verified = await verifyFixture({ manifest, adapter });
    assert.equal(verified.status, 'complete');
    const replay = await planFixture({ manifest, adapter });
    assert.equal(replay.summary.creates, 0);
    assert.equal(replay.summary.replacements, 0);
    assert.equal(replay.summary.absent, 1);
    const rows = await pool.query(
      `SELECT scope,status,source_kind FROM "${schema}".memory_candidate`,
    );
    assert.deepEqual(
      new Set(rows.rows.map((row) => row.scope)),
      new Set(['client', 'firm', 'personal']),
    );
    assert.ok(
      rows.rows.every((row) => row.status === 'pending' && row.source_kind === 'model_extraction'),
    );
  });

  it('rejects a live environment without the explicit fixture opt-in', async () => {
    delete process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE;
    try {
      await assert.rejects(createAdapter({ config }), {
        code: 'MEMORY_CANDIDATE_RUNTIME_CONFIG_INVALID',
      });
    } finally {
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'meri-foundation-20260928';
    }
  });

  it('detects changed canonical content and refuses replacement', async () => {
    const record = manifest.records.find((row) => row.logicalId === 'MEM-PROPOSAL-14');
    await pool.query(
      `UPDATE "${schema}".memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','"changed"') WHERE id=$1`,
      [record.physicalId],
    );
    const verified = await verifyFixture({ manifest, adapter });
    assert.equal(
      verified.records.find((row) => row.logicalId === record.logicalId).errorCode,
      'ACTUAL_READBACK_MISMATCH',
    );
    const plan = await planFixture({ manifest, adapter });
    const result = await applyFixture({
      manifest,
      adapter,
      plan,
      confirmation: APPLY_CONFIRMATION,
    });
    assert.equal(result.status, 'failed');
    assert.equal(
      result.records.find((row) => row.logicalId === record.logicalId).errorCode,
      'MEMORY_CANDIDATE_REPLACE_REFUSED',
    );
  });

  it('detects an unauthorized governance promotion in persisted readback', async () => {
    const record = manifest.records.find((row) => row.logicalId === 'MEM-PROPOSAL-15');
    await pool.query(
      `UPDATE "${schema}".memory_candidate SET governed_status='active' WHERE id=$1`,
      [record.physicalId],
    );
    const row = await adapter.inspect(record);
    assert.equal(row.payloadSha256, null);
  });

  it('refuses reads after actor membership is revoked', async () => {
    await pool.query(
      `UPDATE "${schema}".tenant_memberships SET status='inactive' WHERE user_id=$1`,
      [USER],
    );
    try {
      await assert.rejects(
        adapter.inspect(manifest.records.find((row) => row.logicalId === 'MEM-PROPOSAL-15')),
        { code: 'MEMORY_CANDIDATE_ACTOR_NOT_MEMBER' },
      );
    } finally {
      await pool.query(
        `UPDATE "${schema}".tenant_memberships SET status='active' WHERE user_id=$1`,
        [USER],
      );
    }
  });

  it('rechecks the canonical client wall before returning fixture evidence', async () => {
    await pool.query(`UPDATE "${schema}".clients SET memory_wall=true WHERE id=$1`, [CLIENT]);
    try {
      await assert.rejects(
        adapter.inspect(manifest.records.find((row) => row.logicalId === 'MEM-PROPOSAL-15')),
        { code: 'MEMORY_CANDIDATE_CLIENT_NOT_ALLOWED' },
      );
    } finally {
      await pool.query(`UPDATE "${schema}".clients SET memory_wall=false WHERE id=$1`, [CLIENT]);
    }
  });
});
