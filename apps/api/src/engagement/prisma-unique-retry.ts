/**
 * Recover one check-then-create race guarded by a database unique constraint.
 *
 * The first operation may lose to a concurrent request after both callers read
 * "no row yet". Retrying ONCE lets the normal lookup path observe the winner and
 * return its durable idempotent result. A second failure is never retried, and
 * non-unique errors are propagated immediately.
 */
export async function retryOnceAfterPrismaUnique<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error;
    return operation();
  }
}

export function isPrismaUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002',
  );
}
