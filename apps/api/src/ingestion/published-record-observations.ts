import type { Prisma } from '@prisma/client';
/** Called in the same transaction as the canonical projection. Repeat polls
 * do not append; a return to an older immutable revision does append. */
export async function observeStateRecord(
  tx: Prisma.TransactionClient,
  billKey: string,
  kind: string,
  identity: string,
  revisionHash: string,
) {
  const key = `state:${billKey}:${kind}:${identity}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
  await tx.$executeRaw`INSERT INTO published_record_source_observation(source_key,state_record_id)
    SELECT ${key},r.id FROM state_bill_published_record r WHERE r.bill_key=${billKey} AND r.kind=${kind} AND r.source_identity=${identity} AND r.revision_hash=${revisionHash}
      AND r.id IS DISTINCT FROM (SELECT state_record_id FROM published_record_source_observation WHERE source_key=${key} ORDER BY id DESC LIMIT 1)`;
}
export async function observeOfficialRecord(
  tx: Prisma.TransactionClient,
  packageId: string,
  revisionId: string,
) {
  const key = `govinfo:${packageId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
  const changed =
    await tx.$executeRaw`INSERT INTO published_record_source_observation(source_key,official_revision_id)
    SELECT ${key},${revisionId}::uuid WHERE ${revisionId}::uuid IS DISTINCT FROM
      (SELECT official_revision_id FROM published_record_source_observation WHERE source_key=${key} ORDER BY id DESC LIMIT 1)`;
  return changed === 1;
}
