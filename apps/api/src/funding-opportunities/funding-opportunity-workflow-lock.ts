import type { Prisma } from '@prisma/client';
import {
  sourceRecordWhere,
  type StorableOpportunitySource,
} from './funding-opportunity-identity.js';

/** Serialize decisions on an existing client record, then read the committed state. */
export async function readFundingWorkflowForUpdate(
  tx: Prisma.TransactionClient,
  clientId: string,
  source: StorableOpportunitySource,
  sourceRecordId: string,
) {
  const where = { clientId, ...sourceRecordWhere(source, sourceRecordId) };
  const existing = await tx.clientFundingOpportunity.findFirst({ where });
  if (!existing) return null;
  // Called only inside withTenant; RLS supplies tenant scope and the explicit
  // client predicate keeps identity local. A concurrent first create is handled
  // by the existing unique constraint and whole-transaction retry.
  await tx.$queryRaw`SELECT id FROM client_funding_opportunity
    WHERE id = ${existing.id}::uuid AND client_id = ${clientId}::uuid FOR UPDATE`;
  return tx.clientFundingOpportunity.findFirst({ where });
}
