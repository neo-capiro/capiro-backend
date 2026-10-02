import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire, Module } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { memoryFixtureSchemaSql } from './approved-memory-schema.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { lifecycleSeedMemoryDefinitions } from '../fixture-provisioning/approved-memory-runtime.mjs';
import { createMemoryCandidateOwnerPort, expectedMemoryCandidatePayload } from '../fixture-provisioning/memory-candidate-owner.mjs';
import { inspectCase01FirstApprovalRecovery, executeCase01FirstApprovalRecovery, inspectCase01FirstApprovalContinuation, executeCase01FirstApprovalContinuation, safeCase01SetupFailure } from '../fixture-provisioning/case01-execution-setup.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';

import { inspectCase01PostApprovalResume, executeCase01PostApprovalResume } from '../fixture-provisioning/case01-execution-setup.mjs';
import { stableJson } from '../lib/stable.mjs';

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
      // Prisma binds interpolated strings as text. A node-pg facade leaves the
      // parameter type unknown and does not reproduce PostgreSQL enum=text.
      const reviewerRole = 'user_admin';
      await assert.rejects(factory.deps.prisma.withTenantUser(AUTHORIZED_TENANTS.T1.id, PRIYA, tx => tx.$queryRaw`
        SELECT user_id::text AS id FROM tenant_memberships
        WHERE tenant_id=${AUTHORIZED_TENANTS.T1.id}::uuid AND user_id=${PRIYA}::uuid
          AND status='active' AND role=${reviewerRole} FOR SHARE
      `), error => {
        assert.equal(error.code, 'P2010');
        assert.equal(error.meta?.code, '42883');
        assert.deepEqual(safeCase01SetupFailure(error, 'FIRST_CANONICAL_APPROVAL'), {
          stage: 'FIRST_CANONICAL_APPROVAL', errorClass: 'PrismaClientKnownRequestError',
          prismaCode: 'P2010', sqlState: '42883',
        });
        return true;
      });
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
      // Preserve the real failed recovery, then race two continuations through
      // actual independent Prisma transactions. Only one can claim/approve.
      const recovery = actual.meriFoundationFixture.case01ExecutionSetupRecovery;
      const continuationExpected = { ...expected, recoveryClaimSha256: sha256Stable(recovery) };
      const continuationPlan = await run(() => inspectCase01FirstApprovalContinuation(factory.deps, input, continuationExpected));
      // Execute the actual fixed CLI and actual dependency factory on the owned
      // cluster. Only its dist→source loader mapping above is used; no CLI or
      // canonical operation is replaced. continue-plan must perform no writes.
      async function checkCliPlan(command, recipeExpected, planExpected) {
      const outputRoot = resolve(process.env.MERI_TEST_EVIDENCE_ROOT || process.cwd());
      const directory = await mkdtemp(join(outputRoot, '.meri-continuation-cli-'));
      const outputPath = join(directory, 'plan.jsonl');
      const oldCli = { argv: process.argv, exitCode: process.exitCode, input: process.env.MERI_CASE01_SETUP_INPUT,
        stdout: process.stdout.write, stderr: process.stderr.write };
      let cliText = '';
      try {
        process.argv = [process.execPath, resolve(api, 'scripts/meri-case01-setup.mjs'), command, '--input-env', 'MERI_CASE01_SETUP_INPUT', '--out', outputPath];
        process.env.MERI_CASE01_SETUP_INPUT = JSON.stringify({ recipe: input, expected: recipeExpected });
        process.exitCode = undefined;
        process.stdout.write = text => { cliText += String(text); return true; };
        process.stderr.write = () => true;
        await import(pathToFileURL(resolve(api, 'scripts/meri-case01-setup.mjs')).href + '?owned-plan=' + randomUUID());
        assert.equal(process.exitCode || 0, 0);
        assert.deepEqual(JSON.parse((await readFile(outputPath, 'utf8')).trim()), planExpected);
        assert.ok(cliText.includes('MERI_CASE01_SETUP_RECEIPT '));
      } finally {
        process.argv = oldCli.argv;process.exitCode = oldCli.exitCode;process.stdout.write = oldCli.stdout;process.stderr.write = oldCli.stderr;
        oldCli.input === undefined ? delete process.env.MERI_CASE01_SETUP_INPUT : process.env.MERI_CASE01_SETUP_INPUT = oldCli.input;
        assert.equal(dirname(directory), outputRoot);await rm(directory, { recursive: true });
      }
      }
      await checkCliPlan('continue-plan', continuationExpected, continuationPlan);
      const continuationJournals = [[], []];
      const continuations = await Promise.allSettled(continuationJournals.map(journal => run(() =>
        executeCase01FirstApprovalContinuation(factory.deps, input, continuationExpected,
          { expectedPlanSha256: continuationPlan.planSha256, createConversation: factory.createConversation,
            journal: async entry => journal.push(entry) }))));
      assert.ok(continuations.every(result => result.status === 'rejected'));
      assert.equal(continuationJournals.flat().filter(row => row.stage === 'FIRST_CANONICAL_APPROVAL' && row.phase === 'INTENT').length, 1);
      const continuationFailure = continuationJournals.flat().find(row => row.phase === 'RECONCILIATION_REQUIRED');
      assert.equal(continuationFailure.failure.sqlState, '42501');
      const retained = (await db.query('SELECT settings_jsonb AS s FROM tenants WHERE id=$1', [ctx.tenantId])).rows[0].s;
      assert.deepEqual(retained.meriFoundationFixture.case01ExecutionSetup, original);
      assert.deepEqual(retained.meriFoundationFixture.case01ExecutionSetupRecovery, recovery);
      assert.equal(retained.meriFoundationFixture.case01ExecutionSetupContinuation.status, 'STARTED');
      assert.deepEqual((await db.query("SELECT (SELECT count(*)::int FROM memory_candidate WHERE status='pending') AS pending,(SELECT count(*)::int FROM clio_memory) AS legacy,(SELECT count(*)::int FROM memory_items) AS items,(SELECT count(*)::int FROM memory_cleanup_outbox) AS outbox")).rows[0], counts);
      await assert.rejects(run(() => inspectCase01FirstApprovalContinuation(factory.deps, input, continuationExpected)), /DOWNSTREAM_OWNER/);
      assert.equal(projectionCalls, 0);
      // Reproduce the different, post-commit boundary with the real approval on
      // this owned schema. The deliberately broken projection port stops before
      // any external provider; canonical approval/outbox/audits must survive.
      await db.query('DROP TRIGGER owned_activation_fault ON memory_items');
      await db.query(`ALTER TABLE clio_memory ADD COLUMN embedding text`);
      await db.query(`ALTER TABLE memory_cleanup_outbox ADD COLUMN attempts int DEFAULT 0,
        ADD COLUMN last_error text,ADD COLUMN completed_at timestamptz,ADD COLUMN superseded_at timestamptz,
        ADD COLUMN lease_owner text,ADD COLUMN lease_expires_at timestamptz,ADD COLUMN created_at timestamptz DEFAULT now()`);
      await db.query(`ALTER TABLE context_embeddings ADD COLUMN tenant_id uuid,
        ADD COLUMN model text,ADD COLUMN content_hash text,ADD COLUMN embedding text`);
      await assert.rejects(
        run(() =>
          factory.deps.memoryCandidates.approveSyntheticFixture(
            ctx.tenantId,
            first.physicalId,
            PRIYA,
            { tenantId: ctx.tenantId, userId: PRIYA, role: 'user_admin' },
            {
              expectedRowVersion: pending.rowVersion,
              expectedPayload: expectedMemoryCandidatePayload(
                first,
                PAT,
                stableJson({ ownership: first.ownership, payload: first.payload }),
              ),
            },
          ),
        ),
        /OWNED_PROVIDER_BOUNDARY_STOP/,
      );
      assert.equal(projectionCalls, 1);
      await db.query("UPDATE clio_memory SET embedding='owned-test-legacy-vector'");
      const committed = (
        await db.query(
          `SELECT c.xmin::text AS candidate_version,i.xmin::text AS item_version,
        m.xmin::text AS clio_version,o.id::text AS job_id,i.id::text AS item_id FROM memory_candidate c
        JOIN clio_memory m ON m.id=c.committed_memory_id JOIN memory_items i ON i.id=c.committed_memory_item_id
        JOIN memory_cleanup_outbox o ON o.memory_item_id=i.id WHERE c.id=$1`,
          [first.physicalId],
        )
      ).rows[0];
      const resumeExpected = {
        originalClaimSha256: expected.originalClaimSha256,
        recoveryClaimSha256: continuationExpected.recoveryClaimSha256,
        continuationClaimSha256: sha256Stable(
          retained.meriFoundationFixture.case01ExecutionSetupContinuation,
        ),
        candidateRowVersion: committed.candidate_version,
        itemRowVersion: committed.item_version,
        clioRowVersion: committed.clio_version,
        projectionJobId: committed.job_id,
      };
      const resumePlan = await run(() =>
        inspectCase01PostApprovalResume(factory.deps, input, resumeExpected),
      );
      await checkCliPlan('resume-plan', resumeExpected, resumePlan);
      assert.equal(factory.deps.memoryIngest, factory.deps.memoryCandidates.memoryIngest);
      let canonicalEmbeddings = 0;
      // Inert external vector sink only; actual factory/Prisma/strict projector,
      // exact outbox lookup and completion are unmodified source methods.
      factory.deps.memoryIngest.strictProjector.writeEmbedding = async (value) => {
        canonicalEmbeddings++;
        const { projectionContentHash } = source('memory/strict-memory-projector.service');
        await db.query(
          `INSERT INTO context_embeddings(tenant_id,source_type,source_id,model,content_hash,embedding)
          VALUES($1,'memory_item',$2,'amazon.titan-embed-text-v2:0',$3,'owned-test-canonical-vector')`,
          [value.tenantId, value.sourceId, projectionContentHash(value.text)],
        );
      };
      const resumeJournals = [[], []];
      const resumed = await Promise.allSettled(
        resumeJournals.map((journal) =>
          run(() =>
            executeCase01PostApprovalResume(factory.deps, input, resumeExpected, {
              expectedPlanSha256: resumePlan.planSha256,
              createConversation: factory.createConversation,
              journal: async (entry) => {
                journal.push(entry);
                if (entry.stage === 'PREVIOUS_SEED') throw new Error('OWNED_DOWNSTREAM_STOP');
              },
            }),
          ),
        ),
      );
      assert.ok(resumed.every((r) => r.status === 'rejected'));
      assert.equal(canonicalEmbeddings, 1);
      assert.equal(projectionCalls, 1, 'No second canonical approval dispatch');
      assert.equal(
        resumeJournals
          .flat()
          .filter((r) => r.stage === 'FIRST_CANONICAL_PROJECTION' && r.phase === 'VERIFIED').length,
        1,
      );
      const finished = (
        await db.query('SELECT settings_jsonb AS s FROM tenants WHERE id=$1', [ctx.tenantId])
      ).rows[0].s;
      for (const key of [
        'case01ExecutionSetup',
        'case01ExecutionSetupRecovery',
        'case01ExecutionSetupContinuation',
      ])
        assert.deepEqual(finished.meriFoundationFixture[key], retained.meriFoundationFixture[key]);
      assert.equal(
        finished.meriFoundationFixture.case01ExecutionSetupPostApproval.status,
        'STARTED',
      );
      assert.equal(
        (await db.query('SELECT status FROM memory_cleanup_outbox WHERE id=$1', [committed.job_id]))
          .rows[0].status,
        'completed',
      );
      assert.equal((await db.query('SELECT count(*)::int AS n FROM memory_items')).rows[0].n, 1);
    } finally {
      await factory?.close();
      Module._resolveFilename = oldResolve;
      if (candidateType && oldProjection) candidateType.prototype.dispatchProjectionFastPath = oldProjection;
      for (const [key, value] of oldEnv) value === undefined ? delete process.env[key] : process.env[key] = value;
      if (schemaCreated) { assert.match(schema, /^meri_approved_[a-f0-9]{32}$/u); await db.query(`DROP SCHEMA "${schema}" CASCADE`); }
      await db.end();
    }
  });
