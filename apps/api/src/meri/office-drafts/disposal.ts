import { GoneException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

const key = (tenantId: string, kind: string, id: string) => `${tenantId}:office-disposal:${kind}:${id}`;

/** Shared writer locks precede private draft locks. Erasure holds the exclusive
 * subject lock through its marker and byte retirement commit. A timeout at the
 * HTTP caller cannot let a late transaction cross that commit. */
export async function assertOfficeCustodyAvailable(tx: Prisma.TransactionClient,
  tenantId: string, conversationId: string, artifactId: string) {
  for (const [kind, id] of [['conversation', conversationId], ['artifact', artifactId]]) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key(tenantId, kind!, id!)},0))`;
  }
  const rows = await tx.$queryRaw<Array<{ disposed: boolean }>>`SELECT EXISTS(
    SELECT 1 FROM meri_office_disposed_subjects WHERE tenant_id=${tenantId}::uuid AND
      ((subject_kind='conversation' AND subject_id=${conversationId}::uuid) OR
       (subject_kind='artifact' AND subject_id=${artifactId}::uuid))) AS disposed`;
  if (rows[0]?.disposed !== false) throw new GoneException('OFFICE_DRAFT_CLOSED');
}

export async function disposeOfficeSubject(tx: Prisma.TransactionClient,
  tenantId: string, kind: string, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key(tenantId, kind, id)},0))`;
  await tx.$executeRaw`INSERT INTO meri_office_disposed_subjects(tenant_id,subject_kind,subject_id)
    VALUES (${tenantId}::uuid,${kind},${id}::uuid) ON CONFLICT DO NOTHING`;
}
