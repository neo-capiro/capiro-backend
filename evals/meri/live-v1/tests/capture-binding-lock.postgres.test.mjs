import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';
import { createCaptureBindingOwner } from '../fixture-provisioning/capture-binding-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
import { sha256Stable } from '../artifact-collector.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;

// The canonical-source test uses the existing rollback harness. This separate
// concurrency test needs committed setup visible to two independent sessions.
// Only its randomly named schema is committed, then dropped and absence checked.
it(
  'real tenant row locks serialize contenders; only one expected-prior binding commits',
  { skip: !configPath },
  async () => {
    let config;
    try {
      assert.ok(isAbsolute(configPath));
      config = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      throw new Error('Explicit owned local configuration required');
    }
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 55433);
    assert.equal(config.scope, 'owned local disposable test cluster; no AWS connection');
    assert.ok(isAbsolute(config.dataDirectory));
    const { Client } = require('pg');
    const connect = async () => {
      const client = new Client({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectionTimeoutMillis: 3000,
      });
      try {
        await client.connect();
      } catch {
        throw new Error('Owned loopback connection failed');
      }
      return client;
    };
    const admin = await connect(),
      schema = `meri_capture_bind_${randomUUID().replaceAll('-', '')}`;
    assert.match(schema, /^meri_capture_bind_[a-f0-9]{32}$/u);
    const active = new Set();
    let releaseFirst;
    try {
      const actual = (
        await admin.query(
          `SELECT current_user=$1 AS owner,host(inet_server_addr()) AS address,
      inet_server_port() AS port,current_setting('data_directory') AS directory`,
          [config.user],
        )
      ).rows[0];
      assert.equal(actual.owner, true);
      assert.equal(actual.address, config.host);
      assert.equal(actual.port, config.port);
      assert.equal(
        actual.directory.replaceAll('\\', '/'),
        config.dataDirectory.replaceAll('\\', '/'),
      );
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query(`CREATE TABLE tenants(id uuid PRIMARY KEY,slug text,settings_jsonb jsonb);
      CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text);
      CREATE TABLE tenant_memberships(tenant_id uuid,user_id uuid,status text,role text);
      CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,memory_wall boolean);
      CREATE TABLE client_memory_access(tenant_id uuid,client_id uuid,user_id uuid);
      CREATE TABLE controlled_sources(id text PRIMARY KEY,version text);`);
      const request = {
        tenantId: AUTHORIZED_TENANTS.T1.id,
        tenantSlug: AUTHORIZED_TENANTS.T1.slug,
        actorUserId: '44444444-4444-4444-8444-444444444444',
        clerkUserId: 'unit-clerk',
        clientId: '11111111-1111-4111-8111-111111111111',
        caseId: '01',
        captureRunId: randomUUID(),
      };
      const settings = {
        unrelated: { retain: 123 },
        meriFoundationFixture: { fixtureNamespace: FIXTURE_NAMESPACE, retain: 'fixture-setting' },
      };
      await admin.query('INSERT INTO tenants VALUES($1,$2,$3)', [
        request.tenantId,
        request.tenantSlug,
        settings,
      ]);
      await admin.query('INSERT INTO users VALUES($1,$2,$3,$4,$5)', [
        request.actorUserId,
        request.clerkUserId,
        `${FIXTURE_NAMESPACE}-pat@example.com`,
        'Synthetic',
        'Pat',
      ]);
      await admin.query('INSERT INTO tenant_memberships VALUES($1,$2,$3,$4)', [
        request.tenantId,
        request.actorUserId,
        'active',
        'standard_user',
      ]);
      await admin.query('INSERT INTO clients VALUES($1,$2,false)', [
        request.clientId,
        request.tenantId,
      ]);
      await admin.query("INSERT INTO controlled_sources VALUES('MA1-v2','1')");
      let latestPid;
      const prisma = {
        async withTenantUser(_tenant, _actor, work) {
          const client = await connect();
          active.add(client);
          try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL search_path TO "${schema}"`);
            await client.query("SET LOCAL lock_timeout='5s'");
            latestPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const answer = await work({
              $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
            });
            await client.query('COMMIT');
            return answer;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            active.delete(client);
            await client.end();
          }
        },
      };
      let pause = false,
        firstQualified;
      const qualifiedSignal = new Promise((resolve) => {
        firstQualified = resolve;
      });
      const resumeSignal = new Promise((resolve) => {
        releaseFirst = resolve;
      });
      const sourceAuthority = {
        async qualifyInTx(tx, ctx) {
          const sources = await tx.$queryRawUnsafe(
            "SELECT id,version FROM controlled_sources WHERE id='MA1-v2' FOR UPDATE",
          );
          assert.equal(sources.length, 1);
          const sourceMap = {
            'MA1-v2': { physicalId: 'unit-only-canonical-source', version: sources[0].version },
          };
          const currentVerify = { sources, actor: ctx.userId, client: request.clientId };
          if (pause) {
            pause = false;
            firstQualified();
            await resumeSignal;
          }
          return {
            fixtureNamespace: FIXTURE_NAMESPACE,
            fixtureVersion: 'controlled-owner-unit-not-live',
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            clientId: request.clientId,
            caseId: '01',
            sourceMap,
            physicalMapSha256: sha256Stable(sourceMap),
            currentVerify,
            currentVerifySha256: sha256Stable(currentVerify),
            fixtureReady: true,
            missing: [],
            seedReceiptId: 'unit-only-seed',
            resetReceiptId: 'unit-only-reset',
          };
        },
      };
      const owner = createCaptureBindingOwner({ prisma, sourceAuthority });
      const plan = await owner.inspect(request);
      const input = { ...request, ...plan, expectedCurrentVerifySha256: plan.currentVerifySha256 };
      pause = true;
      const first = owner.bind(input);
      await qualifiedSignal;
      const firstPid = latestPid;
      const second = owner.bind({ ...input, captureRunId: randomUUID() });
      const secondRejected = assert.rejects(second, { code: 'CAPTURE_BINDING_STALE_PRIOR' });
      let blocked = false;
      for (let n = 0; n < 100 && !blocked; n++) {
        await delay(10);
        if (latestPid !== firstPid)
          blocked =
            (
              await admin.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND granted=false', [
                latestPid,
              ])
            ).rowCount > 0;
      }
      assert.equal(blocked, true, 'second writer must block on the real tenant row lock');
      releaseFirst();
      const result = await first;
      await secondRejected;
      assert.equal(result.status, 'BOUND');
      const saved = (
        await admin.query('SELECT settings_jsonb FROM tenants WHERE id=$1', [request.tenantId])
      ).rows[0].settings_jsonb;
      assert.equal(saved.meriFoundationFixture.captureEvidence.captureRunId, request.captureRunId);
      assert.deepEqual(saved.unrelated, settings.unrelated);
      assert.equal(saved.meriFoundationFixture.retain, 'fixture-setting');
      const next = await owner.inspect(request);
      await admin.query("UPDATE controlled_sources SET version='2' WHERE id='MA1-v2'");
      await assert.rejects(
        owner.bind({ ...request, ...next, expectedCurrentVerifySha256: next.currentVerifySha256 }),
        { code: 'CAPTURE_BINDING_SOURCE_CHANGED' },
      );
      assert.equal(
        (await admin.query('SELECT settings_jsonb FROM tenants WHERE id=$1', [request.tenantId]))
          .rows[0].settings_jsonb.meriFoundationFixture.captureEvidence.captureRunId,
        request.captureRunId,
      );
    } finally {
      releaseFirst?.();
      for (const client of active) {
        try {
          await client.query('ROLLBACK');
        } finally {
          await client.end();
        }
      }
      await admin.query('SET search_path TO public');
      // Identifier is generated locally above and checked against this exact prefix.
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      assert.equal(
        (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount,
        0,
      );
      await admin.end();
    }
  },
);
