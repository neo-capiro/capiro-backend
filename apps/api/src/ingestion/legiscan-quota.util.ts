/**
 * Shared LegiScan monthly-quota governor (State Legislation Platform, 2026-07-10
 * hot-fix). Previously only sync-legiscan-bills.ts checked the aggregate
 * month-to-date spend, and only ONCE before its drain loop — masterlist and
 * backfill ran with NO budget awareness at all, meaning either could keep
 * spending LegiScan queries even after the shared 30k/mo free-tier budget was
 * already exhausted. All three scripts now consult this ONE shared decision
 * (R5 — no triplicated `currentQuotaMonth`/budget-check logic) before running.
 *
 * Deliberately pure / DB-agnostic: callers pass in the cursor rows they've
 * already fetched (each script already queries state_sync_cursor for its own
 * purposes) so this stays unit-testable with no Prisma dependency.
 */

export interface QuotaCursorRow {
  queriesUsed: number;
  quotaMonth: string | null;
}

/**
 * LegiScan's actual enforced free-tier ceiling. sync-legiscan-bills.ts's
 * LEGISCAN_MONTHLY_BUDGET (default 28000) is a CONSERVATIVE soft budget that
 * leaves headroom specifically so backfill-legiscan-datasets and
 * sync-legiscan-masterlist — both cheap (1-3 queries/state) and explicitly
 * the fallback path when the drain's soft budget trips (see
 * backfill-legiscan-datasets.ts's header) — can keep running past it.
 * Gating those two scripts on the SAME soft budget the drain uses would
 * disable the fallback exactly when it's needed; they gate on this true
 * hard cap instead.
 */
export const LEGISCAN_HARD_CAP = Number(process.env.LEGISCAN_HARD_CAP ?? '30000');

/** `YYYY-MM` for the given (or current) instant — the quotaMonth column's format. */
export function currentQuotaMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Sum of queriesUsed across every cursor row whose quotaMonth matches `month`. */
export function monthToDateQueries(cursors: QuotaCursorRow[], month: string): number {
  return cursors.filter((c) => c.quotaMonth === month).reduce((sum, c) => sum + c.queriesUsed, 0);
}

/** True once month-to-date usage has reached/exceeded the budget — callers should skip the run (INGESTION_SKIP, exit 0). */
export function quotaExhausted(usedThisMonth: number, budget: number): boolean {
  return usedThisMonth >= budget;
}
