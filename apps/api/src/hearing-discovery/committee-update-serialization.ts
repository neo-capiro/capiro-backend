import { Prisma } from '@prisma/client';

/**
 * Serializes a committee update stream with follow initialization.
 *
 * A follow boundary and every producer of `committee_site_update` rows take
 * the same transaction-scoped advisory lock. If a producer wins, follow
 * initialization waits and sees its committed row as history. If the follow
 * wins, the producer waits and receives a post-boundary database timestamp.
 *
 * Acquire multiple streams in normalized sort order to avoid lock-order
 * deadlocks when one reconciliation projects more than one committee.
 */
export async function lockCommitteeUpdateStreams(
  tx: Prisma.TransactionClient,
  committeeSystemCodes: readonly string[],
): Promise<void> {
  const keys = [
    ...new Set(
      committeeSystemCodes
        .map((code) => code.trim().toLowerCase())
        .filter(Boolean)
        .map((code) => `legiwatch:committee-update:${code}`),
    ),
  ].sort();

  for (const key of keys) {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

/** Use the database clock after the stream lock has been acquired. */
export async function committeeUpdateStatementTime(
  tx: Prisma.TransactionClient,
): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ at: Date }>>`
    SELECT clock_timestamp() AS at`;
  if (!rows[0]?.at) throw new Error('Unable to establish committee update statement time');
  return rows[0].at;
}
