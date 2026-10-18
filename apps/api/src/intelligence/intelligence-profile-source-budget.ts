import type { Logger } from '@nestjs/common';

export type IntelligenceSourceBudgetPorts = {
  budgetMs(): number;
  slowMs(): number;
  logger(): Pick<Logger, 'warn'>;
};

/** One source deadline and slow warning, with current policy and logger reads. */
export function withIntelligenceSourceBudget<T>(
  ports: IntelligenceSourceBudgetPorts,
  label: string,
  clientId: string,
  work: Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`exceeded its ${ports.budgetMs()}ms budget (still running)`));
    }, ports.budgetMs());
    // Never hold the process open for a budget that no longer matters — the
    // api container and the jest run both exit on their own schedule.
    timer.unref?.();
  });

  // race() keeps a handler attached to `work`, so a rejection arriving after
  // the budget fired is still consumed and cannot surface as an
  // unhandledRejection.
  return Promise.race([work, budget]).finally(() => {
    if (timer) clearTimeout(timer);
    const elapsed = Date.now() - startedAt;
    if (elapsed >= ports.slowMs()) {
      ports.logger().warn(`profile-v1 source "${label}" took ${elapsed}ms for client ${clientId}`);
    }
  }) as Promise<T>;
}
