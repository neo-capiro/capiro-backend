import { Prisma, type EngagementSource } from '@prisma/client';

/** Shared with artifact creation and intentional client reassignment. */
export async function lockMeetingAssociation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  meetingId: string,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM meetings
    WHERE id = ${meetingId}::uuid AND tenant_id = ${tenantId}::uuid
    FOR UPDATE
  `);
}

/** Sync's tenant lock does not serialize UI artifact writes; re-read under the parent lock. */
export async function readSyncedMeetingAssociation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  source: EngagementSource,
  externalId: string,
) {
  const query = {
    where: { tenantId_source_externalId: { tenantId, source, externalId } },
    select: {
      id: true,
      clientId: true,
      isInternal: true,
      associationScore: true,
      associationReason: true,
      associationSignals: true,
      status: true,
    },
  } as const;
  const initial = await tx.meeting.findUnique(query);
  if (!initial) return null;
  await lockMeetingAssociation(tx, tenantId, initial.id);
  return tx.meeting.findUnique(query);
}

/** An automatic guess must not rehome material already bound to the stored client.
 * Intentional reassignment owns child propagation, sharing and indexed evidence.
 * The caller holds the same parent row lock used by artifact writers.
 */
export async function hasBoundMeetingRecords(
  tx: Prisma.TransactionClient,
  tenantId: string,
  meetingId: string,
  currentClientId: string | null,
  proposedClientId: string | null,
): Promise<boolean> {
  if (currentClientId === proposedClientId) return false;
  const bound = await tx.meeting.findFirst({
    where: {
      id: meetingId,
      tenantId,
      OR: [
        { preps: { some: {} } },
        { notes: { some: {} } },
        { debriefs: { some: {} } },
        { attachments: { some: {} } },
        { tasks: { some: {} } },
        { botSessions: { some: {} } },
      ],
    },
    select: { id: true },
  });
  return bound !== null;
}
