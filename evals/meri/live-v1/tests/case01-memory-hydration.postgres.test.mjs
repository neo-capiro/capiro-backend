import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { versionDependencies } from './case01-memory-lifecycle.postgres.test.mjs';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  PROPOSER,
} from './approved-memory-postgres-harness.mjs';
import { createCase01MemoryFixtureRuntime } from '../fixture-provisioning/case01-memory-runtime.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { createCaptureBindingOwner } from '../fixture-provisioning/capture-binding-owner.mjs';
import {
  createHydratedCase01MemoryOwner,
  readCase01MemoryCorpusInTx,
  reconcileCase01MemoryCorpusInTx,
  case01MemoryOwnerLocator,
} from '../fixture-provisioning/case01-memory-owner.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
import {
  readSyntheticMemoryCorpus,
  reconcileSyntheticMemoryCorpus,
} from '../../../../apps/api/scripts/meri-synthetic-read-budget.mjs';
import { exerciseCase01ProjectionCleanup } from './case01-projection-cleanup-exercises.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const source = (name) =>
  require(fileURLToPath(new URL(`../../../../apps/api/src/${name}.ts`, import.meta.url)));
const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;

it(
  'reconstructs identical canonical seed/reset/current authority after restart and rejects mutated source history',
  { skip: !config },
  async (t) =>
    withOwnedApprovedMemory(config, async ({ deps, tx, manifest, memoryStore }) => {
      const versions = await versionDependencies(deps, tx, memoryStore);
      const runtimeDeps = {
        ...deps,
        ...source('memory/synthetic-candidate-withdrawal.helpers'),
        ...source('memory/synthetic-approved-memory.helpers'),
        ...source('memory/memory-terminal-cleanup.helpers'),
        ...versions,
        memoryVersions: versions.versions,
        memoryAuthorization: memoryStore.authz,
      };
      const ctx = {
        tenantId: TENANT,
        tenantSlug: AUTHORIZED_TENANTS.T1.slug,
        userId: PROPOSER,
        role: 'standard_user',
      };
      const scope = { caseId: '01', clientId: CLIENT };
      const previous = createCase01MemoryFixtureRuntime(runtimeDeps);
      const originalSeed = await previous.seed();
      const originalReset = await previous.retire();
      const replacement = await buildFixtureManifest({
        fixtureInstanceId: randomUUID(),
        clients: manifest.clients,
        actors: manifest.actors,
        uploaderActors: manifest.uploaderActors,
      });
      const current = createCase01MemoryFixtureRuntime({
        ...runtimeDeps,
        manifest: replacement,
        previousOwner: previous,
      });
      const replacementSeed = await current.seed();
      const qualification = await current.qualifyInTx(tx, ctx, scope);
      async function restart() {
        const old = createCase01MemoryFixtureRuntime(runtimeDeps);
        assert.deepEqual(await old.hydrateInTx(tx, ctx, { lifecycle: 'retired' }), originalSeed);
        assert.deepEqual(await old.readResetInTx(tx, ctx), originalReset);
        const fresh = createCase01MemoryFixtureRuntime({
          ...runtimeDeps,
          manifest: replacement,
          previousOwner: old,
        });
        assert.deepEqual(
          await fresh.hydrateInTx(tx, ctx, { lifecycle: 'current' }),
          replacementSeed,
        );
        return fresh;
      }
      assert.deepEqual(await (await restart()).qualifyInTx(tx, ctx, scope), qualification);
      await tx.$executeRawUnsafe(
        "ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb DEFAULT '{}'",
      );
      await tx.$executeRawUnsafe(
        'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
        JSON.stringify({
          unrelated: { text: 'keep  ' },
          meriFoundationFixture: { fixtureNamespace: FIXTURE_NAMESPACE },
        }),
        TENANT,
      );
      await tx.$executeRawUnsafe(
        'CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text)',
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO users VALUES($1::uuid,$2,$3,$4,$5)',
        PROPOSER,
        'unit-clerk',
        `${FIXTURE_NAMESPACE}-pat@example.com`,
        'Synthetic',
        'Pat',
      );
      const bindingOwner = createCaptureBindingOwner({
        prisma: deps.prisma,
        sourceAuthority: current,
      });
      const request = {
        tenantId: TENANT,
        tenantSlug: ctx.tenantSlug,
        actorUserId: PROPOSER,
        clerkUserId: 'unit-clerk',
        caseId: '01',
        clientId: CLIENT,
        captureRunId: randomUUID(),
      };
      const plan = await bindingOwner.inspect(request);
      const bound = await bindingOwner.bind({
        ...request,
        ...plan,
        expectedCurrentVerifySha256: plan.currentVerifySha256,
      });
      const locator = case01MemoryOwnerLocator(replacement, manifest, PROPOSER);
      const owner = createHydratedCase01MemoryOwner(runtimeDeps);
      await assert.rejects(owner.qualifyInTx(tx, ctx, scope));
      await assert.rejects(
        owner.installLocatorInTx(tx, ctx, {
          locator,
          expectedPriorLocatorSha256: sha256Stable(null),
          expectedTenantRowVersion: '0',
        }),
      );
      const installation = await owner.installLocatorInTx(tx, ctx, {
        locator,
        expectedPriorLocatorSha256: sha256Stable(null),
        expectedTenantRowVersion: bound.tenantRowVersion,
      });
      assert.equal(installation.status, 'LOCATOR_INSTALLED');
      assert.deepEqual(
        await createHydratedCase01MemoryOwner(runtimeDeps).qualifyInTx(tx, ctx, scope),
        qualification,
      );
      const { loadHydratedCase01FixtureOwner } = source('meri/meri-case01-fixture-loader');
      const loaded = await loadHydratedCase01FixtureOwner(runtimeDeps);
      assert.deepEqual(await loaded.qualifyInTx(tx, ctx, scope), qualification);
      const stored = (
        await tx.$queryRawUnsafe(
          'SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid',
          TENANT,
        )
      )[0].settings;
      assert.deepEqual(stored.unrelated, { text: 'keep  ' });
      assert.deepEqual(stored.meriFoundationFixture.captureEvidence, bound.binding);
      const corpus = await readCase01MemoryCorpusInTx(runtimeDeps, tx, ctx, CLIENT);
      await exerciseCase01ProjectionCleanup({ t, deps: runtimeDeps, tx, ctx, clientId: CLIENT });
      await tx.$executeRawUnsafe('SAVEPOINT reconciliation_exercises');
      try {
        const snapshot = () =>
          tx.$queryRawUnsafe(`SELECT 'item' AS kind,id::text,xmin::text AS version,to_jsonb(m) AS body,
          retention_policy_jsonb IS NULL AS sql_null FROM memory_items m UNION ALL
          SELECT 'candidate',id::text,xmin::text,to_jsonb(c),NULL FROM memory_candidate c UNION ALL
          SELECT 'transition',id::text,xmin::text,to_jsonb(a),NULL FROM memory_transition_audit a UNION ALL
          SELECT 'audit',id::text,xmin::text,to_jsonb(l),NULL FROM audit_logs l ORDER BY kind,id`);
        const unrelatedId = randomUUID();
        await tx.$executeRawUnsafe(
          `INSERT INTO memory_items(id,tenant_id,status,governed_status,retention_policy_jsonb)
          VALUES($1::uuid,$2::uuid,'active','active','{}'::jsonb)`,
          unrelatedId,
          TENANT,
        );
        const healthy = await snapshot();
        const options = { mode: 'preview' };
        const preview = (actor = ctx, clientId = CLIENT, opts = options) =>
          reconcileCase01MemoryCorpusInTx(runtimeDeps, tx, actor, clientId, opts);
        await assert.rejects(preview(), { code: 'CASE01_METADATA_RECONCILIATION_REFUSED' }); // No no-op repair/receipt.
        await tx.$executeRawUnsafe(
          "UPDATE memory_items SET governed_status='active',retention_policy_jsonb='null'::jsonb WHERE id<>$1::uuid",
          unrelatedId,
        );
        const drifted = await snapshot();
        await assert.rejects(readCase01MemoryCorpusInTx(runtimeDeps, tx, ctx, CLIENT));
        const plan = await preview();
        assert.equal(plan.status, 'METADATA_RECONCILIATION_PREVIEW_ROLLED_BACK');
        assert.equal(plan.plan.changes.length, 8);
        assert.equal(plan.captureAuthority, false);
        assert.equal(plan.providerAuthority, false);
        assert.equal(plan.proofIsTentative, true);
        assert.equal(plan.proof.fixtureReady, true);
        assert.equal(plan.auditId, null);
        assert.deepEqual(await snapshot(), drifted); // Including xmin: preview changed nothing.
        await assert.rejects(readCase01MemoryCorpusInTx(runtimeDeps, tx, ctx, CLIENT));
        await assert.rejects(preview({ ...ctx, role: 'capiro_admin' }));
        await assert.rejects(preview({ ...ctx, userId: randomUUID() }));
        await assert.rejects(preview({ ...ctx, tenantId: AUTHORIZED_TENANTS.T2.id }));
        await assert.rejects(preview(ctx, randomUUID()));
        await assert.rejects(
          preview(ctx, CLIENT, { ...options, ids: plan.plan.changes.map((row) => row.id) }),
        );
        await assert.rejects(
          preview(ctx, CLIENT, { mode: 'execute', expectedPlanSha256: '0'.repeat(64) }),
        );
        for (const mutation of [
          "UPDATE memory_items SET sections_jsonb='[]'::jsonb WHERE status='superseded'",
          "UPDATE memory_items SET legal_hold=true WHERE status='superseded'",
          "UPDATE memory_items SET retention_policy_jsonb='{}'::jsonb WHERE status='superseded'",
          "UPDATE memory_items SET status='active' WHERE status='superseded'",
          "UPDATE memory_items SET governed_status='revoked' WHERE status='superseded'",
          "UPDATE memory_items SET approved_at=approved_at + interval '1 second' WHERE status='superseded'",
          "UPDATE memory_candidate SET payload_jsonb='{}'::jsonb WHERE status='approved'",
          "UPDATE memory_transition_audit SET metadata_jsonb='{}'::jsonb WHERE reason_code='superseded'",
          "UPDATE clients SET memory_wall=true WHERE id='22222222-2222-4222-8222-222222222222'",
          "UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01MemoryOwner,ready}','true')",
        ]) {
          await tx.$executeRawUnsafe('SAVEPOINT invalid_reconciliation');
          try {
            assert.ok(await tx.$executeRawUnsafe(mutation));
            const changed = await snapshot();
            await assert.rejects(preview(), mutation);
            await assert.rejects(
              preview(ctx, CLIENT, { mode: 'execute', expectedPlanSha256: plan.planSha256 }),
              mutation,
            );
            assert.deepEqual(await snapshot(), changed, 'All failed tentative changes rolled back');
          } finally {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invalid_reconciliation');
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT invalid_reconciliation');
          }
        }
        await tx.$executeRawUnsafe('SAVEPOINT stale_reconciliation');
        try {
          // Even a harmless before-image change invalidates the approved plan.
          await tx.$executeRawUnsafe(
            "UPDATE memory_items SET updated_at=updated_at+interval '1 second' WHERE status='superseded'",
          );
          const refreshed = await preview();
          assert.notEqual(refreshed.planSha256, plan.planSha256);
          await assert.rejects(
            preview(ctx, CLIENT, { mode: 'execute', expectedPlanSha256: plan.planSha256 }),
          );
        } finally {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT stale_reconciliation');
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT stale_reconciliation');
        }
        await tx.$executeRawUnsafe('SAVEPOINT reconciliation_audit_failure');
        try {
          await tx.$executeRawUnsafe(`CREATE FUNCTION refuse_reconciliation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'controlled local audit insert failure'; END $$`);
          await tx.$executeRawUnsafe(`CREATE TRIGGER refuse_reconciliation_audit BEFORE INSERT ON audit_logs
            FOR EACH ROW EXECUTE FUNCTION refuse_reconciliation_audit()`);
          const beforeFailure = await snapshot();
          await assert.rejects(
            preview(ctx, CLIENT, { mode: 'execute', expectedPlanSha256: plan.planSha256 }),
          );
          assert.deepEqual(
            await snapshot(),
            beforeFailure,
            'Audit failure rolls back every item update',
          );
        } finally {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT reconciliation_audit_failure');
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT reconciliation_audit_failure');
        }
        const factory = { deps: runtimeDeps, runWithTenant: async (_actor, work) => work() };
        const executed = await reconcileSyntheticMemoryCorpus(
          factory,
          { ctx, clientId: CLIENT, expectedPlanSha256: plan.planSha256 },
          'execute',
        );
        assert.equal(executed.status, 'METADATA_RECONCILED');
        assert.equal(executed.proofIsTentative, false);
        assert.ok(executed.auditId);
        const reread = await readCase01MemoryCorpusInTx(runtimeDeps, tx, ctx, CLIENT);
        assert.equal(reread.currentVerifySha256, executed.proof.currentVerifySha256);
        await assert.rejects(
          preview(ctx, CLIENT, { mode: 'execute', expectedPlanSha256: plan.planSha256 }),
        );
        const settled = await snapshot();
        assert.deepEqual(
          settled.filter((row) => ['candidate', 'transition'].includes(row.kind)),
          healthy.filter((row) => ['candidate', 'transition'].includes(row.kind)),
        );
        assert.deepEqual(
          settled.filter((row) => row.kind === 'item').map((row) => row.body),
          healthy.filter((row) => row.kind === 'item').map((row) => row.body),
        );
        assert.equal(
          settled.filter((row) => row.kind === 'audit' && row.id === executed.auditId).length,
          1,
        );
      } finally {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT reconciliation_exercises');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT reconciliation_exercises');
      }
      // Exercise the CLI's actual read dispatch over the same real canonical
      // owner/owned PostgreSQL transaction; no installer or fixture mutation.
      const readViaCli = (actor = ctx, clientId = CLIENT) =>
        readSyntheticMemoryCorpus(
          {
            deps: runtimeDeps,
            runWithTenant: async (selected, work) => {
              assert.deepEqual(selected, actor);
              return work();
            },
          },
          { ctx: actor, clientId },
        );
      assert.deepEqual(await readViaCli(), { ...corpus, status: 'MEMORY_CORPUS_READ' });
      await assert.rejects(readViaCli({ ...ctx, role: 'capiro_admin' }));
      await assert.rejects(readViaCli(ctx, randomUUID()));
      assert.deepEqual(corpus, {
        ...qualification,
        evidenceKind: 'canonical-memory-corpus-readback',
        captureAuthority: false,
      });
      // Switching the active controlled-read binding does not change this
      // corpus. It must still prevent case01 capture admission.
      await tx.$executeRawUnsafe('SAVEPOINT capture_binding_switch');
      try {
        await tx.$executeRawUnsafe(
          "UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,captureEvidence}',$1::jsonb) WHERE id=$2::uuid",
          JSON.stringify({ ...bound.binding, caseId: '20', captureRunId: randomUUID() }),
          TENANT,
        );
        assert.deepEqual(await readCase01MemoryCorpusInTx(runtimeDeps, tx, ctx, CLIENT), corpus);
        await assert.rejects(owner.qualifyInTx(tx, ctx, scope), /CASE01_LOCATOR_BINDING_MISMATCH/);
      } finally {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT capture_binding_switch');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT capture_binding_switch');
      }
      await assert.rejects(
        readCase01MemoryCorpusInTx(runtimeDeps, tx, { ...ctx, role: 'capiro_admin' }, CLIENT),
      );
      await assert.rejects(readCase01MemoryCorpusInTx(runtimeDeps, tx, ctx, randomUUID()));
      await assert.rejects(
        owner.installLocatorInTx(tx, ctx, {
          locator,
          expectedPriorLocatorSha256: sha256Stable(null),
          expectedTenantRowVersion: installation.tenantRowVersion,
        }),
      );
      await assert.rejects(owner.qualifyInTx(tx, { ...ctx, role: 'capiro_admin' }, scope));
      await assert.rejects(owner.qualifyInTx(tx, ctx, { ...scope, caseId: '02' }));
      await tx.$executeRawUnsafe('SAVEPOINT locator_tamper');
      try {
        await tx.$executeRawUnsafe(
          "UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,case01MemoryOwner,ready}','true')",
        );
        await assert.rejects(owner.qualifyInTx(tx, ctx, scope));
      } finally {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT locator_tamper');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT locator_tamper');
      }
      const mutations = [
        "UPDATE memory_transition_audit SET metadata_jsonb=metadata_jsonb-'syntheticFixtureContentSha256' WHERE reason_code='corrected'",
        "UPDATE memory_transition_audit SET metadata_jsonb=metadata_jsonb-'syntheticFixtureCorrectionCandidateRowVersion' WHERE reason_code='superseded'",
        "UPDATE memory_transition_audit SET metadata_jsonb=jsonb_set(metadata_jsonb,'{syntheticFixtureItemRowVersion}','\"0\"') WHERE reason_code='revoked'",
        "UPDATE memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','\"forged\"') WHERE status='pending'",
        "UPDATE clients SET memory_wall=true WHERE id='22222222-2222-4222-8222-222222222222'",
        "UPDATE tenant_memberships SET status='inactive' WHERE user_id='44444444-4444-4444-8444-444444444444'",
      ];
      for (const mutation of mutations) {
        await tx.$executeRawUnsafe('SAVEPOINT hydration_tamper');
        try {
          assert.ok((await tx.$executeRawUnsafe(mutation)) > 0);
          await assert.rejects(restart(), mutation);
          await assert.rejects(owner.qualifyInTx(tx, ctx, scope), mutation);
          if (mutation.includes('syntheticFixtureItemRowVersion')) {
            // A valid historical audit version can be reconstructed, but it is
            // changed evidence, not the old capture binding. The shared protocol
            // detects this hash change across its before/after readbacks.
            const changed = await readCase01MemoryCorpusInTx(runtimeDeps, tx, ctx, CLIENT);
            assert.notEqual(changed.currentVerifySha256, corpus.currentVerifySha256);
            assert.equal(changed.captureAuthority, false);
            assert.equal((await readViaCli()).currentVerifySha256, changed.currentVerifySha256);
          } else {
            await assert.rejects(readViaCli(), mutation);
            await assert.rejects(
              readCase01MemoryCorpusInTx(runtimeDeps, tx, ctx, CLIENT),
              mutation,
            );
          }
        } finally {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT hydration_tamper');
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT hydration_tamper');
        }
      }
      const empty = await buildFixtureManifest({
        fixtureInstanceId: randomUUID(),
        clients: manifest.clients,
        actors: manifest.actors,
        uploaderActors: manifest.uploaderActors,
      });
      const missing = createCase01MemoryFixtureRuntime({ ...runtimeDeps, manifest: empty });
      await assert.rejects(missing.hydrateInTx(tx, ctx, { lifecycle: 'current' }));
      await assert.rejects(missing.seed(), /PARTIAL_SEED/);
      assert.equal(qualification.liveAcceptance, 'NOT_RUN');
    }),
);
