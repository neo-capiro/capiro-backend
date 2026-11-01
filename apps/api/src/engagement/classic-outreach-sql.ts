import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { compileScopedSql, type CompiledPublicSql } from '../meri/analytics/sql-query-compiler.js';
import { CLASSIC_OUTREACH_QUERY_RELATION } from './classic-outreach-query-projection.js';
import { retainedReadSnapshot } from '../meri/retained-read-context.js';
import { PUBLIC_SQL_LIMITS } from '../meri/analytics/public-sql-registry.js';
import { withClassicOutreachEligibleIds, type ClassicOutreachScope,
  type ClassicOutreachObservationControl } from './classic-outreach-authority.js';

/** The caller supplies only its dedicated read-only executor and buffers its
 * result. Domain transactions stay with the canonical ordinary authority owner.
 * No database role, raw table query, source selection or send is created here. */
export async function queryClassicOutreachSql<T>(
  prisma: Pick<PrismaService, 'withTenant'>, ctx: TenantContext, scope: ClassicOutreachScope,
  control: ClassicOutreachObservationControl, input: unknown,
  execute: (query: CompiledPublicSql, eligibleIds: readonly string[]) => Promise<T>,
): Promise<T> {
  // Snapshot and validate model input before any asynchronous authorization. The
  // empty relation is used only to validate; execution always recompiles with the
  // complete canonical ID observation inside its pre/post boundary.
  const captured = retainedReadSnapshot(input, 52_000), assertActive = control.assertActive;
  compileScopedSql(captured, [CLASSIC_OUTREACH_QUERY_RELATION], { classic_outreach_records: [] });
  return withClassicOutreachEligibleIds(prisma, ctx, scope, control, async ids => {
    assertActive();
    const compiled = compileScopedSql(captured, [CLASSIC_OUTREACH_QUERY_RELATION], { classic_outreach_records: ids });
    // Pass the exact authority set separately for transaction-local DB binding.
    // Neither the executor nor its caller needs to recover IDs from model SQL.
    const result = await execute(compiled, ids);
    assertActive();
    // The executor normalizes and packs rows before returning. Copy only bounded
    // inert JSON before the canonical postcheck; a lazy iterator, accessor or
    // retained mutable buffer must never defer publication past that check.
    return retainedReadSnapshot(result, PUBLIC_SQL_LIMITS.maxOutputBytes);
  });
}
