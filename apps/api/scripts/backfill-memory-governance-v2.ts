#!/usr/bin/env tsx
/**
 * Conservative Memory Governance v2 backfill. DRY-RUN by default.
 *
 * Usage:
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts --tenant-id <uuid>
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts --tenant-id <uuid> --execute --confirm <uuid>
 *
 * `--execute` requires the tenant UUID to be repeated in `--confirm`. This script
 * is not run against production as part of Phase 3 implementation.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  classifyLegacyMemory,
  type GovernedMemoryStatus,
  type MemoryAuthority,
  type MemoryClass,
} from '@capiro/meriv2-core';

dotenvConfig();

interface Args {
  tenantId: string;
  execute: boolean;
  confirm: string | null;
}

interface LegacyRow {
  id: string;
  tenantId: string;
  clientId: string | null;
  ownerUserId: string | null;
  type: string;
  visibility: string;
  slug: string;
  source: string;
  sourceRef: string | null;
  provenance: string;
  status: string;
  expiresAt: Date | null;
  legalHold: boolean;
  memoryClass: string;
  memoryAuthority: string;
  memoryScope: string;
  governedStatus: string;
}

interface ClassificationPlan {
  id: string;
  type: string;
  slug: string;
  memoryClass: MemoryClass;
  memoryAuthority: MemoryAuthority;
  memoryScope: 'firm' | 'client' | 'user_private';
  governedStatus: GovernedMemoryStatus;
  sourceType: string;
  sourceId: string | null;
  reason: string;
  confidence: 'deterministic' | 'ambiguous';
  quarantined: boolean;
}

function parseArgs(argv: string[]): Args {
  const tenantAt = argv.indexOf('--tenant-id');
  const tenantId = tenantAt >= 0 ? argv[tenantAt + 1] ?? '' : '';
  const confirmAt = argv.indexOf('--confirm');
  const confirm = confirmAt >= 0 ? argv[confirmAt + 1] ?? null : null;
  const execute = argv.includes('--execute');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(tenantId)) {
    throw new Error('--tenant-id <uuid> is required');
  }
  if (execute && confirm !== tenantId) {
    throw new Error('--execute requires --confirm to exactly equal --tenant-id');
  }
  return { tenantId, execute, confirm };
}

function sourceTypeFor(row: LegacyRow): string {
  if (row.type === 'playbook' || row.type.startsWith('firm-')) return 'firm_playbook';
  if (row.type.startsWith('client-')) return 'client_record';
  if (row.type.startsWith('user-')) return 'user_message';
  if (row.slug.startsWith('clio:')) return 'legacy_projection';
  if (row.source === 'meeting') return 'confirmed_meeting_outcome';
  if (row.source === 'crm' || row.source === 'client') return 'crm_record';
  return 'unknown';
}

function scopeFor(row: LegacyRow): 'firm' | 'client' | 'user_private' {
  if (row.clientId) return 'client';
  if (row.visibility === 'user' || row.ownerUserId) return 'user_private';
  return 'firm';
}

function buildPlan(row: LegacyRow, duplicateIds: Set<string>): ClassificationPlan {
  const classified = classifyLegacyMemory({
    type: row.type,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    clientId: row.clientId,
    provenance: row.provenance,
    source: row.source,
    slug: row.slug,
    expiresAt: row.expiresAt,
    legalHold: row.legalHold,
  });
  const duplicate = duplicateIds.has(row.id);
  const sourceType = sourceTypeFor(row);
  const missingSource = sourceType === 'unknown' && !row.sourceRef;
  const classScopeMismatch =
    (classified.memoryClass === 'institutional_authoritative' && scopeFor(row) !== 'firm') ||
    (classified.memoryClass === 'client_steering' && scopeFor(row) !== 'client') ||
    (['user_preference', 'episodic_working'].includes(classified.memoryClass) &&
      scopeFor(row) !== 'user_private');
  const quarantined =
    classified.confidence === 'ambiguous' || duplicate || missingSource || classScopeMismatch;
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    memoryClass: quarantined ? 'legacy_unclassified' : classified.memoryClass,
    memoryAuthority: quarantined ? 'legacy_unclassified' : classified.authority,
    memoryScope: scopeFor(row),
    governedStatus: quarantined ? 'pending_review' : classified.status,
    sourceType,
    sourceId: row.sourceRef,
    reason: [
      classified.reason,
      ...(duplicate ? ['Duplicate client-scope identity requires human resolution.'] : []),
      ...(missingSource ? ['Source identity is missing or unknown.'] : []),
      ...(classScopeMismatch ? ['Class and scope do not align.'] : []),
    ].join(' '),
    confidence: quarantined ? 'ambiguous' : classified.confidence,
    quarantined,
  };
}

async function requireMigration(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_items' AND column_name = 'memory_class'
    ) AS present
  `);
  if (!rows[0]?.present) {
    throw new Error('Phase 3 migration is not applied; run the diagnostic only.');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await requireMigration(prisma);
    const rows = await prisma.$queryRaw<LegacyRow[]>(Prisma.sql`
      SELECT id::text AS id,
             tenant_id::text AS "tenantId",
             client_id::text AS "clientId",
             owner_user_id::text AS "ownerUserId",
             type, visibility, slug, source, source_ref AS "sourceRef", provenance,
             status, expires_at AS "expiresAt", legal_hold AS "legalHold",
             memory_class AS "memoryClass",
             memory_authority AS "memoryAuthority",
             memory_scope AS "memoryScope",
             governed_status AS "governedStatus"
      FROM memory_items
      WHERE tenant_id = ${args.tenantId}::uuid
      ORDER BY type, slug, id
    `);

    const duplicateRows = await prisma.$queryRaw<Array<{ ids: string[] }>>(Prisma.sql`
      SELECT array_agg(id::text ORDER BY created_at, id) AS ids
      FROM memory_items
      WHERE tenant_id = ${args.tenantId}::uuid AND client_id IS NOT NULL
      GROUP BY client_id, type, slug
      HAVING count(*) > 1
    `);
    const duplicateIds = new Set(duplicateRows.flatMap((row) => row.ids));
    const plans = rows.map((row) => buildPlan(row, duplicateIds));
    const alreadyClassified = rows.filter((row) => row.memoryClass !== 'legacy_unclassified').length;
    const pendingUpdates = plans.filter(
      (plan, index) => {
        const existing = rows[index]!;
        return (
          existing.memoryClass !== plan.memoryClass ||
          existing.memoryAuthority !== plan.memoryAuthority ||
          existing.memoryScope !== plan.memoryScope ||
          existing.governedStatus !== plan.governedStatus
        );
      },
    );

    const before = summarize(rows.map((row) => ({
      memoryClass: row.memoryClass,
      memoryAuthority: row.memoryAuthority,
      governedStatus: row.governedStatus,
      quarantined: row.memoryClass === 'legacy_unclassified',
    })));
    const after = summarize(plans.map((plan) => ({
      memoryClass: plan.memoryClass,
      memoryAuthority: plan.memoryAuthority,
      governedStatus: plan.governedStatus,
      quarantined: plan.quarantined,
    })));

    if (args.execute && pendingUpdates.length) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${args.tenantId}, true)`;
        for (const plan of pendingUpdates) {
          await tx.$executeRaw`
            UPDATE memory_items
            SET memory_class = ${plan.memoryClass},
                memory_authority = ${plan.memoryAuthority},
                memory_scope = ${plan.memoryScope},
                governed_status = ${plan.governedStatus},
                source_type = CASE
                  WHEN source_type = 'unknown' THEN ${plan.sourceType}
                  ELSE source_type
                END,
                source_id = COALESCE(source_id, ${plan.sourceId}),
                review_due_at = CASE
                  WHEN review_cadence_days IS NOT NULL
                    THEN COALESCE(last_confirmed_at, created_at) + make_interval(days => review_cadence_days)
                  ELSE review_due_at
                END
            WHERE tenant_id = ${args.tenantId}::uuid
              AND id = ${plan.id}::uuid
              AND memory_class = 'legacy_unclassified'
          `;
          await tx.$executeRaw`
            INSERT INTO memory_transition_audit
              (tenant_id, memory_item_id, effective_tenant_id, client_id,
               from_status, to_status, reason_code, reason, source_type, source_id,
               metadata_jsonb)
            SELECT tenant_id, id, tenant_id, client_id,
                   'pending_review', ${plan.governedStatus},
                   ${plan.quarantined ? 'backfill_quarantined' : 'backfill_classified'},
                   ${plan.reason.slice(0, 2000)},
                   ${plan.sourceType}, ${plan.sourceId},
                   jsonb_build_object(
                     'memoryClass', ${plan.memoryClass},
                     'memoryAuthority', ${plan.memoryAuthority},
                     'memoryScope', ${plan.memoryScope},
                     'dryRunClassifier', 'memory-governance-v2'
                   )
            FROM memory_items
            WHERE tenant_id = ${args.tenantId}::uuid AND id = ${plan.id}::uuid
              AND NOT EXISTS (
                SELECT 1 FROM memory_transition_audit a
                WHERE a.tenant_id = ${args.tenantId}::uuid
                  AND a.memory_item_id = ${plan.id}::uuid
                  AND a.reason_code IN ('backfill_classified','backfill_quarantined')
                  AND a.metadata_jsonb->>'dryRunClassifier' = 'memory-governance-v2'
              )
          `;
        }
      });
    }

    const report = {
      job: 'backfill-memory-governance-v2',
      tenantId: args.tenantId,
      mode: args.execute ? 'execute' : 'dry-run',
      generatedAt: new Date().toISOString(),
      totalRows: rows.length,
      alreadyClassified,
      wouldUpdate: pendingUpdates.length,
      duplicateIdentityRows: duplicateIds.size,
      before,
      after,
      quarantineCount: plans.filter((plan) => plan.quarantined).length,
      quarantine: plans
        .filter((plan) => plan.quarantined)
        .map(({ id, type, slug, memoryScope, sourceType, reason }) => ({
          id,
          type,
          slug,
          memoryScope,
          sourceType,
          reason,
        })),
      idempotency: {
        updatePredicate: "memory_class = 'legacy_unclassified'",
        auditDedupe: 'tenant + item + classifier reason',
      },
      productionExecutedByThisTask: false,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

function summarize(
  rows: Array<{
    memoryClass: string;
    memoryAuthority: string;
    governedStatus: string;
    quarantined: boolean;
  }>,
): Record<string, unknown> {
  const byClass: Record<string, number> = {};
  const byAuthority: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let quarantined = 0;
  for (const row of rows) {
    byClass[row.memoryClass] = (byClass[row.memoryClass] ?? 0) + 1;
    byAuthority[row.memoryAuthority] = (byAuthority[row.memoryAuthority] ?? 0) + 1;
    byStatus[row.governedStatus] = (byStatus[row.governedStatus] ?? 0) + 1;
    if (row.quarantined) quarantined += 1;
  }
  return { byClass, byAuthority, byStatus, quarantined };
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      job: 'backfill-memory-governance-v2',
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    }),
  );
  process.exitCode = 1;
});
