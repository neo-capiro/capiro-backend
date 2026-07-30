/**
 * Pure helpers for the embed-backfill autonomous-incremental watermark.
 *
 * Extracted so the watermark logic is unit-testable without booting the
 * standalone tsx script (which parses argv + connects to Postgres/Bedrock at
 * module load). Phase 0 will fold the SyncRun read/write into the shared
 * `runWithSyncRun` helper; until then this isolates the one piece with real
 * logic risk: turning a SyncRun `startedAt` into the `--since` window.
 */

/** SyncRun source name for an embedding sub-source (e.g. 'embed:lda'). */
export function embedSyncSource(kind: string): string {
  return `embed:${kind}`;
}

/**
 * Resolve the effective `--since` (YYYY-MM-DD) for an incremental embed run.
 * Explicit flag always wins; otherwise fall back to the last successful run's
 * start time; otherwise undefined (full backfill).
 */
export function resolveSinceWindow(
  explicitSince: string | undefined,
  lastSuccessfulStartedAt: Date | null,
): string | undefined {
  if (explicitSince) return explicitSince;
  if (lastSuccessfulStartedAt) {
    return lastSuccessfulStartedAt.toISOString().slice(0, 10);
  }
  return undefined;
}

export interface RunCounts {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  /**
   * False when the source window was not exhausted. A partial run may still
   * have written every row it actually received, but it must never advance the
   * incremental watermark because an unseen tail remains retryable.
   * (`lastSuccessfulWatermark` only reads status='success'.)
   */
  complete?: boolean;
  /** Bounded operator-facing reason persisted on a partial SyncRun. */
  incompleteReason?: string;
  /**
   * Why `errors > 0`, for the `sync_run` row. Optional and additive: a job that
   * doesn't set it behaves exactly as before.
   *
   * Until this existed, `error_message` was written ONLY when a job threw all
   * the way out — a job that caught per-row failures and returned `errors: N`
   * landed as `success_with_errors` with a null message, i.e. the dashboard's
   * single source of truth said "something failed" and nothing else. That is
   * how `geocode-facilities` failed the same row on nine consecutive nights
   * (2026-07-21 .. 2026-07-30) without anyone being able to see the cause
   * without reading raw task logs.
   */
  errorMessage?: string | null;
}

export type CompletedSyncRunStatus = 'success' | 'success_with_errors' | 'partial';

/** Final SyncRun status from completeness first, then the run's error count. */
export function statusFromCounts(counts: RunCounts): CompletedSyncRunStatus {
  if (counts.complete === false) return 'partial';
  return counts.errors > 0 ? 'success_with_errors' : 'success';
}
