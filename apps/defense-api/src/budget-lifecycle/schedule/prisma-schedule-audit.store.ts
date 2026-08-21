/**
 * Phase 8 Session 10 — Prisma-backed schedule audit store.
 *
 * Parameterised raw SQL, for the same reason as the Session 7 and 8 stores:
 * `defense_budget_schedule_tick` is deliberately absent from the curated
 * `defense-api` HTTP Prisma subset, because nothing in the HTTP surface reads
 * it — this is job/CLI-side control-plane work, not a product cutover.
 *
 * `$queryRawUnsafe` does not know column types, so every uuid/timestamp/int/
 * boolean placeholder is cast explicitly — the Session 6/7/8 lesson repeated
 * here rather than relearned.
 *
 * No statement here deletes. The tick history is append-only by grant and by
 * construction.
 */

import { Injectable } from '@nestjs/common';

import type {
  AdapterScheduleSnapshot,
  NewScheduleTick,
  ScheduleAuditStore,
} from './schedule-audit.port.js';

/** Minimal surface actually used, so this store needs no generated client. */
export interface RawSqlExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface RawAdapterScheduleRow {
  adapter_id: string;
  next_check_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
}

@Injectable()
export class PrismaScheduleAuditStore implements ScheduleAuditStore {
  constructor(private readonly sql: RawSqlExecutor) {}

  async loadAdapterScheduleStates(
    adapterIds: readonly string[],
  ): Promise<ReadonlyMap<string, AdapterScheduleSnapshot>> {
    if (adapterIds.length === 0) return new Map();

    const rows = await this.sql.$queryRawUnsafe<RawAdapterScheduleRow[]>(
      `SELECT adapter_id, next_check_at, lease_owner, lease_expires_at
         FROM defense_budget_watcher_adapter
        WHERE adapter_id = ANY($1::text[])`,
      adapterIds,
    );

    const snapshots = new Map<string, AdapterScheduleSnapshot>();
    for (const row of rows) {
      snapshots.set(row.adapter_id, {
        adapterId: row.adapter_id,
        nextCheckAt: row.next_check_at ? new Date(row.next_check_at).toISOString() : null,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
      });
    }
    return snapshots;
  }

  async recordScheduleTick(tick: NewScheduleTick): Promise<void> {
    await this.sql.$executeRawUnsafe(
      `INSERT INTO defense_budget_schedule_tick (
         worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
         adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
         adapters_skipped_lease, committed, failure_reason
       ) VALUES (
         $1, $2, $3::timestamptz, $4::timestamptz, $5, $6::boolean,
         $7::int, $8::int, $9::int, $10::int,
         $11::int, $12::boolean, $13
       )
       ON CONFLICT (worker_id, tick_key) DO UPDATE SET
         finished_at = EXCLUDED.finished_at,
         outcome = EXCLUDED.outcome,
         horizon_bootstrapped = EXCLUDED.horizon_bootstrapped,
         adapters_considered = EXCLUDED.adapters_considered,
         adapters_due = EXCLUDED.adapters_due,
         adapters_succeeded = EXCLUDED.adapters_succeeded,
         adapters_failed = EXCLUDED.adapters_failed,
         adapters_skipped_lease = EXCLUDED.adapters_skipped_lease,
         committed = EXCLUDED.committed,
         failure_reason = EXCLUDED.failure_reason,
         updated_at = CURRENT_TIMESTAMP`,
      tick.workerId,
      tick.tickKey,
      tick.startedAt,
      tick.finishedAt,
      tick.outcome,
      tick.horizonBootstrapped,
      tick.adaptersConsidered,
      tick.adaptersDue,
      tick.adaptersSucceeded,
      tick.adaptersFailed,
      tick.adaptersSkippedLease,
      tick.committed,
      tick.failureReason,
    );
  }
}
