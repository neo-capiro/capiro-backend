import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  PROPOSER,
} from './approved-memory-postgres-harness.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
import { CONTROLLED_BUDGET_CASES } from '../fixture-provisioning/controlled-budget-definitions.mjs';
import {
  inspectControlledReadSetup,
  executeControlledReadSetup,
  qualifyControlledReadInTx,
} from '../fixture-provisioning/controlled-read-owner.mjs';
const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));

test('real owned PostgreSQL six budget definitions install/current-read/CAS/revocation and typed response shape; outer rollback', async () => {
  assert.ok(
    process.env.MERI_APPROVED_MEMORY_PG_CONFIG,
    'explicit owned loopback configuration required',
  );
  await withOwnedApprovedMemory(
    process.env.MERI_APPROVED_MEMORY_PG_CONFIG,
    async ({ deps, tx }) => {
      await tx.$executeRawUnsafe(
        "ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb DEFAULT '{}' ",
      );
      await tx.$executeRawUnsafe(
        "ALTER TABLE clients ADD COLUMN name text DEFAULT 'Aster Defense'",
      );
      await tx.$executeRawUnsafe('UPDATE clients SET memory_wall=true WHERE id=$1::uuid', CLIENT);
      await tx.$executeRawUnsafe(
        'INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1::uuid,$2::uuid,$3::uuid)',
        TENANT,
        CLIENT,
        PROPOSER,
      );
      await tx.$executeRawUnsafe(
        'CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text)',
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO users VALUES($1::uuid,$2,$3,$4,$5)',
        PROPOSER,
        'unit-clerk',
        FIXTURE_NAMESPACE + '-pat@example.com',
        'Pat',
        'Synthetic',
      );
      await tx.$executeRawUnsafe(
        'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
        JSON.stringify({
          unrelated: 'preserve',
          meriFoundationFixture: { fixtureNamespace: FIXTURE_NAMESPACE },
        }),
        TENANT,
      );
      const ctx = {
        tenantId: TENANT,
        tenantSlug: AUTHORIZED_TENANTS.T1.slug,
        userId: PROPOSER,
        clerkUserId: 'unit-clerk',
        role: 'standard_user',
      };
      const { createControlledBudgetToolResult } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/meri/meri-controlled-budget-result.ts',
            import.meta.url,
          ),
        ),
      );
      const { extractCitationsFromToolResult } = require('@capiro/shared');
      let previous;
      for (const caseId of CONTROLLED_BUDGET_CASES) {
        const args = { ctx, caseId, clientId: CLIENT, captureRunId: randomUUID() };
        const plan = await inspectControlledReadSetup(deps, args);
        await assert.rejects(
          executeControlledReadSetup(deps, {
            ...args,
            expectedPlanSha256: '0'.repeat(64),
            confirmation: 'INSTALL_OWNED_CONTROLLED_READ_FIXTURE',
          }),
          /STALE_PLAN/,
        );
        const installed = await executeControlledReadSetup(deps, {
          ...args,
          expectedPlanSha256: plan.planSha256,
          confirmation: 'INSTALL_OWNED_CONTROLLED_READ_FIXTURE',
        });
        const proof = await qualifyControlledReadInTx(tx, ctx, args);
        assert.equal(proof.currentVerifySha256, installed.binding.currentVerifySha256);
        assert.equal(proof.caseId, caseId);
        if (previous) await assert.rejects(qualifyControlledReadInTx(tx, ctx, previous));
        const tool = caseId === '27' ? 'search_program_elements' : 'get_pe_budget_timeline';
        const input =
          caseId === '27'
            ? { query: '0999999Z', service: 'Navy' }
            : { peCode: caseId === '26' ? '0912346T' : '0912345T' };
        const actual = createControlledBudgetToolResult(proof, tool, input, {
          owner: 'meri_controlled_read_v1',
          caseId,
          clientId: CLIENT,
          conversationId: randomUUID(),
          sourceVersion: 'v1',
        });
        assert.equal(actual.records.length, proof.definition.reads.length);
        assert.equal(actual.controlledRead.sourceReads.length, actual.records.length);
        assert.deepEqual(
          actual.records.map((r) => r.text),
          proof.definition.reads.map((r) => r.content),
        );
        const citations = extractCitationsFromToolResult(tool, actual);
        assert.deepEqual(
          citations.map((c) => c.id),
          proof.definition.reads.map((r) => r.physicalId),
        );
        assert.deepEqual(
          citations.map((c) => c.snippet),
          proof.definition.reads.map((r) => r.content),
        );
        assert.ok(
          citations.every((c) => c.source.kind === 'controlled_read' && c.source.version === 'v1'),
        );
        if (caseId === '22') {
          assert.deepEqual(
            actual.reportRecommendations.map((r) => r.amountUsd),
            [48000000, 45000000],
          );
          assert.ok(
            actual.years.every(
              (y) =>
                y.hascMark === undefined &&
                y.sascMark === undefined &&
                y.hacDMark === undefined &&
                y.sacDMark === undefined,
            ),
          );
          assert.equal(actual.currentFundingClaim?.value ?? null, null);
        }
        if (caseId === '26') {
          assert.equal(actual.currentCycleFy, null);
          assert.deepEqual(
            actual.records.map((r) => r.naturalKey),
            ['cost-category-a', 'cost-category-b'],
          );
          assert.equal(
            actual.records.reduce((sum, r) => sum + r.amountUsd, 0),
            8989000,
          );
        }
        if (caseId === '27') {
          assert.equal(actual.total, 0);
          assert.deepEqual(actual.data, []);
          assert.equal(actual.coverage.complete, true);
        }
        assert.throws(() =>
          createControlledBudgetToolResult(
            proof,
            tool,
            { ...input, peCode: 'foreign', clientId: randomUUID() },
            {},
          ),
        );
        await assert.rejects(qualifyControlledReadInTx(tx, { ...ctx, userId: randomUUID() }, args));
        await assert.rejects(
          qualifyControlledReadInTx(tx, { ...ctx, tenantId: AUTHORIZED_TENANTS.T2.id }, args),
        );
        await assert.rejects(
          qualifyControlledReadInTx(tx, ctx, { ...args, captureRunId: randomUUID() }),
        );
        previous = args;
      }
      await tx.$executeRawUnsafe(
        'DELETE FROM client_memory_access WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND user_id=$3::uuid',
        TENANT,
        CLIENT,
        PROPOSER,
      );
      await assert.rejects(qualifyControlledReadInTx(tx, ctx, previous));
      const rows = await tx.$queryRawUnsafe(
        'SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid',
        TENANT,
      );
      assert.equal(rows[0].settings.unrelated, 'preserve');
    },
  );
});
