import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  APPLY_CONFIRMATION,
  AUTHORIZED_TENANTS,
  RESET_CONFIRMATION,
} from '../fixture-provisioning/contract.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import {
  applyFixture,
  applyOwnedReset,
  planFixture,
  planOwnedReset,
} from '../fixture-provisioning/provisioner.mjs';

const CONFIG_PATH = 'C:/dev/cap-meri-foundation-evidence/private/local-postgres.json';
const DONOR_API_PACKAGE = 'C:/dev/cap-meri-foundation/apps/api/package.json';
const apiRequire = createRequire(pathToFileURL(DONOR_API_PACKAGE));
const { Pool } = apiRequire('pg');

const CLIENTS = Object.freeze({
  ASTER: {
    tenantId: 'T1',
    physicalId: '11111111-1111-4111-8111-111111111111',
    name: 'Aster Defense',
  },
  BLUEHAVEN: {
    tenantId: 'T1',
    physicalId: '22222222-2222-4222-8222-222222222222',
    name: 'Bluehaven Robotics',
  },
  CEDAR: {
    tenantId: 'T2',
    physicalId: '33333333-3333-4333-8333-333333333333',
    name: 'Cedar Aviation',
  },
});

function exactSchemaName(value) {
  if (!/^meri_fixture_[a-f0-9]{32}$/u.test(value)) throw new Error('invalid owned test schema');
  return `"${value}"`;
}

class NativeCanonicalMemoryAdapter {
  constructor(pool, schema) {
    this.pool = pool;
    this.schema = exactSchemaName(schema);
  }

  async inspect(record) {
    const result = await this.pool.query(
      `SELECT m.id::text,
              m.tenant_id::text,
              m.client_id::text,
              m.source_id,
              m.source_ref,
              m.source_content_hash,
              m.updated_at
         FROM ${this.schema}.memory_items m
         LEFT JOIN ${this.schema}.clients c
           ON c.id = m.client_id
          AND c.tenant_id = m.tenant_id
        WHERE m.id = $1::uuid
          AND (m.client_id IS NULL OR c.id IS NOT NULL)`,
      [record.physicalId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      physicalId: row.id,
      tenantId: row.tenant_id,
      owner: 'memory_item',
      ownership: {
        marker: { logicalId: row.source_id },
        markerSha256: row.source_ref,
      },
      payloadSha256: row.source_content_hash,
      rowVersion: row.updated_at.toISOString(),
    };
  }

  async createOwned(record, guards) {
    assert.equal(guards.expectedRowVersion, null);
    const result = await this.pool.query(
      `INSERT INTO ${this.schema}.memory_items
         (id, tenant_id, client_id, type, visibility, slug, title, source,
          source_ref, sections_jsonb, status, governed_status, source_type,
          source_id, source_content_hash)
       SELECT $1::uuid, $2::uuid, $3::uuid, 'fixture', 'tenant', $4, $4,
              'synthetic_fixture', $5, $6::jsonb, 'active', 'active',
              'synthetic_fixture', $4, $7
        WHERE $3::uuid IS NULL
           OR EXISTS (
             SELECT 1
               FROM ${this.schema}.clients c
              WHERE c.id = $3::uuid AND c.tenant_id = $2::uuid
           )
       RETURNING id`,
      [
        record.physicalId,
        guards.tenantId,
        record.clientPhysicalId,
        record.logicalId,
        guards.expectedOwnershipMarkerSha256,
        JSON.stringify(record.payload),
        record.payloadSha256,
      ],
    );
    if (result.rowCount !== 1) throw new Error('authoritative client join refused create');
  }

  async replaceOwned(record, guards) {
    const result = await this.pool.query(
      `UPDATE ${this.schema}.memory_items
          SET sections_jsonb = $1::jsonb,
              source_content_hash = $2,
              updated_at = clock_timestamp()
        WHERE id = $3::uuid
          AND tenant_id = $4::uuid
          AND source_ref = $5
          AND updated_at = $6::timestamptz`,
      [
        JSON.stringify(record.payload),
        record.payloadSha256,
        record.physicalId,
        guards.tenantId,
        guards.expectedOwnershipMarkerSha256,
        guards.expectedRowVersion,
      ],
    );
    if (result.rowCount !== 1) throw new Error('exact owner/version replace guard refused write');
  }

  async deleteOwned(record, guards) {
    const result = await this.pool.query(
      `DELETE FROM ${this.schema}.memory_items
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
          AND source_ref = $3
          AND updated_at = $4::timestamptz`,
      [
        record.physicalId,
        guards.tenantId,
        guards.expectedOwnershipMarkerSha256,
        guards.expectedRowVersion,
      ],
    );
    if (result.rowCount !== 1) throw new Error('exact owner/version delete guard refused write');
  }
}

test('native local PostgreSQL canonical memory owner is idempotent and reset-fenced', async (t) => {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 55433);
  assert.equal(typeof config.scope, 'string');
  assert.ok(config.scope.length > 0);
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: 4,
  });
  const schema = `meri_fixture_${randomUUID().replaceAll('-', '')}`;
  const quoted = exactSchemaName(schema);
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await pool.end();
  });

  const identity = await pool.query(
    `SELECT current_user = $1 AS user_matches,
            host(inet_server_addr()) AS server_addr,
            inet_server_port() AS server_port`,
    [config.user],
  );
  assert.deepEqual(identity.rows[0], {
    user_matches: true,
    server_addr: '127.0.0.1',
    server_port: 55433,
  });
  await pool.query(`CREATE SCHEMA ${quoted}`);
  const ownership = await pool.query(
    `SELECT pg_get_userbyid(nspowner) = current_user AS owned
       FROM pg_namespace
      WHERE nspname = $1`,
    [schema],
  );
  assert.equal(ownership.rows[0]?.owned, true);
  await pool.query(`
    CREATE TABLE ${quoted}.clients (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      UNIQUE (tenant_id, id)
    );
    CREATE TABLE ${quoted}.memory_items (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      client_id uuid,
      type varchar(32) NOT NULL,
      visibility varchar(16) NOT NULL DEFAULT 'tenant',
      slug text NOT NULL,
      title text NOT NULL,
      source varchar(24) NOT NULL,
      source_ref text,
      sections_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
      status varchar(16) NOT NULL DEFAULT 'active',
      governed_status varchar(24) NOT NULL DEFAULT 'pending_review',
      source_type varchar(40) NOT NULL DEFAULT 'unknown',
      source_id text,
      source_content_hash varchar(96),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (tenant_id, client_id) REFERENCES ${quoted}.clients (tenant_id, id)
    );
  `);
  for (const client of Object.values(CLIENTS)) {
    await pool.query(
      `INSERT INTO ${quoted}.clients (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, $3)`,
      [client.physicalId, AUTHORIZED_TENANTS[client.tenantId].id, client.name],
    );
  }

  const sourceMap = await buildFixtureManifest({
    tenants: AUTHORIZED_TENANTS,
    clients: CLIENTS,
    actors: { PAT: { tenantId: 'T1', userId: '44444444-4444-4444-8444-444444444444' } },
    availableOwners: ['memory_item'],
  });
  const adapter = new NativeCanonicalMemoryAdapter(pool, schema);
  const firstPlan = await planFixture({ manifest: sourceMap, adapter });
  const firstSeed = await applyFixture({
    manifest: sourceMap,
    plan: firstPlan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  assert.equal(firstSeed.status, 'complete', JSON.stringify(firstSeed.records.at(-1)));
  const firstCount = await pool.query(`SELECT count(*)::int AS count FROM ${quoted}.memory_items`);
  assert.equal(firstCount.rows[0].count, firstSeed.records.length);

  const secondPlan = await planFixture({ manifest: sourceMap, adapter });
  assert.equal(secondPlan.summary.creates, 0);
  assert.equal(secondPlan.summary.replacements, 0);
  const secondSeed = await applyFixture({
    manifest: sourceMap,
    plan: secondPlan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  assert.deepEqual(
    secondSeed.records.map((record) => record.physicalId),
    firstSeed.records.map((record) => record.physicalId),
  );

  const resetPlan = await planOwnedReset({ manifest: sourceMap, seedReceipt: secondSeed, adapter });
  const changed = resetPlan.operations[0];
  await pool.query(
    `UPDATE ${quoted}.memory_items SET updated_at = updated_at + interval '1 second' WHERE id = $1::uuid`,
    [changed.physicalId],
  );
  const blocked = await applyOwnedReset({
    manifest: sourceMap,
    seedReceipt: secondSeed,
    resetPlan,
    adapter,
    confirmation: RESET_CONFIRMATION,
  });
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.records.at(-1).errorCode, 'RESET_ROW_VERSION_CHANGED');
  const retained = await pool.query(`SELECT count(*)::int AS count FROM ${quoted}.memory_items`);
  assert.ok(retained.rows[0].count > 0);
});
