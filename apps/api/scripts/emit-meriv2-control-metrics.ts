#!/usr/bin/env tsx
/**
 * Emit bounded-cardinality governed-memory control gauges to CloudWatch EMF.
 *
 * Read-only and cross-tenant by design. The scheduled ECS task uses the runtime
 * application role and sets the same transaction-local system GUC as other
 * trusted operators. No ids, titles, memory bodies, prompts, policy material,
 * source excerpts, or error messages are emitted.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  emitMeriV2ControlMetrics,
  type MeriV2ControlMetricValues,
} from '@capiro/meriv2-core';

interface AgeRow {
  age_seconds: number | null;
}

interface CountRow {
  count: bigint | number;
}

interface OutboxRow {
  oldest_age_seconds: number | null;
  retrying_count: bigint | number;
  dead_letter_count: bigint | number;
}

interface BackfillRow {
  quarantine_count: bigint | number;
  drift_count: bigint | number;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const snapshot = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

      const pending = await tx.$queryRaw<AgeRow[]>(Prisma.sql`
        SELECT COALESCE(
          EXTRACT(EPOCH FROM (now() - MIN(created_at))),
          0
        )::double precision AS age_seconds
        FROM memory_candidate
        WHERE status = 'pending'
      `);

      const conflicts = await tx.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT count(*)::bigint AS count
        FROM memory_items
        WHERE governed_status = 'conflicted' OR conflict_status = 'open'
      `);

      const outbox = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
        SELECT
          COALESCE(
            EXTRACT(EPOCH FROM (
              now() - MIN(created_at) FILTER (
                WHERE status IN ('pending','failed','running')
              )
            )),
            0
          )::double precision AS oldest_age_seconds,
          count(*) FILTER (
            WHERE status IN ('failed','running') AND attempts > 0
          )::bigint AS retrying_count,
          count(*) FILTER (WHERE status = 'dead_letter')::bigint AS dead_letter_count
        FROM memory_cleanup_outbox
      `);

      const backfill = await tx.$queryRaw<BackfillRow[]>(Prisma.sql`
        SELECT
          count(*) FILTER (
            WHERE r.quarantined = true
              AND j.status IN ('prepared','executed','execute_blocked_drift','rollback_partial')
          )::bigint AS quarantine_count,
          count(*) FILTER (
            WHERE r.apply_status = 'blocked_drift'
               OR r.rollback_status = 'skipped_drift'
          )::bigint AS drift_count
        FROM memory_governance_backfill_row r
        JOIN memory_governance_backfill_job j
          ON j.id = r.job_id AND j.tenant_id = r.tenant_id
      `);

      return {
        PendingCandidateOldestAgeSeconds: nonnegative(pending[0]?.age_seconds),
        ConflictedMemoryCount: count(conflicts[0]?.count),
        OutboxOldestAgeSeconds: nonnegative(outbox[0]?.oldest_age_seconds),
        OutboxRetryingCount: count(outbox[0]?.retrying_count),
        OutboxDeadLetterCount: count(outbox[0]?.dead_letter_count),
        BackfillQuarantineCount: count(backfill[0]?.quarantine_count),
        BackfillDriftCount: count(backfill[0]?.drift_count),
      } satisfies MeriV2ControlMetricValues;
    });

    const envelope = emitMeriV2ControlMetrics(snapshot, { force: true });
    if (!envelope) throw new Error('control_metric_emission_failed');
    console.log(
      JSON.stringify({
        event: 'meriv2.control.snapshot',
        metricCount: Object.keys(snapshot).length,
        recordedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    emitMeriV2ControlMetrics({ ControlMonitorFailures: 1 }, { force: true });
    console.error(
      JSON.stringify({
        event: 'meriv2.control.monitor_failed',
        errorCode: boundedErrorCode(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

function count(value: bigint | number | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return nonnegative(value);
}

function nonnegative(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function boundedErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'ControlMonitorError';
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 80) || 'control_error';
}

void main();
