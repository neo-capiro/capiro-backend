import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  DirectoryContactTripSummary,
  DirectoryContactTripsPayload,
} from './directory-detail.types.js';

/** Read the global LegiStorm travel rows for an already-normalized profile id. */
export async function readContactTrips(
  prisma: PrismaService,
  normalizedContactId: string,
): Promise<DirectoryContactTripsPayload> {
  const isStaff = normalizedContactId.startsWith('staff-');
  const numericId = Number(normalizedContactId.replace(/^(member|staff)-/, ''));
  if (!Number.isFinite(numericId)) {
    return { contactId: normalizedContactId, trips: [] };
  }

  const rows = await prisma.legistormTrip.findMany({
    where: isStaff
      ? { travelerStaffId: numericId }
      : { OR: [{ approverMemberId: numericId }, { travelerMemberId: numericId }] },
    orderBy: [{ startDate: 'desc' }, { filedDate: 'desc' }],
    take: 50,
  });

  const trips: DirectoryContactTripSummary[] = rows.map((t) => {
    // A member could theoretically be both approver and traveler on the
    // same trip (self-approved travel) - prefer the more specific
    // 'traveler' role in that case, never a false 'approver' label.
    const role: 'approver' | 'traveler' =
      !isStaff && t.approverMemberId === numericId && t.travelerMemberId !== numericId
        ? 'approver'
        : 'traveler';
    return {
      id: t.id,
      role,
      otherPartyName: role === 'approver' ? t.travelerName : t.approverName,
      companionName: t.companionName,
      startDate: t.startDate ? t.startDate.toISOString().slice(0, 10) : null,
      endDate: t.endDate ? t.endDate.toISOString().slice(0, 10) : null,
      durationDays: t.durationDays,
      purpose: t.purpose,
      totalCost: t.totalCost,
      destinations: Array.isArray(t.destinations)
        ? (t.destinations as Array<{ id: number; name: string | null; stateId: string | null }>)
        : [],
      sponsors: Array.isArray(t.sponsors)
        ? (t.sponsors as Array<{ id: number; name: string | null }>)
        : [],
      filedDate: t.filedDate ? t.filedDate.toISOString().slice(0, 10) : null,
    };
  });

  return { contactId: normalizedContactId, trips };
}
