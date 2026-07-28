import { describe, expect, jest, test } from '@jest/globals';
import { IntelligenceService } from './intelligence.service.js';

/**
 * profile-v1's 24-way `Promise.allSettled` fan-out has no cancellation, so a
 * source that never settles used to make the whole aggregate never settle. The
 * observed 2026-07-27 signature was exactly that: the handler never returned,
 * nothing was logged (the per-source failure log only fires on a REJECTED
 * source), and `api.endpoint_latency_ms` never fired either, because that
 * metric is emitted on response finish.
 *
 * `withSourceBudget` converts that silent hang into a named, logged rejection
 * that degrades one section. These pin the four behaviours that matter, with
 * the budget lowered so the suite does not wait 20 seconds.
 *
 * The helper is private; it is exercised through a prototype-backed instance
 * rather than the full constructor because the behaviour under test is pure
 * timing and involves none of the service's ~10 injected dependencies.
 */

interface BudgetHost {
  withSourceBudget<T>(label: string, clientId: string, work: Promise<T>): Promise<T>;
}

function host(): { subject: BudgetHost; warn: jest.Mock } {
  const warn = jest.fn();
  const subject = Object.create(IntelligenceService.prototype) as BudgetHost;
  Object.defineProperty(subject, 'logger', { value: { warn }, writable: true });
  return { subject, warn };
}

function withBudget<T>(budgetMs: number, slowMs: number, run: () => Promise<T>): Promise<T> {
  const cls = IntelligenceService as unknown as {
    PROFILE_V1_SOURCE_BUDGET_MS: number;
    PROFILE_V1_SLOW_SOURCE_MS: number;
  };
  const originalBudget = cls.PROFILE_V1_SOURCE_BUDGET_MS;
  const originalSlow = cls.PROFILE_V1_SLOW_SOURCE_MS;
  cls.PROFILE_V1_SOURCE_BUDGET_MS = budgetMs;
  cls.PROFILE_V1_SLOW_SOURCE_MS = slowMs;
  return run().finally(() => {
    cls.PROFILE_V1_SOURCE_BUDGET_MS = originalBudget;
    cls.PROFILE_V1_SLOW_SOURCE_MS = originalSlow;
  });
}

describe('profile-v1 per-source budget', () => {
  test('the production budget is finite and under a typical 30s client timeout', () => {
    // If this ever becomes Infinity or is removed, the hang returns.
    expect(IntelligenceService.PROFILE_V1_SOURCE_BUDGET_MS).toBeGreaterThan(0);
    expect(IntelligenceService.PROFILE_V1_SOURCE_BUDGET_MS).toBeLessThan(30_000);
  });

  test('a fast source passes its value through untouched', async () => {
    const { subject, warn } = host();
    await withBudget(1_000, 500, async () => {
      await expect(subject.withSourceBudget('mappingRows', 'client-1', Promise.resolve(42))).resolves.toBe(
        42,
      );
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('a source that never settles rejects with a budget error instead of hanging', async () => {
    const { subject } = host();
    await withBudget(25, 10_000, async () => {
      const neverSettles = new Promise<number>(() => {});
      await expect(
        subject.withSourceBudget('hearingAlerts', 'client-1', neverSettles),
      ).rejects.toThrow(/budget/i);
    });
  });

  test("a hung source degrades ONLY itself — allSettled still resolves for the others", async () => {
    // The actual requirement: one slow optional source must not take the page
    // down. Mirrors the shape of getClientProfileV1's fan-out.
    const { subject } = host();
    await withBudget(25, 10_000, async () => {
      const settled = await Promise.allSettled([
        subject.withSourceBudget('profile', 'client-1', Promise.resolve('spine')),
        subject.withSourceBudget('hearingAlerts', 'client-1', new Promise<string>(() => {})),
        subject.withSourceBudget('changes', 'client-1', Promise.resolve('ok')),
      ]);

      expect(settled[0]).toMatchObject({ status: 'fulfilled', value: 'spine' });
      expect(settled[1]!.status).toBe('rejected');
      expect(settled[2]).toMatchObject({ status: 'fulfilled', value: 'ok' });
    });
  });

  test('a genuine source rejection is passed through, not relabelled as a timeout', async () => {
    const { subject } = host();
    await withBudget(1_000, 10_000, async () => {
      await expect(
        subject.withSourceBudget('changes', 'client-1', Promise.reject(new Error('relation missing'))),
      ).rejects.toThrow('relation missing');
    });
  });

  test('a slow-but-successful source is named in a warning so the tail is diagnosable', async () => {
    const { subject, warn } = host();
    await withBudget(1_000, 0, async () => {
      await subject.withSourceBudget('trackedBills', 'client-9', Promise.resolve('done'));
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('trackedBills');
    expect(message).toContain('client-9');
  });

  test('a late rejection after the budget fired does not become an unhandled rejection', async () => {
    const { subject } = host();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await withBudget(20, 10_000, async () => {
        let rejectLate: ((error: Error) => void) | undefined;
        const late = new Promise<string>((_resolve, reject) => {
          rejectLate = reject;
        });
        await expect(subject.withSourceBudget('exStaffers', 'client-1', late)).rejects.toThrow(
          /budget/i,
        );
        rejectLate!(new Error('arrived after the budget'));
        // Let the microtask queue and one macrotask turn drain.
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
