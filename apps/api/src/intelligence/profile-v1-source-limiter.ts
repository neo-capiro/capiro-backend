/**
 * Profile-v1 source scheduling: a bounded, order-preserving settle over lazily
 * started sources, plus the share-once helper for reads that feed more than
 * one slot.
 *
 * How many profile-v1 sources run at once. Each source that opens a
 * `withTenant` transaction holds a pooled connection for its whole duration;
 * with every source started eagerly, one profile load could hold most of the
 * task's 10-connection request pool for several seconds and starve unrelated
 * requests (the 2026-10-31 authority-read outage). Four keeps the profile's
 * wall-clock close to the eager fan-out — the database, not the API, is the
 * bottleneck under load — while bounding its share of the pool.
 */
export const PROFILE_V1_SOURCE_CONCURRENCY = 4;

/** A source that is started only when the limiter has a free slot. */
export type ProfileV1SourceStart = () => Promise<unknown>;

/**
 * Start each thunk at most `limit` at a time, in index order, and settle them
 * all. Result positions match the input positions, so the positional
 * `settle(index, fallback)` readers below are unchanged.
 *
 * Once `signal` aborts, no further thunk starts: the ones already running
 * settle normally and every unstarted position is rejected with the abort
 * reason. The caller's budget has expired, so the database must not take on
 * reads whose answer nobody will use.
 */
export async function settleWithConcurrency(
  starts: ReadonlyArray<ProfileV1SourceStart>,
  limit: number,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<unknown>[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('concurrency limit must be a positive integer');
  const results: PromiseSettledResult<unknown>[] = new Array(starts.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < starts.length) {
      const index = next;
      next += 1;
      if (signal?.aborted) {
        results[index] = { status: 'rejected', reason: signal.reason };
        continue;
      }
      try {
        results[index] = { status: 'fulfilled', value: await starts[index]!() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, starts.length) }, worker));
  return results;
}

/** A promise created on first call and shared by every later caller. */
export function shared<T>(start: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= start());
}
