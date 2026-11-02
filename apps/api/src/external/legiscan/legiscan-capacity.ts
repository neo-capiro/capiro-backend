import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export class LegiscanProviderCapacityError extends Error {
  constructor(
    readonly month: string,
    readonly requestAttempts = 0,
    readonly reportedUsed?: number,
    readonly reportedLimit?: number,
  ) {
    super('LEGISCAN_PROVIDER_MONTHLY_CAPACITY_HOLD');
  }
  get retryAfterMs() {
    const [year, month] = this.month.split('-').map(Number);
    return Math.max(1000, Date.UTC(year!, month!, 1) - Date.now());
  }
}
export interface LegiscanCapacityGuard {
  beforeAttempt(apiKey: string): Promise<void>;
  capacityExceeded(apiKey: string, error: LegiscanProviderCapacityError): Promise<void>;
}
const guards = new AsyncLocalStorage<LegiscanCapacityGuard>();
const blocked = new Set<string>();
export function capacityIdentity(apiKey: string, now = new Date()) {
  if (!apiKey) throw Error('LEGISCAN_PROVIDER_NOT_CONFIGURED');
  const month = now.toISOString().slice(0, 7);
  // Internal identifier only. Never include it or the key in logs/errors.
  return {
    month,
    source: `legiscan-capacity:${month}:${createHash('sha256').update(apiKey).digest('hex')}`,
  };
}
export function withLegiscanRequestGuard<T>(guard: LegiscanCapacityGuard, run: () => Promise<T>) {
  return guards.run(guard, run);
}
export async function assertLegiscanCapacityAllowed(apiKey: string, requestAttempts = 0) {
  const identity = capacityIdentity(apiKey);
  if (blocked.has(identity.source))
    throw new LegiscanProviderCapacityError(identity.month, requestAttempts);
  try {
    await guards.getStore()?.beforeAttempt(apiKey);
  } catch (error) {
    if (error instanceof LegiscanProviderCapacityError) {
      blocked.add(identity.source);
      throw new LegiscanProviderCapacityError(
        identity.month,
        requestAttempts,
        error.reportedUsed,
        error.reportedLimit,
      );
    }
    throw error;
  }
}
export async function observeLegiscanCapacityError(
  apiKey: string,
  message: string,
  requestAttempts: number,
) {
  // Match an authoritative monthly account exhaustion, not ordinary rate limits,
  // invalid keys, missing documents, or transient transport errors.
  if (
    !/exceeded maximum query count|(?:exceed|exhaust|reach|over).*(?:monthly|month|subscription|query limit|queries limit)|(?:monthly|month|subscription).*(?:exceed|exhaust|limit reached)/i.test(
      message,
    )
  )
    return;
  const identity = capacityIdentity(apiKey);
  const counts = message.match(/([\d,]+)\s+(?:of|\/)\s+([\d,]+)/i);
  const used = counts ? Number(counts[1]!.replace(/,/g, '')) : undefined;
  const limit = counts ? Number(counts[2]!.replace(/,/g, '')) : undefined;
  const error = new LegiscanProviderCapacityError(identity.month, requestAttempts, used, limit);
  blocked.add(identity.source);
  try {
    await guards.getStore()?.capacityExceeded(apiKey, error);
  } catch {
    // Keep the in-process hold even if durable storage fails, and fail closed.
    // Do not surface a database exception which may contain its private source.
    throw Error('LEGISCAN_CAPACITY_HOLD_PERSIST_FAILED');
  }
  throw error;
}
