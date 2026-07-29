#!/usr/bin/env tsx
/**
 * READ-ONLY Memory Governance v2 inventory.
 *
 * Usage:
 *   pnpm --filter @capiro/api exec tsx scripts/diag-memory-governance-v2.ts
 *   pnpm --filter @capiro/api exec tsx scripts/diag-memory-governance-v2.ts --tenant-id <uuid>
 *
 * It never writes, never prints memory bodies/source excerpts, and works before
 * or after the Phase 3 migration. Counts are intended for the migration worklog,
 * authority-inflation review, and projection parity gate.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';

dotenvConfig();

interface Args {
  tenantId: string | null;
}

function parseArgs(argv: string[]): Args {
  const at = argv.indexOf('--tenant-id');
  const tenantId = at >= 0 ? argv[at + 1] ?? null : null;
  if (tenantId && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(tenantId)) {
    throw new Error('--tenant-id must be a UUID');
  }
  return { tenantId };
}

async function hasColumn(
  prisma: PrismaClient,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${table}
        AND column_name = ${column}
    ) AS present
  `);
  return rows[0]?.present === true;
}

function tenantClause(tenantId: string | null, alias = ''): Prisma.Sql {
  return tenantId
    ? Prisma.sql`AND ${Prisma.raw(alias ? `${alias}.tenant_id` : 'tenant_id')} = ${tenantId}::uuid`
    : Prisma.empty;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const v2 = await hasColumn(prisma, 'memory_items', 'memory_class');
    const packetVersion = await hasColumn(prisma, 'context_packet', 'packet_version');
    const tenant = tenantClause(args.tenantId);

    const itemDimensions = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT
        type,
        visibility,
        status,
        source,
        provenance,
        legal_hold AS "legalHold",
        CASE
          WHEN client_id IS NOT NULL THEN 'client'
          WHEN visibility = 'user' OR owner_user_id IS NOT NULL THEN 'user_private'
          ELSE 'firm'
        END AS inferred_scope,
        ${v2 ? 'memory_class, memory_authority, memory_scope, governed_status, conflict_status,' : ''}
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE client_id IS NOT NULL)::int AS "clientScoped",
        COUNT(*) FILTER (WHERE owner_user_id IS NOT NULL)::int AS "ownerScoped",
        COUNT(*) FILTER (WHERE expires_at IS NOT NULL)::int AS "expiring",
        COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now())::int AS "expired",
        COUNT(*) FILTER (WHERE confidence IS NULL)::int AS "missingConfidence",
        COUNT(*) FILTER (WHERE source_ref IS NULL OR btrim(source_ref) = '')::int AS "missingSourceRef"
      FROM memory_items
      WHERE 1=1 ${args.tenantId ? `AND tenant_id = '${args.tenantId}'::uuid` : ''}
      GROUP BY type, visibility, status, source, provenance, legal_hold, inferred_scope
        ${v2 ? ', memory_class, memory_authority, memory_scope, governed_status, conflict_status' : ''}
      ORDER BY count DESC, type ASC
    `);

    const candidateDimensions = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT
        source_kind AS "sourceKind",
        scope,
        status,
        ${v2 ? 'memory_class, memory_authority, memory_scope, governed_status, source_type, conflict_status,' : ''}
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE client_id IS NOT NULL)::int AS "clientScoped",
        COUNT(*) FILTER (WHERE confidence IS NULL)::int AS "missingConfidence",
        COUNT(*) FILTER (WHERE provenance_jsonb IS NULL OR provenance_jsonb = '{}'::jsonb)::int AS "missingProvenance"
      FROM memory_candidate
      WHERE 1=1 ${args.tenantId ? `AND tenant_id = '${args.tenantId}'::uuid` : ''}
      GROUP BY source_kind, scope, status
        ${v2 ? ', memory_class, memory_authority, memory_scope, governed_status, source_type, conflict_status' : ''}
      ORDER BY count DESC, source_kind ASC
    `);

    const duplicateClientKeys = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT tenant_id::text AS "tenantId", client_id::text AS "clientId", type, slug,
             COUNT(*)::int AS count,
             array_agg(id::text ORDER BY created_at ASC) AS "itemIds"
      FROM memory_items
      WHERE client_id IS NOT NULL
        ${args.tenantId ? `AND tenant_id = '${args.tenantId}'::uuid` : ''}
      GROUP BY tenant_id, client_id, type, slug
      HAVING COUNT(*) > 1
      ORDER BY count DESC, tenant_id, client_id, type, slug
      LIMIT 500
    `);

    const sourceCoverage = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE source_ref IS NOT NULL AND btrim(source_ref) <> '')::int AS "withSourceRef",
        COUNT(*) FILTER (WHERE provenance IS NOT NULL AND btrim(provenance) <> '')::int AS "withProvenance",
        COUNT(*) FILTER (WHERE last_confirmed_at IS NOT NULL)::int AS "humanConfirmed",
        COUNT(*) FILTER (WHERE review_cadence_days IS NOT NULL)::int AS "withReviewCadence",
        COUNT(*) FILTER (WHERE supersedes_id IS NOT NULL)::int AS "supersedingVersions",
        COUNT(*) FILTER (WHERE contradicts_id IS NOT NULL)::int AS "contradictions",
        COUNT(*) FILTER (WHERE legal_hold)::int AS "legalHold"
        ${v2 ? `,
        COUNT(*) FILTER (WHERE memory_class = 'legacy_unclassified')::int AS "v2Unclassified",
        COUNT(*) FILTER (WHERE governed_status = 'pending_review')::int AS "v2PendingReview",
        COUNT(*) FILTER (WHERE approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)::int AS "v2Approved",
        COUNT(*) FILTER (WHERE source_type = 'unknown')::int AS "v2UnknownSource",
        COUNT(*) FILTER (WHERE conflict_status = 'open')::int AS "v2OpenConflicts"` : ''}
      FROM memory_items
      WHERE 1=1 ${args.tenantId ? `AND tenant_id = '${args.tenantId}'::uuid` : ''}
    `);

    const projectionCoverage = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT
        COUNT(*)::int AS "memoryItems",
        COUNT(*) FILTER (WHERE ce.source_id IS NOT NULL)::int AS "withEmbedding",
        COUNT(*) FILTER (WHERE ce.source_id IS NULL)::int AS "missingEmbedding",
        COUNT(*) FILTER (WHERE mi.status IN ('revoked','superseded') AND ce.source_id IS NOT NULL)::int AS "inactiveWithEmbedding"
        ${v2 ? `,
        COUNT(*) FILTER (WHERE mi.governed_status IN ('revoked','superseded','rejected','expired') AND ce.source_id IS NOT NULL)::int AS "v2SuppressedWithEmbedding"` : ''}
      FROM memory_items mi
      LEFT JOIN context_embeddings ce
        ON ce.tenant_id = mi.tenant_id
       AND ce.source_type = 'memory_item'
       AND ce.source_id = mi.id::text
      WHERE 1=1 ${args.tenantId ? `AND mi.tenant_id = '${args.tenantId}'::uuid` : ''}
    `);

    const graphCoverage = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT
        COUNT(DISTINCT mi.id)::int AS "memoryItems",
        COUNT(DISTINCT me.src_item_id)::int AS "itemsWithEdges",
        COUNT(me.id)::int AS edges,
        COUNT(me.id) FILTER (WHERE mi.status IN ('revoked','superseded'))::int AS "inactiveSourceEdges"
        ${v2 ? `,
        COUNT(me.id) FILTER (WHERE mi.governed_status IN ('revoked','superseded','rejected','expired'))::int AS "v2SuppressedSourceEdges"` : ''}
      FROM memory_items mi
      LEFT JOIN memory_edges me ON me.src_item_id = mi.id AND me.tenant_id = mi.tenant_id
      WHERE 1=1 ${args.tenantId ? `AND mi.tenant_id = '${args.tenantId}'::uuid` : ''}
    `);

    const ambiguousLegacy = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT
        type,
        source,
        provenance,
        CASE
          WHEN client_id IS NOT NULL THEN 'client'
          WHEN visibility = 'user' OR owner_user_id IS NOT NULL THEN 'user_private'
          ELSE 'firm'
        END AS inferred_scope,
        COUNT(*)::int AS count
      FROM memory_items
      WHERE type NOT IN (
        'firm-soul','firm-compass','playbook','client-soul','client-compass',
        'client-people','user-voice','user-profile'
      )
        AND NOT (slug LIKE 'clio:%' AND owner_user_id IS NOT NULL AND expires_at IS NOT NULL)
        ${args.tenantId ? `AND tenant_id = '${args.tenantId}'::uuid` : ''}
      GROUP BY type, source, provenance, inferred_scope
      ORDER BY count DESC, type ASC
    `);

    const packetCoverage = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT surface,
             ${packetVersion ? 'packet_version AS "packetVersion",' : ''}
             COUNT(*)::int AS count,
             MAX(created_at) AS "latestAt",
             AVG(item_count)::numeric(12,2) AS "avgItems",
             AVG(exclusion_count)::numeric(12,2) AS "avgExclusions"
      FROM context_packet
      WHERE 1=1 ${args.tenantId ? `AND tenant_id = '${args.tenantId}'::uuid` : ''}
      GROUP BY surface ${packetVersion ? ', packet_version' : ''}
      ORDER BY surface ${packetVersion ? ', packet_version' : ''}
    `);

    const report = {
      diagnostic: 'memory-governance-v2',
      mode: 'read-only',
      generatedAt: new Date().toISOString(),
      tenantId: args.tenantId,
      migrationPresent: v2,
      contextPacketVersionColumnPresent: packetVersion,
      memoryItemsByDimension: itemDimensions,
      candidatesByDimension: candidateDimensions,
      duplicateClientScopeIdentities: duplicateClientKeys,
      sourceAndGovernanceCoverage: sourceCoverage[0] ?? {},
      embeddingProjectionCoverage: projectionCoverage[0] ?? {},
      graphProjectionCoverage: graphCoverage[0] ?? {},
      ambiguousLegacyClassificationCohorts: ambiguousLegacy,
      contextPacketCoverage: packetCoverage,
      warnings: [
        ...(duplicateClientKeys.length
          ? [`${duplicateClientKeys.length} duplicate client-scope identity cohort(s) require review.`]
          : []),
        ...(ambiguousLegacy.length
          ? [`${ambiguousLegacy.length} legacy cohort(s) cannot be safely classified by type/scope alone.`]
          : []),
      ],
    };
    process.stdout.write(`${JSON.stringify(report, jsonReplacer, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      diagnostic: 'memory-governance-v2',
      mode: 'read-only',
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    }),
  );
  process.exitCode = 1;
});
