import type { PrismaClient } from '@prisma/client';
import {
  capacityIdentity,
  LegiscanProviderCapacityError,
  withLegiscanRequestGuard,
  assertLegiscanCapacityAllowed,
} from '../external/legiscan/legiscan-capacity.js';

type CapacityDb = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;
export async function recordLegiscanCapacityHold(
  db: CapacityDb,
  apiKey: string,
  observation: { month: string; reportedUsed?: number; reportedLimit?: number },
) {
  const identity = capacityIdentity(apiKey);
  if (observation.month !== identity.month) throw Error('CAPACITY_OBSERVATION_MONTH_MISMATCH');
  const cursor = { ...observation, exhausted: true, observedAt: new Date().toISOString() };
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO federal_evidence_checkpoint(source,cursor_jsonb,status,last_error,updated_at)
      VALUES($1,$2::jsonb,'failed','LEGISCAN_PROVIDER_MONTHLY_CAPACITY_HOLD',clock_timestamp())
      ON CONFLICT(source) DO UPDATE SET cursor_jsonb=EXCLUDED.cursor_jsonb,status='failed',
      last_error=EXCLUDED.last_error,updated_at=clock_timestamp()`,
      identity.source,
      JSON.stringify(cursor),
    );
  } catch {
    throw Error('LEGISCAN_CAPACITY_HOLD_PERSIST_FAILED');
  }
}
export async function releaseLegiscanCapacityHold(db: CapacityDb, apiKey: string) {
  const identity = capacityIdentity(apiKey);
  try {
    const changed = await db.$executeRawUnsafe(
      `UPDATE federal_evidence_checkpoint
      SET cursor_jsonb=cursor_jsonb || jsonb_build_object('exhausted',false,'operatorConfirmedAt',clock_timestamp()),
      status='idle',last_error=NULL,updated_at=clock_timestamp()
      WHERE source=$1 AND cursor_jsonb->>'exhausted'='true'`,
      identity.source,
    );
    if (changed !== 1) throw Error('CAPACITY_HOLD_NOT_FOUND');
  } catch {
    throw Error('LEGISCAN_CAPACITY_HOLD_RELEASE_FAILED');
  }
}
/** The existing checkpoint owns an authoritative month/key hold, independently
 * of local usage estimates. Every API attempt/retry rereads it; publishers do not. */
export function withLegiscanCapacityGuard<T>(
  db: CapacityDb,
  apiKey: string,
  run: () => Promise<T>,
) {
  return withLegiscanRequestGuard(
    {
      async beforeAttempt(key) {
        if (key !== apiKey) throw Error('LEGISCAN_CAPACITY_KEY_CHANGED_DURING_RUN');
        const identity = capacityIdentity(key);
        let rows: Array<{
          cursor: { exhausted?: boolean; reportedUsed?: number; reportedLimit?: number };
        }>;
        try {
          rows = await db.$queryRawUnsafe(
            `SELECT cursor_jsonb AS cursor FROM federal_evidence_checkpoint WHERE source=$1`,
            identity.source,
          );
        } catch {
          throw Error('LEGISCAN_CAPACITY_HOLD_READ_FAILED');
        }
        if (rows[0]?.cursor?.exhausted)
          throw new LegiscanProviderCapacityError(
            identity.month,
            0,
            rows[0].cursor.reportedUsed,
            rows[0].cursor.reportedLimit,
          );
      },
      capacityExceeded: (key, error) => recordLegiscanCapacityHold(db, key, error),
    },
    run,
  );
}
export function withLegiscanApiAllowed<T>(db: CapacityDb, apiKey: string, run: () => Promise<T>) {
  return withLegiscanCapacityGuard(db, apiKey, async () => {
    await assertLegiscanCapacityAllowed(apiKey);
    return run();
  });
}
