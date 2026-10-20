import {
  governedRecallEligibilitySql,
  governedRecallSuppressionSql,
  TERMINAL_GOVERNED_STATUSES,
} from '@capiro/meriv2-core';
import type { Prisma } from '@prisma/client';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';

/**
 * The memory_items suppression predicate and the terminal vocabulary are defined
 * ONCE, in packages/meriv2-core/src/memory/governance.ts, because
 * apps/meriv2-orchestrator reads memory_items directly too and a second copy of a
 * security predicate is a drift waiting to happen. Re-exported here so apps/api
 * call sites keep a single local import.
 */
export { governedRecallEligibilitySql, governedRecallSuppressionSql, TERMINAL_GOVERNED_STATUSES };

/** Reads the process switch once, so call sites stay one-liners. */
export function governedRecallSuppressionEnabled(): boolean {
  return governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE);
}

/**
 * The lifecycle migration has not been applied everywhere. Probe the columns
 * inside the caller's read transaction rather than assuming the process switch
 * describes the database. A failed probe is an error, never permission to read.
 */
export async function governedRecallColumnsAvailableInTx(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ ready: boolean }>>`
    SELECT COUNT(*) = 5 AS ready
    FROM pg_catalog.pg_attribute
    WHERE attrelid = to_regclass('memory_items')
      AND attname = ANY(ARRAY[
        'governed_status', 'conflict_status', 'controlling_item_id',
        'effective_from', 'valid_until'
      ]::text[])
      AND attnum > 0 AND NOT attisdropped
  `;
  return rows.length === 1 && rows[0]?.ready === true;
}

/**
 * Content readers also run while lifecycle enforcement is dark. Legacy files
 * remain available, but a Clio projection or a row bearing governed state
 * cannot bypass approval, terminal state, conflict, or effective dates. When
 * the migration is absent, Clio projections are withheld; the SQL emitted in
 * that case references only pre-migration columns.
 */
export function currentMemoryReadSql(columnsAvailable: boolean, alias = ''): string {
  // The shared predicate validates SQL identifiers, even in the legacy branch.
  const governed = governedRecallEligibilitySql(alias);
  const prefix = alias ? `${alias}.` : '';
  const legacy = `${prefix}status = 'active'
    AND (${prefix}expires_at IS NULL OR ${prefix}expires_at > now())`;
  if (!columnsAvailable) {
    return `AND ${legacy} AND ${prefix}slug NOT LIKE 'clio:%'`;
  }
  return `AND ${legacy} AND (
    (${prefix}governed_status IS NULL
      AND ${prefix}slug NOT LIKE 'clio:%'
      AND (${prefix}effective_from IS NULL OR ${prefix}effective_from <= now())
      AND (${prefix}valid_until IS NULL OR ${prefix}valid_until > now())
      AND ${prefix}controlling_item_id IS NULL
      AND COALESCE(${prefix}conflict_status, 'none') NOT IN ('open', 'controlling'))
    OR ${governed}
  )`;
}

export async function currentMemoryReadSqlInTx(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  alias = '',
): Promise<string> {
  return currentMemoryReadSql(await governedRecallColumnsAvailableInTx(tx), alias);
}
