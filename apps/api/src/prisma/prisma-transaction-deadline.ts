import type { Prisma } from '@prisma/client';

/** Absolute epoch milliseconds from a trusted request clock, never client input. */
export type PrismaTransactionDeadline = { at: number; now?: () => number };
export type PrismaTransactionOptions = {
  /** Without deadline: existing transaction timeout. With deadline: also caps
   * the total allocation shared by acquisition and transaction execution. */
  timeoutMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  readOnly?: boolean;
  deadline?: PrismaTransactionDeadline;
};
type EngineOptions = { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel };
type TransactionRunner<T> = (
  work: (tx: Prisma.TransactionClient) => Promise<T>, options?: EngineOptions,
) => Promise<T>;

export class PrismaTransactionDeadlineError extends Error {
  readonly code = 'PRISMA_TRANSACTION_DEADLINE_EXCEEDED';
  constructor() { super('Prisma transaction deadline exceeded or insufficient admission budget'); }
}

/** Snapshot one clock origin for an entire operation, including retries. The
 * derived clock never renews elapsed time when consumed by a later transaction.
 * Neither the supplied object nor its properties are read again after capture.
 */
export function capturePrismaDeadline(deadline: PrismaTransactionDeadline) {
  if (!deadline || !Number.isSafeInteger(deadline.at) || deadline.at < 0
    || deadline.at > 8640000000000000 || (deadline.now !== undefined && typeof deadline.now !== 'function')) {
    throw new PrismaTransactionDeadlineError();
  }
  const deadlineAt = deadline.at;
  const now = deadline.now ?? Date.now;
  const start = now(), monotonicStart = performance.now();
  let observedElapsed = 0;
  const remaining = () => {
    const wall = now(), elapsed = performance.now() - monotonicStart;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(wall)
      || wall < start || wall > 8640000000000000 || !Number.isFinite(elapsed) || elapsed < 0) {
      throw new PrismaTransactionDeadlineError();
    }
    observedElapsed = Math.max(observedElapsed, wall - start, elapsed);
    const ms = Math.floor(deadlineAt - start - observedElapsed);
    if (ms < 1) throw new PrismaTransactionDeadlineError();
    return ms;
  };
  return {
    remaining,
    deadline: Object.freeze({ at: deadlineAt, now: () => deadlineAt - remaining() }),
  };
}

function deadlineBudget(options: PrismaTransactionOptions) {
  const absolute = capturePrismaDeadline(options.deadline!);
  let workStart: number | undefined;
  let transactionTimeout: number | undefined;
  const remaining = () => {
    const workRemaining = workStart === undefined ? Infinity : transactionTimeout! - (performance.now() - workStart);
    const ms = Math.floor(Math.min(absolute.remaining(), workRemaining));
    if (ms < 1) throw new PrismaTransactionDeadlineError();
    return ms;
  };
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new PrismaTransactionDeadlineError();
  }
  // Prisma cannot resize an interactive transaction's timeout after acquisition.
  // Reserve acquisition time instead: the two engine allowances must SUM to no
  // more than the admitted budget. This also covers the first setup statement,
  // before a transaction-local statement_timeout can take effect. Unused pool
  // reservation is intentionally not reclaimed; no private engine API or race.
  const available = Math.min(remaining(), options.timeoutMs ?? Infinity, 2147483647);
  if (available < 2) throw new PrismaTransactionDeadlineError();
  const maxWait = Math.min(2000, Math.floor(available / 2));
  transactionTimeout = available - maxWait;
  return {
    remaining,
    options: { maxWait, timeout: transactionTimeout,
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}) },
    acquired() { remaining(); workStart = performance.now(); },
    async configure(tx: Prisma.TransactionClient) {
      const ms = `${remaining()}ms`;
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${ms}, true), set_config('lock_timeout', ${ms}, true)`;
      remaining();
    },
  };
}

/** Own acquisition, setup and settlement together. Native cancellation and
 * rollback/commit/transport cleanup remain awaited, not a hard response-time
 * guarantee. Callback code must still await its work; SQL timeout settings do
 * not cancel arbitrary JavaScript, sockets or intentionally detached work.
 */
export async function runPrismaTransaction<T>(
  run: TransactionRunner<T>, initialize: (tx: Prisma.TransactionClient) => Promise<unknown>,
  work: (tx: Prisma.TransactionClient) => Promise<T>, options?: PrismaTransactionOptions,
): Promise<T> {
  const budget = options?.deadline === undefined ? undefined : deadlineBudget(options);
  const readOnly = options?.readOnly;
  // Preserve the no-deadline option contract exactly, including Prisma defaults.
  const engineOptions = budget?.options ?? (options?.timeoutMs || options?.isolationLevel
    ? { ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}) }
    : undefined);
  try {
    return await run(async tx => {
      budget?.acquired();
      // Characteristics must precede SELECT. The reserved engine timer bounds
      // this first statement and the timeout-settings statement that follows.
      if (readOnly) {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        budget?.remaining();
      }
      await budget?.configure(tx);
      await initialize(tx);
      budget?.remaining();
      const value = await work(tx);
      budget?.remaining();
      return value;
    }, engineOptions);
  } finally {
    // The transaction promise has settled cleanup before this final check.
    // A late commit/result is not presented as within-deadline success.
    budget?.remaining();
  }
}
