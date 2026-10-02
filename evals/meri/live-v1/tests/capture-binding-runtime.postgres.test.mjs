import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { createApprovedMemoryFixtureRuntime } from '../fixture-provisioning/approved-memory-runtime.mjs';
import { createMemoryCaptureBindingRuntime } from '../fixture-provisioning/capture-binding-runtime.mjs';
import { createCaptureBindingOwner } from '../fixture-provisioning/capture-binding-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
import { sha256Stable } from '../lib/stable.mjs';
import { sourceMappingDigest } from '../capture-transport.mjs';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  PROPOSER,
} from './approved-memory-postgres-harness.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const ctx = {
  tenantId: TENANT,
  tenantSlug: AUTHORIZED_TENANTS.T1.slug,
  userId: PROPOSER,
  role: 'standard_user',
};

it(
  'reads actual canonical memory on the writer transaction; incomplete negative corpus cannot activate captureEvidence',
  { skip: !configPath },
  async () => {
    await withOwnedApprovedMemory(configPath, async ({ deps, tx, manifest, memoryStore }) => {
      const canonical = createApprovedMemoryFixtureRuntime({ ...deps, sourceIds: ['MA1-v2'] });
      const seedInventory = await canonical.createDataset();
      const { assertSyntheticApprovedMemoryInTx } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/memory/synthetic-approved-memory.helpers.ts',
            import.meta.url,
          ),
        ),
      );
      const runtime = createMemoryCaptureBindingRuntime({
        manifest,
        seedInventory,
        proposerForTenant: () => PROPOSER,
        assertSyntheticApprovedMemoryInTx,
        memoryAuthorization: memoryStore.authz,
      });
      const readback = await runtime.qualifyInTx(tx, ctx, { caseId: '01', clientId: CLIENT });
      assert.equal(readback.fixtureReady, false);
      assert.equal(readback.sourceMap['MA1-v2'].physicalId, seedInventory.bindings[0].physicalId);
      assert.equal(
        readback.physicalMapSha256,
        sourceMappingDigest({ scope: { sources: readback.sourceMap } }),
      );
      assert.notEqual(readback.physicalMapSha256, manifest.contentSha256);
      assert.equal(readback.currentVerify.observations.length, 1);
      assert.deepEqual(
        readback.missing,
        ['MA1-v1', 'MB1', 'MA2', 'MA3']
          .map((id) => `NEGATIVE_CORPUS_OWNER_MISSING:${id}`)
          .concat([
            'CANONICAL_SEED_RECEIPT_OWNER_MISSING',
            'CANONICAL_RESET_RECEIPT_OWNER_MISSING',
          ]),
      );
      await tx.$executeRawUnsafe(
        "ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb DEFAULT '{}'",
      );
      await tx.$executeRawUnsafe(
        'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
        JSON.stringify({
          preserve: 7,
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
      const owner = createCaptureBindingOwner({ prisma: deps.prisma, sourceAuthority: runtime });
      const request = {
        tenantId: TENANT,
        tenantSlug: AUTHORIZED_TENANTS.T1.slug,
        actorUserId: PROPOSER,
        clerkUserId: 'unit-clerk',
        clientId: CLIENT,
        caseId: '01',
        captureRunId: '88888888-8888-4888-8888-888888888888',
      };
      const plan = await owner.inspect(request);
      const result = await owner.bind({
        ...request,
        ...plan,
        expectedCurrentVerifySha256: plan.currentVerifySha256,
      });
      assert.equal(result.status, 'NOT_READY');
      const settings = (
        await tx.$queryRawUnsafe('SELECT settings_jsonb FROM tenants WHERE id=$1::uuid', TENANT)
      )[0].settings_jsonb;
      assert.deepEqual(settings, {
        preserve: 7,
        meriFoundationFixture: { fixtureNamespace: FIXTURE_NAMESPACE },
      });
      await tx.$executeRawUnsafe(
        'UPDATE memory_items SET source_version=$1 WHERE id=$2::uuid',
        'tampered-version',
        seedInventory.bindings[0].physicalId,
      );
      await assert.rejects(runtime.qualifyInTx(tx, ctx, { caseId: '01', clientId: CLIENT }));
    });
  },
);

it(
  'revalidates current authorization and rejects forged seed versions or foreign client joins',
  { skip: !configPath },
  async () => {
    await withOwnedApprovedMemory(configPath, async ({ deps, tx, manifest, memoryStore }) => {
      const canonical = createApprovedMemoryFixtureRuntime({ ...deps, sourceIds: ['MA1-v2'] });
      const seedInventory = await canonical.createDataset();
      const { assertSyntheticApprovedMemoryInTx } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/memory/synthetic-approved-memory.helpers.ts',
            import.meta.url,
          ),
        ),
      );
      const make = (inventory) =>
        createMemoryCaptureBindingRuntime({
          manifest,
          seedInventory: inventory,
          proposerForTenant: () => PROPOSER,
          assertSyntheticApprovedMemoryInTx,
          memoryAuthorization: memoryStore.authz,
        });
      for (const [key, value] of [
        ['itemRowVersion', '1'],
        ['clientId', '22222222-2222-4222-8222-222222222222'],
        ['physicalId', '99999999-9999-4999-8999-999999999999'],
      ]) {
        const changed = structuredClone(seedInventory);
        changed.bindings[0][key] = value;
        changed.bindingsSha256 = sha256Stable(changed.bindings);
        await assert.rejects(
          make(changed).qualifyInTx(tx, ctx, { caseId: '01', clientId: CLIENT }),
        );
      }
      const runtime = make(seedInventory);
      seedInventory.bindings[0].physicalId = '99999999-9999-4999-8999-999999999999';
      assert.equal(
        (await runtime.qualifyInTx(tx, ctx, { caseId: '01', clientId: CLIENT })).currentVerify
          .observations.length,
        1,
      );
      await tx.$executeRawUnsafe('UPDATE clients SET memory_wall=true WHERE id=$1::uuid', CLIENT);
      await assert.rejects(runtime.qualifyInTx(tx, ctx, { caseId: '01', clientId: CLIENT }));
    });
  },
);
