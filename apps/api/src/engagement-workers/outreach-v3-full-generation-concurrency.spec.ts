import { runWithConcurrency } from './outreach-v3-full-generation-worker.service.js';

/**
 * Coverage for the batch concurrency pool added 2026-08-24.
 *
 * The worker previously drafted a claimed batch with `for (const item of batch)
 * await processItem(...)` — strictly one provider call in flight. Measured live
 * on gpt-5 at effort=max, a single draft took 94-683s (mean ~395s), so a
 * 51-recipient campaign projected to ~5.6 hours of wall clock.
 *
 * These tests pin the three properties that matter: work actually overlaps, the
 * overlap is BOUNDED (a runaway pool would multiply provider spend and trip rate
 * limits), and one failing item cannot reject the pool or strand its siblings.
 */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('runWithConcurrency', () => {
  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    expect(peak).toBe(4);
  });

  it('actually overlaps work — the whole point of the change', async () => {
    // Three items, limit 3, each blocking until released. If the pool were
    // serial, only the first would ever start and this would time out.
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const run = runWithConcurrency([0, 1, 2], 3, async (i) => {
      started.push(i);
      await gates[i]!.promise;
    });

    await new Promise((r) => setImmediate(r));
    expect(started.sort()).toEqual([0, 1, 2]); // all three in flight at once

    gates.forEach((g) => g.resolve());
    await run;
  });

  it('honours limit=1 as strictly serial (the old behaviour)', async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3, 4], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  it('does not spawn more lanes than there are items', async () => {
    let peak = 0;
    let inFlight = 0;
    await runWithConcurrency([1, 2], 16, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    expect(peak).toBe(2);
  });

  it('keeps going when one item throws, and still completes the rest', async () => {
    // Failure isolation: the worker marks per-item failure inside the task, so a
    // throw must not reject the pool or abandon queued siblings.
    const done: number[] = [];
    await expect(
      runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        done.push(n);
      }),
    ).resolves.toBeUndefined();
    expect(done.sort((a, b) => a - b)).toEqual([1, 3, 4, 5]);
  });

  it('survives every item throwing', async () => {
    await expect(
      runWithConcurrency([1, 2, 3], 2, async () => {
        throw new Error('all bad');
      }),
    ).resolves.toBeUndefined();
  });

  it('handles an empty batch without spawning a lane', async () => {
    const task = jest.fn();
    await runWithConcurrency([], 4, task);
    expect(task).not.toHaveBeenCalled();
  });

  it('treats a limit below 1 as 1 rather than deadlocking', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2], 0, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([1, 2]);
  });

  it('drains a batch larger than the limit', async () => {
    // 25 is the max batchSize the job schema allows; concurrency must not change
    // how many items ultimately get processed.
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen: number[] = [];
    await runWithConcurrency(items, 4, async (n) => {
      seen.push(n);
    });
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });
});
