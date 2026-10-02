import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  createApprovedMemoryFixtureRuntime,
  lifecycleSeedMemoryDefinitions,
} from '../fixture-provisioning/approved-memory-runtime.mjs';
import { expectedMemoryCandidatePayload } from '../fixture-provisioning/memory-candidate-owner.mjs';
import { stableJson } from '../lib/stable.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { createCase01MemoryFixtureRuntime } from '../fixture-provisioning/case01-memory-runtime.mjs';
import { createCaptureBindingOwner } from '../fixture-provisioning/capture-binding-owner.mjs';
import { FIXTURE_NAMESPACE, AUTHORIZED_TENANTS } from '../fixture-provisioning/contract.mjs';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  PROPOSER,
  REVIEWER,
} from './approved-memory-postgres-harness.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const source = (name) =>
  require(fileURLToPath(new URL(`../../../../apps/api/src/${name}.ts`, import.meta.url)));

export async function versionDependencies(deps, tx, memoryStore) {
  // The enclosing harness restores this key in finally; no deployed flag changes.
  process.env.MEMORY_CLIENT_REVIEW = 'enforce';
  await tx.$executeRawUnsafe(`ALTER TABLE memory_items ADD COLUMN review_cadence_days int,
    ADD COLUMN supersedes_id uuid, ADD COLUMN contradicts_id uuid, ADD COLUMN ingest_run_id uuid,
    ADD COLUMN ingested_at timestamptz`);
  const { ImmutableMemoryVersionService } = source('memory/immutable-memory-version.service');
  const { MemoryTransitionAuditService } = source('memory/memory-transition-audit.service');
  const { MemoryCleanupOutboxService } = source('memory/memory-cleanup-outbox.service');
  const { GovernedMemoryCandidateService } = source('memory/governed-memory-candidate.service');
  const versions = new ImmutableMemoryVersionService(
    deps.prisma,
    deps.tenantContext,
    memoryStore.authz,
    new MemoryTransitionAuditService(),
    new MemoryCleanupOutboxService(deps.prisma),
  );
  const projections = [];
  versions.embedAfterCommit = (value) => {
    projections.push({ tenantId: value.tenantId, memoryItemId: value.memoryItemId });
  };
  const memoryCandidates = new GovernedMemoryCandidateService(
    deps.prisma,
    {},
    { get: () => undefined },
    new MemoryTransitionAuditService(),
    new MemoryCleanupOutboxService(deps.prisma),
    memoryStore.authz,
  );
  memoryCandidates.dispatchProjectionFastPath = () => {};
  return {
    versions,
    memoryCandidates,
    projections,
    ...source('memory/synthetic-memory-version.helpers'),
  };
}

it(
  'creates actual weekly-to-monthly immutable lineage through guarded canonical correction and approval',
  { skip: !config },
  async () =>
    withOwnedApprovedMemory(config, async ({ deps, tx, manifest, memoryStore }) => {
      const {
        versions,
        projections,
        readSyntheticCorrectionInTx,
        readSyntheticCorrectionRetirementInTx,
      } = await versionDependencies(deps, tx, memoryStore);
      const seed = createApprovedMemoryFixtureRuntime({
        ...deps,
        lifecycleSeedSourceIds: ['MA1-v1'],
      });
      const original = await seed.create('MA1-v1');
      const definition = lifecycleSeedMemoryDefinitions(manifest, ['MA1-v1'])[0].candidate;
      const ctx = { tenantId: TENANT, userId: PROPOSER, role: 'standard_user' };
      const reviewer = { tenantId: TENANT, userId: REVIEWER, role: 'user_admin' };
      const content = manifest.records.find((row) => row.logicalId === 'MA1-v2').payload.facts.text;
      const guard = {
        sourceItemId: original.physicalId,
        proposerUserId: PROPOSER,
        expectedContent: content,
        source: {
          candidateId: original.candidateId,
          expectedRowVersion: original.candidateRowVersion,
          expectedItemRowVersion: original.itemRowVersion,
          expectedPayload: expectedMemoryCandidatePayload(
            definition,
            PROPOSER,
            stableJson({ ownership: definition.ownership, payload: definition.payload }),
          ),
        },
      };
      process.env.MEMORY_CLIENT_REVIEW = 'false';
      await assert.rejects(
        versions.proposeSyntheticCorrection(ctx, original.physicalId, content, guard),
      );
      process.env.MEMORY_CLIENT_REVIEW = 'enforce';
      await assert.rejects(
        versions.proposeSyntheticCorrection(ctx, original.physicalId, content, undefined),
      );
      await assert.rejects(
        versions.proposeSyntheticCorrection(ctx, original.physicalId, 'forged', guard),
      );
      await assert.rejects(
        versions.proposeSyntheticCorrection(ctx, original.physicalId, content, {
          ...guard,
          source: { ...guard.source, expectedItemRowVersion: '1' },
        }),
      );
      const proposed = await versions.proposeSyntheticCorrection(
        ctx,
        original.physicalId,
        content,
        guard,
      );
      assert.equal(proposed.status, 'pending_review');
      const pending = (
        await tx.$queryRawUnsafe(
          'SELECT xmin::text AS version FROM memory_candidate WHERE id=$1::uuid',
          proposed.candidateId,
        )
      )[0];
      const approvalGuard = { ...guard, expectedCandidateRowVersion: pending.version };
      await assert.rejects(
        versions.approveSyntheticCorrection(reviewer, proposed.candidateId, undefined),
      );
      await assert.rejects(
        versions.approveSyntheticCorrection(reviewer, proposed.candidateId, {
          ...approvalGuard,
          expectedCandidateRowVersion: '1',
        }),
      );
      await assert.rejects(
        versions.approveSyntheticCorrection(ctx, proposed.candidateId, approvalGuard),
      );
      const activated = await versions.approveSyntheticCorrection(
        reviewer,
        proposed.candidateId,
        approvalGuard,
      );
      assert.equal(activated.outcome, 'activated');
      assert.notEqual(activated.memoryItemId, original.physicalId);
      const proof = await deps.prisma.withTenantUser(TENANT, PROPOSER, (ownedTx) =>
        readSyntheticCorrectionInTx(ownedTx, ctx, approvalGuard, proposed.candidateId),
      );
      assert.equal(proof.itemId, activated.memoryItemId);
      assert.equal(proof.rootItemId, original.physicalId);
      assert.equal(proof.sourceVersion, `memory-version:${proposed.candidateId}`);
      assert.equal(proof.rootStatus, 'superseded');
      assert.equal(projections.length, 1);
      const subject = await memoryStore.authz.loadItemInTx(tx, TENANT, proof.itemId);
      assert.equal(
        (
          await memoryStore.authz.evaluateInTx(tx, ctx, subject, 'read', {
            emitDenialMetrics: false,
          })
        ).allowed,
        true,
      );
      await assert.rejects(
        readSyntheticCorrectionInTx(
          tx,
          ctx,
          { ...approvalGuard, expectedContent: 'forged' },
          proposed.candidateId,
        ),
      );
      const retirement = {
        correction: approvalGuard,
        candidateId: proposed.candidateId,
        expectedItemRowVersion: proof.itemRowVersion,
      };
      await assert.rejects(
        deps.tenantContext.run(reviewer, () =>
          memoryStore.forgetSyntheticCorrection(proof.itemId, {
            ...retirement,
            expectedItemRowVersion: '1',
          }),
        ),
      );
      const forgotten = await deps.tenantContext.run(reviewer, () =>
        memoryStore.forgetSyntheticCorrection(proof.itemId, retirement),
      );
      assert.equal(forgotten.found, true);
      const retired = await readSyntheticCorrectionRetirementInTx(
        tx,
        reviewer,
        proof.itemId,
        retirement,
      );
      assert.equal(retired.status, 'revoked');
      assert.equal(retired.retained, true);
      await assert.rejects(
        readSyntheticCorrectionInTx(tx, ctx, approvalGuard, proposed.candidateId),
      );
      await tx.$executeRawUnsafe(
        "UPDATE memory_items SET source_version='fake-v2' WHERE id=$1::uuid",
        proof.itemId,
      );
      await assert.rejects(
        readSyntheticCorrectionRetirementInTx(tx, reviewer, proof.itemId, retirement),
      );
    }),
);

it(
  'seeds all five real case01 states, requires actual previous retirement, then binds the new instance atomically',
  { skip: !config },
  async () =>
    withOwnedApprovedMemory(config, async ({ deps, tx, manifest, memoryStore }) => {
      const versionDeps = await versionDependencies(deps, tx, memoryStore);
      const helpers = {
        ...source('memory/synthetic-candidate-withdrawal.helpers'),
        ...source('memory/synthetic-approved-memory.helpers'),
        ...versionDeps,
      };
      const runtimeDeps = {
        ...deps,
        ...helpers,
        memoryVersions: versionDeps.versions,
        memoryAuthorization: memoryStore.authz,
      };
      const prior = createCase01MemoryFixtureRuntime(runtimeDeps);
      const seeded = await prior.seed();
      assert.equal(seeded.status, 'complete');
      assert.deepEqual(
        seeded.records.map((row) => [row.logicalId, row.lifecycle]),
        [
          ['MA1-v1', 'superseded'],
          ['MA1-v2', 'approved'],
          ['MA2', 'pending'],
          ['MA3', 'revoked'],
          ['MB1', 'approved'],
        ],
      );
      const ctx = {
        tenantId: TENANT,
        tenantSlug: AUTHORIZED_TENANTS.T1.slug,
        userId: PROPOSER,
        role: 'standard_user',
      };
      const initial = await prior.qualifyInTx(tx, ctx, { caseId: '01', clientId: CLIENT });
      assert.equal(initial.fixtureReady, false);
      assert.deepEqual(initial.missing, ['CANONICAL_RESET_RECEIPT_OWNER_MISSING']);
      assert.equal(
        (
          await prior.qualifyInTx(tx, ctx, {
            caseId: '01',
            clientId: CLIENT,
            resetReceipt: { status: 'complete' },
          })
        ).fixtureReady,
        false,
      );
      const reset = await prior.retire();
      assert.equal(reset.status, 'complete');
      assert.equal(reset.retained, true);
      await assert.rejects(prior.qualifyInTx(tx, ctx, { caseId: '01', clientId: CLIENT }));
      const replacement = await buildFixtureManifest({
        fixtureInstanceId: randomUUID(),
        clients: manifest.clients,
        actors: manifest.actors,
        uploaderActors: manifest.uploaderActors,
      });
      const current = createCase01MemoryFixtureRuntime({
        ...runtimeDeps,
        manifest: replacement,
        previousOwner: prior,
      });
      await current.seed();
      const qualified = await current.qualifyInTx(tx, ctx, { caseId: '01', clientId: CLIENT });
      assert.equal(qualified.fixtureReady, true);
      assert.deepEqual(qualified.missing, []);
      assert.match(qualified.resetReceiptId, /^meri-synthetic-fixture-reset-receipt:sha256:/);
      assert.match(qualified.seedReceiptId, /^meri-synthetic-fixture-seed-receipt:sha256:/);
      assert.deepEqual(Object.keys(qualified.sourceMap), ['MA1-v2']);
      assert.notEqual(
        qualified.sourceMap['MA1-v2'].physicalId,
        initial.sourceMap['MA1-v2'].physicalId,
      );
      for (const sql of [
        "UPDATE memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','\"forged\"') WHERE status='pending'",
        "UPDATE clients SET memory_wall=true WHERE id='22222222-2222-4222-8222-222222222222'",
        "UPDATE memory_items SET source_content_hash='forged' WHERE status='revoked'",
      ]) {
        await tx.$executeRawUnsafe('SAVEPOINT negative_tamper');
        try {
          await tx.$executeRawUnsafe(sql);
          await assert.rejects(current.qualifyInTx(tx, ctx, { caseId: '01', clientId: CLIENT }));
        } finally {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT negative_tamper');
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT negative_tamper');
        }
      }
      await tx.$executeRawUnsafe(
        "ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb DEFAULT '{}'",
      );
      await tx.$executeRawUnsafe(
        'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
        JSON.stringify({
          preserve: 'exact ',
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
      const owner = createCaptureBindingOwner({ prisma: deps.prisma, sourceAuthority: current });
      const request = {
        tenantId: TENANT,
        tenantSlug: ctx.tenantSlug,
        actorUserId: PROPOSER,
        clerkUserId: 'unit-clerk',
        caseId: '01',
        clientId: CLIENT,
        captureRunId: randomUUID(),
      };
      const plan = await owner.inspect(request);
      assert.equal(plan.status, 'READY');
      const result = await owner.bind({
        ...request,
        ...plan,
        expectedCurrentVerifySha256: plan.currentVerifySha256,
      });
      assert.equal(result.status, 'BOUND');
      const before = await tx.$queryRawUnsafe(
        'SELECT settings_jsonb FROM tenants WHERE id=$1::uuid',
        TENANT,
      );
      await tx.$executeRawUnsafe(
        "UPDATE memory_items SET source_version='fake' WHERE id=$1::uuid",
        qualified.sourceMap['MA1-v2'].physicalId,
      );
      await assert.rejects(owner.inspect(request));
      assert.deepEqual(
        await tx.$queryRawUnsafe('SELECT settings_jsonb FROM tenants WHERE id=$1::uuid', TENANT),
        before,
      );
    }),
);
