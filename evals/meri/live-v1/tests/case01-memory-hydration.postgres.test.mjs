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
  case01MemoryOwnerLocator,
} from '../fixture-provisioning/case01-memory-owner.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const source = (name) =>
  require(fileURLToPath(new URL(`../../../../apps/api/src/${name}.ts`, import.meta.url)));
const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;

it(
  'reconstructs identical canonical seed/reset/current authority after restart and rejects mutated source history',
  { skip: !config },
  async () =>
    withOwnedApprovedMemory(config, async ({ deps, tx, manifest, memoryStore }) => {
      const versions = await versionDependencies(deps, tx, memoryStore);
      const runtimeDeps = {
        ...deps,
        ...source('memory/synthetic-candidate-withdrawal.helpers'),
        ...source('memory/synthetic-approved-memory.helpers'),
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
          } else {
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
