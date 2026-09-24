/**
 * Package 0 defense-budget inventory snapshot.
 *
 * The command starts an interactive Prisma transaction and marks it READ ONLY
 * before issuing inventory queries. Missing pre-release tables are reported as
 * unavailable instead of failing the whole snapshot.
 */
import { PrismaClient } from '@prisma/client';

export interface SnapshotQuerySpec {
  key: string;
  table: string;
  sql: string;
}

export const SNAPSHOT_QUERY_SPECS: readonly SnapshotQuerySpec[] = [
  {
    key: 'migrations',
    table: '_prisma_migrations',
    sql: `SELECT migration_name, finished_at, rolled_back_at
          FROM _prisma_migrations
          WHERE migration_name ~ 'defense|budget|phase8|governed'
          ORDER BY started_at`,
  },
  {
    key: 'cycles',
    table: 'defense_budget_cycle',
    sql: `SELECT fiscal_year, authority_track, status, COUNT(*)::int AS count
          FROM defense_budget_cycle GROUP BY 1,2,3 ORDER BY 1,2,3`,
  },
  {
    key: 'expectedSources',
    table: 'defense_budget_expected_source',
    sql: `SELECT fiscal_year, authority_track, source_family, expected_state,
                 COUNT(*)::int AS count
          FROM defense_budget_expected_source GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,
  },
  {
    key: 'observations',
    table: 'defense_budget_source_observation',
    sql: `SELECT observation_state, revision_kind, COUNT(*)::int AS count,
                 MAX(last_seen_at) AS latest_seen_at
          FROM defense_budget_source_observation GROUP BY 1,2 ORDER BY 1,2`,
  },
  {
    key: 'outbox',
    table: 'defense_budget_ingestion_outbox',
    sql: `SELECT state, job_kind, COUNT(*)::int AS count,
                 MIN(available_at) AS oldest_available_at,
                 MAX(updated_at) AS latest_updated_at
          FROM defense_budget_ingestion_outbox GROUP BY 1,2 ORDER BY 1,2`,
  },
  {
    key: 'candidates',
    table: 'budget_extraction_candidate_v1',
    sql: `SELECT COALESCE(family, '<null>') AS family, status,
                 COUNT(*)::int AS count, MAX(updated_at) AS latest_updated_at
          FROM budget_extraction_candidate_v1 GROUP BY 1,2 ORDER BY 1,2`,
  },
  {
    key: 'scopedReviews',
    table: 'budget_scoped_fact_review_v1',
    sql: `SELECT scope_kind, status, decision, COUNT(*)::int AS count,
                 MAX(updated_at) AS latest_updated_at
          FROM budget_scoped_fact_review_v1 GROUP BY 1,2,3 ORDER BY 1,2,3`,
  },
  {
    key: 'corrections',
    table: 'budget_candidate_correction_v1',
    sql: `SELECT COUNT(*)::int AS count, MAX(created_at) AS latest_created_at
          FROM budget_candidate_correction_v1`,
  },
  {
    key: 'snapshots',
    table: 'defense_budget_canonical_snapshot',
    sql: `SELECT environment, fiscal_year, status, COUNT(*)::int AS count,
                 MAX(updated_at) AS latest_updated_at
          FROM defense_budget_canonical_snapshot GROUP BY 1,2,3 ORDER BY 1,2,3`,
  },
  {
    key: 'activeSnapshots',
    table: 'defense_budget_active_snapshot',
    sql: `SELECT a.environment, s.fiscal_year, s.status, s.snapshot_key, a.updated_at
          FROM defense_budget_active_snapshot a
          JOIN defense_budget_canonical_snapshot s ON s.id = a.snapshot_id
          ORDER BY a.environment`,
  },
  {
    key: 'canonicalRows',
    table: 'defense_budget_canonical_row',
    sql: `SELECT family, fiscal_year, COALESCE(stage, '<null>') AS stage,
                 COUNT(*)::int AS count
          FROM defense_budget_canonical_row GROUP BY 1,2,3 ORDER BY 1,2,3`,
  },
  {
    key: 'scheduleTicks',
    table: 'defense_budget_schedule_tick',
    sql: `SELECT outcome, committed, COUNT(*)::int AS count,
                 MAX(finished_at) AS latest_finished_at,
                 SUM(adapters_failed)::int AS adapters_failed
          FROM defense_budget_schedule_tick GROUP BY 1,2 ORDER BY 1,2`,
  },
  {
    key: 'providerInvocations30d',
    table: 'defense_provider_invocation',
    sql: `SELECT provider, outcome, COUNT(*)::int AS count,
                 SUM(attempts)::int AS attempts,
                 ROUND(AVG(latency_ms))::int AS avg_latency_ms
          FROM defense_provider_invocation
          WHERE started_at >= now() - interval '30 days'
          GROUP BY 1,2 ORDER BY 1,2`,
  },
  {
    key: 'governedManifests',
    table: 'governed_ingestion_manifest_v1',
    sql: `SELECT status, COUNT(*)::int AS count, MAX(updated_at) AS latest_updated_at
          FROM governed_ingestion_manifest_v1 GROUP BY 1 ORDER BY 1`,
  },
] as const;

type QueryClient = {
  $executeRawUnsafe(query: string): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

export function normalizeSnapshotValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeSnapshotValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeSnapshotValue(child)]),
    );
  }
  return value;
}

async function tableExists(client: QueryClient, table: string): Promise<boolean> {
  const rows = await client.$queryRawUnsafe<Array<{ relation: string | null }>>(
    'SELECT to_regclass($1)::text AS relation',
    `public.${table}`,
  );
  return rows[0]?.relation !== null && rows[0]?.relation !== undefined;
}

export async function collectPackage0Snapshot(client: QueryClient): Promise<Record<string, unknown>> {
  await client.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const tables: Record<string, unknown> = {};

  for (const [index, spec] of SNAPSHOT_QUERY_SPECS.entries()) {
    if (!(await tableExists(client, spec.table))) {
      tables[spec.key] = { unavailable: true, reason: 'relation_missing', table: spec.table };
      continue;
    }

    const savepoint = `package0_snapshot_${index}`;
    await client.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    try {
      const rows = await client.$queryRawUnsafe<unknown[]>(spec.sql);
      tables[spec.key] = normalizeSnapshotValue(rows);
      await client.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (cause) {
      await client.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      const error = cause as { code?: string; message?: string };
      tables[spec.key] = {
        unavailable: true,
        code: error.code ?? null,
        message: String(error.message ?? cause).replace(/\s+/g, ' ').slice(0, 240),
      };
    }
  }

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    environment: process.env.CAPIRO_ENVIRONMENT ?? process.env.NODE_ENV ?? 'unknown',
    gitSha: process.env.GIT_SHA ?? 'UNVERIFIED',
    transactionMode: 'READ ONLY',
    tables,
  };
}

async function main(): Promise<void> {
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--pretty');
  if (unknownArgs.length > 0) throw new Error(`Unknown arguments: ${unknownArgs.join(', ')}`);

  const prisma = new PrismaClient();
  try {
    const snapshot = await prisma.$transaction(
      async (transaction) => collectPackage0Snapshot(transaction as unknown as QueryClient),
      { timeout: 60_000 },
    );
    const spacing = process.argv.includes('--pretty') ? 2 : 0;
    process.stdout.write(`${JSON.stringify(snapshot, null, spacing)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
