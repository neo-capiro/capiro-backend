/**
 * Shared LegiScan monthly-quota governor (State Legislation Platform, 2026-07-10
 * hot-fix). Previously only sync-legiscan-bills.ts checked the aggregate
 * month-to-date spend, and only ONCE before its drain loop — masterlist and
 * backfill ran with NO budget awareness at all, meaning either could keep
 * spending LegiScan queries even after the shared monthly account budget was
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

/** The configured account was confirmed to enforce 10,000 requests/month.
 * Runtime overrides may tighten this ceiling, never silently increase it. */
const configuredHard = Number(process.env.LEGISCAN_HARD_CAP ?? '10000');
export const LEGISCAN_HARD_CAP =
  Number.isFinite(configuredHard) && configuredHard > 0 ? Math.min(10000, configuredHard) : 0;
export const LEGISCAN_SOFT_CAP = Math.min(9000, LEGISCAN_HARD_CAP);

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
