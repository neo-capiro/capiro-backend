import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';

/** Serialize plan writes before reading their inputs or taking node locks. */
export async function lockStrategyForMutation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  strategyId: string,
): Promise<void> {
  // Raw SQL is outside Prisma's tenant extension; tenant_id is mandatory here.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM sp_strategy
    WHERE id = ${strategyId}::uuid AND tenant_id = ${tenantId}::uuid
    FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('Strategy not found');
}
