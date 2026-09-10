/**
 * F08 — classification of a failed strategy detail load (2026-09-10 plan §6).
 *
 * The backend distinguishes strategy states by HTTP status:
 *   - 410 Gone        soft-archived (deleted) strategy; body carries
 *                     { strategyId, title } and the retention message
 *                     (strategy.service.ts archive()/byId()).
 *   - 404 Not Found   unknown id for this tenant — NOT proof of deletion.
 *   - 403 Forbidden   feature/tenant guard denial.
 *   - 401             expired Clerk session — owned by the app's auth
 *                     recovery, not a property of the strategy.
 * Everything else (5xx, network, timeout) is transient.
 *
 * One classifier feeds both surfaces so they cannot drift apart:
 *   - the editor renders the state (distinct copy + exits, no retry loop on
 *     terminal statuses);
 *   - `useStrategy` disables react-query's automatic retry for terminal
 *     statuses (a deleted strategy must not re-fire its doomed GET on every
 *     window refocus) while keeping the app's bounded default retry
 *     (`retry: 1`, main.tsx) for transient failures.
 */
export type StrategyLoadState =
  | 'archived'
  | 'missing'
  | 'forbidden'
  | 'unauthenticated'
  | 'transient';

/** Terminal statuses map to a distinct state; anything else is transient. */
const TERMINAL_STATUS: Record<number, StrategyLoadState> = {
  410: 'archived',
  404: 'missing',
  403: 'forbidden',
  401: 'unauthenticated',
};

export function classifyStrategyLoadError(error: unknown): StrategyLoadState {
  const status = (error as { response?: { status?: unknown } } | null | undefined)?.response
    ?.status;
  const mapped = typeof status === 'number' ? TERMINAL_STATUS[status] : undefined;
  return mapped ?? 'transient';
}

/**
 * react-query `retry` predicate for the strategy detail query: terminal
 * statuses never retry automatically; transient failures keep the app's
 * existing single automatic retry (main.tsx `retry: 1`).
 */
export function strategyDetailRetry(failureCount: number, error: unknown): boolean {
  if (classifyStrategyLoadError(error) !== 'transient') return false;
  return failureCount < 1;
}
