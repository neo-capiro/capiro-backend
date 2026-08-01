#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import {
  executeGovernanceBackfill,
  prepareGovernanceBackfill,
  rollbackGovernanceBackfill,
} from './lib/memory-governance-backfill-store.js';
import {
  governanceStateFromRow,
  governanceStatesEqual,
  type GovernanceState,
  type GovernanceStateRow,
} from './lib/memory-governance-backfill.js';

const TENANT = '18180000-0000-4000-8000-000000000201';
const ITEM = '18180000-0000-4000-8000-000000000202';

async function currentState(prisma: PrismaClient): Promise<GovernanceState> {
  const rows = await prisma.$queryRawUnsafe<GovernanceStateRow[]>(
    `SELECT memory_class AS "memoryClass",
            memory_authority AS "memoryAuthority",
            memory_scope AS "memoryScope",
            governed_status AS "governedStatus",
            source_type AS "sourceType",
            source_id AS "sourceId",
            review_due_at AS "reviewDueAt"
     FROM memory_items WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    ITEM,
    TENANT,
  );
  assert.ok(rows[0], 'Phase 18 backfill fixture must exist');
  return governanceStateFromRow(rows[0]!);
}

async function snapshotStates(
  prisma: PrismaClient,
  jobId: string,
): Promise<{ before: GovernanceState; expected: GovernanceState }> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ before_state_jsonb: GovernanceState; expected_post_state_jsonb: GovernanceState }>
  >(
    `SELECT before_state_jsonb, expected_post_state_jsonb
     FROM memory_governance_backfill_row
     WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND memory_item_id = $3::uuid`,
    TENANT,
    jobId,
    ITEM,
  );
  assert.ok(rows[0], 'prepared snapshot row must exist');
  return { before: rows[0]!.before_state_jsonb, expected: rows[0]!.expected_post_state_jsonb };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = '${TENANT}'::uuid`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO tenants (id, slug, name, status)
      VALUES ('${TENANT}'::uuid, 'phase18-backfill', 'Phase 18 Backfill', 'active')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO memory_items
        (id, tenant_id, type, visibility, slug, title, source, source_ref, provenance,
         memory_class, memory_authority, memory_scope, governed_status, source_type)
      VALUES
        ('${ITEM}'::uuid, '${TENANT}'::uuid, 'playbook', 'tenant', 'phase18-backfill-item',
         'Phase 18 Backfill Item', 'settings', 'phase18-source', 'human',
         'legacy_unclassified', 'legacy_unclassified', 'firm', 'pending_review', 'unknown')
    `);

    const prepared = (await prepareGovernanceBackfill(prisma, TENANT)) as {
      jobId: string;
      canonicalRowsMutated: number;
      status: string;
    };
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.canonicalRowsMutated, 0);
    const snapshots = await snapshotStates(prisma, prepared.jobId);
    assert.ok(
      governanceStatesEqual(await currentState(prisma), snapshots.before),
      'prepare/dry-run must not mutate canonical governance state',
    );

    const executed = (await executeGovernanceBackfill(prisma, TENANT, prepared.jobId)) as {
      status: string;
      idempotent?: boolean;
    };
    assert.equal(executed.status, 'executed');
    assert.ok(
      governanceStatesEqual(await currentState(prisma), snapshots.expected),
      'execute must converge exactly to the prepared expected state',
    );

    const rerun = (await executeGovernanceBackfill(prisma, TENANT, prepared.jobId)) as {
      status: string;
      idempotent?: boolean;
    };
    assert.equal(rerun.status, 'executed');
    assert.equal(rerun.idempotent, true);
    assert.ok(
      governanceStatesEqual(await currentState(prisma), snapshots.expected),
      'idempotent execute rerun must preserve the verified expected state',
    );

    const rolledBack = (await rollbackGovernanceBackfill(prisma, TENANT, prepared.jobId)) as {
      status: string;
      idempotent?: boolean;
    };
    assert.ok(['rolled_back', 'rollback_partial'].includes(rolledBack.status));
    assert.equal(rolledBack.status, 'rolled_back');
    assert.ok(
      governanceStatesEqual(await currentState(prisma), snapshots.before),
      'rollback must restore the prepared before state when no later drift exists',
    );

    const rollbackRerun = (await rollbackGovernanceBackfill(prisma, TENANT, prepared.jobId)) as {
      status: string;
      idempotent?: boolean;
    };
    assert.equal(rollbackRerun.status, 'rolled_back');
    assert.equal(rollbackRerun.idempotent, true);

    const eventCounts = await prisma.$queryRawUnsafe<Array<{ event_type: string; count: bigint }>>(
      `SELECT event_type, count(*)::bigint AS count
       FROM memory_governance_backfill_event
       WHERE tenant_id = $1::uuid AND job_id = $2::uuid
       GROUP BY event_type ORDER BY event_type`,
      TENANT,
      prepared.jobId,
    );
    console.log(
      JSON.stringify({
        marker: 'MERIV2_PHASE18_BACKFILL_REHEARSAL_OK',
        jobId: prepared.jobId,
        dryRunNoMutation: true,
        executeVerified: true,
        executeRerunIdempotent: true,
        rollbackVerified: true,
        rollbackRerunIdempotent: true,
        events: eventCounts.map((row) => ({ eventType: row.event_type, count: Number(row.count) })),
      }),
    );
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = '${TENANT}'::uuid`).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      marker: 'MERIV2_PHASE18_BACKFILL_REHEARSAL_FAILED',
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    }),
  );
  process.exitCode = 1;
});
