/** Serialized ingestion lease plus 750ms between attempts stays below 5,000 requests/hour. */
export function createCongressRequestPacer(
  options: { limit?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit < 1))
    throw Error('CONGRESS_REQUEST_LIMIT_INVALID');
  const now = options.now ?? Date.now,
    sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let count = 0,
    last: number | null = null,
    queue: Promise<void> = Promise.resolve();
  return {
    count: () => count,
    beforeAttempt: () => {
      const next = queue.then(async () => {
        if (count >= limit) throw Error('CONGRESS_REQUEST_CAP_REACHED');
        if (last !== null) {
          const wait = Math.max(0, 750 - (now() - last));
          if (wait) await sleep(wait);
        }
        last = now();
        count++;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
