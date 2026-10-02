import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  inspectPendingMemorySetup,
  executePendingMemorySetup,
  readPendingMemorySetup,
  readPendingMemoryEvidenceForActor,
  runWithPendingMemorySetupActor,
} from '../fixture-provisioning/memory-pending-execution.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
import {
  withOwnedApprovedMemory,
  TENANT,
  PROPOSER,
  REVIEWER,
  CLIENT,
} from './approved-memory-postgres-harness.mjs';

const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
async function prepare(h, caseId = '17') {
  await h.tx.$executeRawUnsafe(
    "ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb DEFAULT '{}'::jsonb",
  );
  await h.tx.$executeRawUnsafe(
    'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
    JSON.stringify({
      unrelated: { preserve: true },
      meriFoundationFixture: { fixtureNamespace: FIXTURE_NAMESPACE },
    }),
    TENANT,
  );
  await h.tx.$executeRawUnsafe(
    'CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text)',
  );
  await h.tx.$executeRawUnsafe(
    "UPDATE tenant_memberships SET role='user_admin' WHERE user_id=$1::uuid",
    REVIEWER,
  );
  for (const [id, name] of [
    [PROPOSER, 'Pat'],
    [REVIEWER, 'Priya'],
  ])
    await h.tx.$executeRawUnsafe(
      'INSERT INTO users VALUES($1::uuid,$2,$3,$4,$5)',
      id,
      `user_${name}`,
      `${FIXTURE_NAMESPACE}-${name.toLowerCase()}@example.com`,
      'Synthetic',
      name,
    );
  const input = {
    schemaVersion: 1,
    target: 'capiro-dev',
    fixtureNamespace: FIXTURE_NAMESPACE,
    caseId,
    ctx: {
      tenantId: TENANT,
      tenantSlug: AUTHORIZED_TENANTS.T1.slug,
      userId: caseId === '17' ? REVIEWER : PROPOSER,
      role: caseId === '17' ? 'user_admin' : 'standard_user',
    },
    clerkUserId: caseId === '17' ? 'user_Priya' : 'user_Pat',
    fixtureInstanceId: randomUUID(),
    clients: h.manifest.clients,
    actors: {
      PAT: { tenantId: 'T1', physicalId: PROPOSER },
      PRIYA: { tenantId: 'T1', physicalId: REVIEWER },
    },
  };
  return input;
}

it(
  'source-owned case17 locator rehydrates through the actual authenticated GET after restart, with current actor and canonical row checks',
  { skip: !config },
  async () => {
    await withOwnedApprovedMemory(config, async (h) => {
      process.env.MEMORY_CLIENT_REVIEW = 'enforce';
      const input = await prepare(h);
      await h.tx.$executeRawUnsafe(
        "ALTER TABLE clients ADD COLUMN name text DEFAULT 'Synthetic client'",
      );
      const plan = await inspectPendingMemorySetup(h.deps, input);
      await executePendingMemorySetup(h.deps, input, {
        expectedPlanSha256: plan.planSha256,
        journal: async () => {},
      });
      const { GovernedMemoryCandidateService } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/memory/governed-memory-candidate.service.ts',
            import.meta.url,
          ),
        ),
      );
      const { MemoryProposalController } = require(
        fileURLToPath(
          new URL('../../../../apps/api/src/memory/memory-proposal.controller.ts', import.meta.url),
        ),
      );
      // A fresh service/controller instance has no setup process state or receipts.
      const service = Object.assign(Object.create(GovernedMemoryCandidateService.prototype), {
        governedPrisma: h.deps.prisma,
      });
      const controller = new MemoryProposalController(service, {});
      const ctx = { ...input.ctx, clerkUserId: input.clerkUserId };
      const { runWithMemoryGovernanceTenant } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/memory/memory-governance-tenant-scope.ts',
            import.meta.url,
          ),
        ),
      );
      const actualDeps = { ...h.deps, runWithMemoryGovernanceTenant };
      await runWithPendingMemorySetupActor(actualDeps, input, async () => {
        assert.equal(h.deps.tenantContext.get().role, 'user_admin');
      });
      await assert.rejects(
        runWithPendingMemorySetupActor(
          actualDeps,
          { ...input, ctx: { ...input.ctx, role: 'standard_user' } },
          async () => {},
        ),
        /RECIPE_INVALID/,
      );
      await h.tx.$executeRawUnsafe(
        "UPDATE tenant_memberships SET role='standard_user' WHERE user_id=$1::uuid",
        ctx.userId,
      );
      await assert.rejects(
        runWithPendingMemorySetupActor(actualDeps, input, async () => {
          throw new Error('must not run');
        }),
        /ACTOR_INVALID/,
      );
      await h.tx.$executeRawUnsafe(
        "UPDATE tenant_memberships SET role='user_admin' WHERE user_id=$1::uuid",
        ctx.userId,
      );
      const pages = [];
      let cursor;
      do {
        const page = await controller.listOwnProposals(ctx, cursor, '2');
        pages.push(page);
        cursor = page.nextCursor;
        assert.ok(pages.length <= 3);
      } while (cursor);
      assert.equal(pages.length, 3);
      assert.equal(pages.flatMap((page) => page.candidates).length, 6);
      assert.equal(pages[0].fixtureEvidence.records.length, 6);
      assert.deepEqual(
        pages.map((page) => page.fixtureEvidence),
        Array(3).fill(pages[0].fixtureEvidence),
      );
      assert.deepEqual(await readPendingMemorySetup(h.deps, input), pages[0].fixtureEvidence);
      const ordinary = await controller.listOwnProposals({
        ...ctx,
        userId: PROPOSER,
        clerkUserId: 'user_Pat',
      });
      assert.equal(Object.hasOwn(ordinary, 'fixtureEvidence'), false);
      assert.equal(
        await readPendingMemoryEvidenceForActor(h.deps, {
          ...ctx,
          tenantId: AUTHORIZED_TENANTS.T2.id,
        }),
        null,
      );
      await assert.rejects(
        controller.listOwnProposals({ ...ctx, clerkUserId: 'user_forged' }),
        /CURRENT_ACTOR_MISMATCH/,
      );
      await h.tx.$executeRawUnsafe(
        "UPDATE tenant_memberships SET status='inactive' WHERE user_id=$1::uuid",
        ctx.userId,
      );
      await assert.rejects(controller.listOwnProposals(ctx), /ACTOR_INVALID/);
      await h.tx.$executeRawUnsafe(
        "UPDATE tenant_memberships SET status='active' WHERE user_id=$1::uuid",
        ctx.userId,
      );
      await h.tx.$executeRawUnsafe('UPDATE clients SET memory_wall=true WHERE id=$1::uuid', CLIENT);
      await assert.rejects(controller.listOwnProposals(ctx), /CLIENT_WALL/);
      await h.tx.$executeRawUnsafe(
        'UPDATE clients SET memory_wall=false WHERE id=$1::uuid',
        CLIENT,
      );
      const first = pages[0].fixtureEvidence.records[0].physicalId;
      await h.tx.$executeRawUnsafe(
        "UPDATE memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','\"tampered\"'::jsonb) WHERE id=$1::uuid",
        first,
      );
      await assert.rejects(controller.listOwnProposals(ctx), /MEMORY_CANDIDATE|OWNER_READBACK/);
    });
  },
);

for (const caseId of ['17', '14'])
  it(
    `case${caseId} canonical pending operator claims once and rehydrates actual owner state without a model`,
    { skip: !config },
    async () => {
      await withOwnedApprovedMemory(config, async (h) => {
        const input = await prepare(h, caseId),
          entries = [];
        const plan = await inspectPendingMemorySetup(h.deps, input);
        const receipt = await executePendingMemorySetup(h.deps, input, {
          expectedPlanSha256: plan.planSha256,
          journal: async (value) => entries.push(value),
        });
        assert.equal(receipt.records.length, caseId === '17' ? 6 : 1);
        assert.ok(
          receipt.records.every(
            (row) => row.status === 'pending' && row.proposerUserId === input.ctx.userId,
          ),
        );
        assert.equal(receipt.synthesisSubmissionCount, 0);
        assert.equal(receipt.liveAcceptance, 'NOT_RUN');
        const read = await readPendingMemorySetup(h.deps, structuredClone(input));
        assert.deepEqual(read.records, receipt.records);
        assert.equal(read.setupReceiptSha256, receipt.receiptSha256);
        assert.equal(entries.at(-1).stage, 'COMPLETE');
        await assert.rejects(
          executePendingMemorySetup(h.deps, input, {
            expectedPlanSha256: plan.planSha256,
            journal: async () => {},
          }),
          /EXISTING_OPERATION/,
        );
        assert.equal(
          (await h.tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM memory_items'))[0].count,
          0,
        );
        assert.equal(
          (
            await h.tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM memory_cleanup_outbox')
          )[0].count,
          0,
        );
        assert.equal(h.projectionCalls.length, 0);
        assert.deepEqual(
          (
            await h.tx.$queryRawUnsafe(
              'SELECT settings_jsonb FROM tenants WHERE id=$1::uuid',
              TENANT,
            )
          )[0].settings_jsonb.unrelated,
          { preserve: true },
        );
        await h.tx.$executeRawUnsafe(
          'UPDATE clients SET memory_wall=true WHERE id=$1::uuid',
          CLIENT,
        );
        await assert.rejects(readPendingMemorySetup(h.deps, input), /CLIENT_WALL/);
        await h.tx.$executeRawUnsafe(
          'UPDATE clients SET memory_wall=false WHERE id=$1::uuid',
          CLIENT,
        );
        await h.tx.$executeRawUnsafe(
          "UPDATE tenant_memberships SET status='inactive' WHERE user_id=$1::uuid",
          input.ctx.userId,
        );
        await assert.rejects(readPendingMemorySetup(h.deps, input), /ACTOR_INVALID/);
      });
    },
  );

it(
  'partial canonical creation retains the durable claim and refuses retries, altered identity and stale plans',
  { skip: !config },
  async () => {
    await withOwnedApprovedMemory(config, async (h) => {
      const input = await prepare(h),
        plan = await inspectPendingMemorySetup(h.deps, input);
      await assert.rejects(
        inspectPendingMemorySetup(h.deps, { ...input, ctx: { ...input.ctx, userId: PROPOSER } }),
        /PROPOSER_MISMATCH/,
      );
      await assert.rejects(
        inspectPendingMemorySetup(h.deps, { ...input, clerkUserId: 'user_else' }),
        /ACTOR_INVALID/,
      );
      await assert.rejects(
        executePendingMemorySetup(h.deps, input, {
          expectedPlanSha256: '0'.repeat(64),
          journal: async () => {},
        }),
        /PLAN_STALE/,
      );
      const entries = [];
      await assert.rejects(
        executePendingMemorySetup(h.deps, input, {
          expectedPlanSha256: plan.planSha256,
          journal: async (value) => {
            entries.push(value);
            if (value.phase === 'ACKNOWLEDGED') throw new Error('owned journal failure');
          },
        }),
        /owned journal failure/,
      );
      assert.equal(entries.at(-1).phase, 'RECONCILIATION_REQUIRED');
      assert.equal(
        (await h.tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM memory_candidate'))[0]
          .count,
        1,
      );
      await assert.rejects(inspectPendingMemorySetup(h.deps, input), /EXISTING_OPERATION/);
      await assert.rejects(readPendingMemorySetup(h.deps, input), /COMPLETED_OWNER_REQUIRED/);
    });
  },
);
