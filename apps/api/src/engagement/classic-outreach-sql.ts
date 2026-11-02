import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  gateSqlStatement,
  SQL_QUERY_LIMITS,
  type GatedSqlStatement,
} from '../meri/analytics/sql-statement-gate.js';
import { retainedReadSnapshot } from '../meri/retained-read-context.js';
import {
  withClassicOutreachEligibleIds,
  type ClassicOutreachScope,
  type ClassicOutreachObservationControl,
} from './classic-outreach-authority.js';

/** The caller supplies only its dedicated read-only executor and buffers its
 * result. Domain transactions stay with the canonical ordinary authority owner.
 * No database role, raw table query, source selection or send is created here. */
export async function queryClassicOutreachSql<T>(
  prisma: Pick<PrismaService, 'withTenant'>,
  ctx: TenantContext,
  scope: ClassicOutreachScope,
  control: ClassicOutreachObservationControl,
  input: unknown,
  execute: (query: GatedSqlStatement, eligibleIds: readonly string[]) => Promise<T>,
): Promise<T> {
  // Snapshot and validate model input before any asynchronous authorization. The
  // same text gate validates once; the exact canonical IDs are bound by the
  // dedicated reader before it executes the statement or any aggregate.
  const captured = retainedReadSnapshot(input, 52_000),
    assertActive = control.assertActive;
  const gated = gateSqlStatement(captured, 'classic_outreach');
  return withClassicOutreachEligibleIds(prisma, ctx, scope, control, async (ids) => {
    assertActive();

    // Pass the exact authority set separately for transaction-local DB binding.
    // Neither the executor nor its caller needs to recover IDs from model SQL.
    const result = await execute(gated, ids);
    assertActive();
    // The executor normalizes and packs rows before returning. Copy only bounded
    // inert JSON before the canonical postcheck; a lazy iterator, accessor or
    // retained mutable buffer must never defer publication past that check.
    return retainedReadSnapshot(result, SQL_QUERY_LIMITS.maxOutputBytes);
  });
}
