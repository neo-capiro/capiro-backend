import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { memoryFixtureSchemaSql } from './approved-memory-schema.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { lifecycleSeedMemoryDefinitions } from '../fixture-provisioning/approved-memory-runtime.mjs';
import { createMemoryCandidateOwnerPort } from '../fixture-provisioning/memory-candidate-owner.mjs';
import { inspectCase01FirstApprovalRecovery, executeCase01FirstApprovalRecovery } from '../fixture-provisioning/case01-execution-setup.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';

const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const api = fileURLToPath(new URL('../../../../apps/api/', import.meta.url));
const require = createRequire(resolve(api, 'package.json'));
const PAT = '44444444-4444-4444-8444-444444444444', PRIYA = '66666666-6666-4666-8666-666666666666';
const ASTER = '11111111-1111-4111-8111-111111111111', BLUE = '22222222-2222-4222-8222-222222222222';

test('actual factory and Prisma transactions serialize recovery claims, preserve rollback and expose safe SQLSTATE at canonical activation',
  { skip: !configPath }, async () => {
    // Only the existing marked owned cluster; connection values never enter evidence.
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(cfg.host, '127.0.0.1'); assert.equal(cfg.port, 55433);
    assert.equal(cfg.scope, 'owned local disposable test cluster; no AWS connection');
    const { Client } = require('pg');
    const db = new Client({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password });
    const schema = `meri_approved_${randomUUID().replaceAll('-', '')}`;
    const oldEnv = new Map(), oldResolve = Module._resolveFilename;
    let factory, oldProjection, candidateType, schemaCreated = false, projectionCalls = 0;
    await db.connect();
    try {
      const location = (await db.query("SELECT current_user=$1 AS owner_matches,host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS directory", [cfg.user])).rows[0];
      assert.equal(location.owner_matches, true); assert.equal(location.host, cfg.host); assert.equal(location.port, cfg.port);
      assert.equal(location.directory.replaceAll('\\', '/'), cfg.dataDirectory.replaceAll('\\', '/'));
      assert.match(schema, /^meri_approved_[a-f0-9]{32}$/u);
      await db.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
      await db.query(`SET search_path TO "${schema}"`);
      await db.query(memoryFixtureSchemaSql(schema));
      await db.query('ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb');
      await db.query('ALTER TABLE memory_cleanup_outbox ADD COLUMN expected_source_version timestamptz, ADD COLUMN expected_content_hash text');
      await db.query('CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text)');
      await db.query('CREATE TABLE clio_conversations(id uuid PRIMARY KEY,tenant_id uuid,title text)');
      for (const tenant of Object.values(AUTHORIZED_TENANTS)) await db.query('INSERT INTO tenants VALUES($1,$2,$3)',
        [tenant.id, tenant.slug, { unrelated: { preserve: true }, meriFoundationFixture: { fixtureNamespace: FIXTURE_NAMESPACE } }]);
      for (const [id, role, name] of [[PAT, 'standard_user', 'Pat'], [PRIYA, 'user_admin', 'Priya']]) {
        await db.query('INSERT INTO tenant_memberships VALUES($1,$2,$3,$4)', [AUTHORIZED_TENANTS.T1.id, id, 'active', role]);
        await db.query('INSERT INTO users VALUES($1,$2,$3,$4,$5)', [id, `user_synthetic_${name}`, `${FIXTURE_NAMESPACE}-${name}@example.com`, 'Synthetic', name]);
      }
      for (const client of [ASTER, BLUE]) {
        await db.query('INSERT INTO clients(id,tenant_id) VALUES($1,$2)', [client, AUTHORIZED_TENANTS.T1.id]);
        await db.query("INSERT INTO memory_access_grant(id,tenant_id,client_id,user_id,permissions,status,expires_at,reason) VALUES($1,$2,$3,$4,ARRAY['approve','revoke'],'active',now()+interval '1 hour','Owned local recovery qualification')", [randomUUID(), AUTHORIZED_TENANTS.T1.id, client, PRIYA]);
      }
      const url = new URL(`postgresql://${cfg.host}:${cfg.port}/${cfg.database}`);
      url.username = cfg.user; url.password = cfg.password; url.searchParams.set('schema', schema);
      for (const [key, value] of Object.entries({ DATABASE_URL: url.href,
        MERI_SYNTHETIC_FIXTURE_NAMESPACE: FIXTURE_NAMESPACE, MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
        MEMORY_GOVERNANCE_ENFORCE: 'enforce', MEMORY_GOVERNANCE_CENTER: 'enforce', MEMORY_CLIENT_REVIEW: 'enforce',
        MEMORY_GOVERNANCE_TENANTS: Object.values(AUTHORIZED_TENANTS).map(t => t.id).join(',') })) {
        oldEnv.set(key, process.env[key]); process.env[key] = value;
      }
      require('ts-node').register({ project: resolve(api, 'tsconfig.json'), transpileOnly: true, experimentalResolver: true });
      const source = name => require(resolve(api, 'src', name + '.ts'));
      candidateType = source('memory/memory-candidate.service').MemoryCandidateService;
      oldProjection = candidateType.prototype.dispatchProjectionFastPath;
      // Fail before any provider boundary even if the expected SQL trigger fails to fire.
      candidateType.prototype.dispatchProjectionFastPath = async () => { projectionCalls++; throw new Error('OWNED_PROVIDER_BOUNDARY_STOP'); };
      Module._resolveFilename = function(request, parent, ...rest) {
        if (parent?.filename.replaceAll('\\', '/').endsWith('/apps/api/scripts/meri-case01-setup-dependencies.mjs') && request.startsWith('../dist/'))
          request = resolve(api, 'src', request.slice(8).replace(/\.js$/u, '.ts'));
        return oldResolve.call(this, request, parent, ...rest);
      };
      factory = await (await import('../../../../apps/api/scripts/meri-case01-setup-dependencies.mjs')).createCase01SetupDependencies();
      const ctx = { tenantId: AUTHORIZED_TENANTS.T1.id, tenantSlug: AUTHORIZED_TENANTS.T1.slug, userId: PAT, role: 'standard_user' };
      const input = { schemaVersion: 1, target: 'capiro-dev', fixtureNamespace: FIXTURE_NAMESPACE, ctx,
        clerkUserId: 'user_synthetic_Pat', reviewerUserId: PRIYA, captureRunId: randomUUID(),
        previousFixtureInstanceId: randomUUID(), currentFixtureInstanceId: randomUUID(),
        clients: { ASTER: { tenantId: 'T1', physicalId: ASTER }, BLUEHAVEN: { tenantId: 'T1', physicalId: BLUE },
          CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' } },
        actors: { PAT: { physicalId: PAT }, PRIYA: { physicalId: PRIYA } } };
      const run = work => factory.runWithTenant({ ...ctx, clerkUserId: input.clerkUserId }, work);
      const manifest = await buildFixtureManifest({ fixtureInstanceId: input.previousFixtureInstanceId, clients: input.clients, actors: input.actors, uploaderActors: { T1: 'PAT' } });
      const first = lifecycleSeedMemoryDefinitions(manifest, ['MA1-v1'])[0].candidate;
      const owner = createMemoryCandidateOwnerPort({ ...factory.deps, actorForTenant: () => PAT });
      await run(() => owner.create(first, { tenantId: ctx.tenantId, physicalId: first.physicalId,
        expectedOwnershipMarkerSha256: first.ownership.markerSha256, expectedRowVersion: null }));
      const pending = await owner.read(first);
      const original = { kind: 'meri-case01-execution-setup', captureRunId: input.captureRunId,
        recipeSha256: sha256Stable(input), status: 'STARTED', liveAcceptance: 'NOT_RUN' };
      await db.query("UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01ExecutionSetup}',$1) WHERE id=$2", [original, ctx.tenantId]);
      const expected = { originalClaimSha256: sha256Stable(original), candidateRowVersion: pending.rowVersion };
      const plan = await run(() => inspectCase01FirstApprovalRecovery(factory.deps, input, expected));
      // Real activation INSERT fails inside the real Prisma transaction; previous
      // clio insert must roll back. This is a local fault, not a diagnosis of AWS.
      await db.query("CREATE FUNCTION reject_owned_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned activation fault' USING ERRCODE='42501'; END $$");
      await db.query('CREATE TRIGGER owned_activation_fault BEFORE INSERT ON memory_items FOR EACH ROW EXECUTE FUNCTION reject_owned_activation()');
      const journals = [[], []];
      const results = await Promise.allSettled(journals.map(journal => run(() => executeCase01FirstApprovalRecovery(factory.deps, input, expected,
        { expectedPlanSha256: plan.planSha256, createConversation: factory.createConversation,
          journal: async entry => journal.push(entry) }))));
      assert.ok(results.every(result => result.status === 'rejected'));
      assert.equal(journals.flat().filter(row => row.stage === 'FIRST_CANONICAL_APPROVAL' && row.phase === 'INTENT').length, 1);
      const failure = journals.flat().find(row => row.stage === 'FIRST_CANONICAL_APPROVAL' && row.phase === 'RECONCILIATION_REQUIRED');
      assert.equal(failure.failure.prismaCode, 'P2010'); assert.equal(failure.failure.sqlState, '42501');
      assert.ok(!JSON.stringify(journals).includes('owned activation fault'));
      const actual = (await db.query('SELECT settings_jsonb AS s FROM tenants WHERE id=$1', [ctx.tenantId])).rows[0].s;
      assert.deepEqual(actual.meriFoundationFixture.case01ExecutionSetup, original);
      assert.equal(actual.meriFoundationFixture.case01ExecutionSetupRecovery.status, 'STARTED');
      const counts = (await db.query("SELECT (SELECT count(*)::int FROM memory_candidate WHERE status='pending') AS pending,(SELECT count(*)::int FROM clio_memory) AS legacy,(SELECT count(*)::int FROM memory_items) AS items,(SELECT count(*)::int FROM memory_cleanup_outbox) AS outbox")).rows[0];
      assert.deepEqual(counts, { pending: 1, legacy: 0, items: 0, outbox: 0 });
      assert.equal(projectionCalls, 0);
      assert.equal(Object.hasOwn(factory.deps.prisma, 'withTenantUser'), false, 'Actual Prisma method is not replaced');
    } finally {
      await factory?.close();
      Module._resolveFilename = oldResolve;
      if (candidateType && oldProjection) candidateType.prototype.dispatchProjectionFastPath = oldProjection;
      for (const [key, value] of oldEnv) value === undefined ? delete process.env[key] : process.env[key] = value;
      if (schemaCreated) { assert.match(schema, /^meri_approved_[a-f0-9]{32}$/u); await db.query(`DROP SCHEMA "${schema}" CASCADE`); }
      await db.end();
    }
  });
