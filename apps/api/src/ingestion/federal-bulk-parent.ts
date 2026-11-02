import type { PrismaClient } from '@prisma/client';
import { replaceCongressBillActionsAtomically } from './congress-actions.js';
import { federalDate, type FederalBulkBill } from './federal-billstatus.js';

/** Refresh-only projection of a fully inspected official archive. Never regress a newer parent. */
export async function persistFederalBulkParent(db: PrismaClient, bill: FederalBulkBill) {
  const parent = bill.parent,
    updated = federalDate(bill.metadataUpdatedAt),
    textUpdated = federalDate(bill.providerUpdatedAt);
  if (
    !bill.eligible ||
    !parent?.title ||
    !updated ||
    !textUpdated ||
    !bill.sourceContentHash ||
    parent.actions.some((a) => !federalDate(a.date) || !a.text) ||
    (parent.sponsorBioguideId && !/^[A-Z][0-9]{6}$/.test(parent.sponsorBioguideId))
  )
    throw Error('FEDERAL_REFRESH_PARENT_INCOMPLETE');
  const current = await db.congressBill.findUnique({
    where: { id: bill.id },
    select: { updateDate: true, updateDateIncludingText: true },
  });
  if (
    (current?.updateDate && current.updateDate > updated) ||
    (current?.updateDateIncludingText && current.updateDateIncludingText > textUpdated)
  )
    return {
      status: 'held' as const,
      providerUpdatedAt: current.updateDateIncludingText?.toISOString() ?? bill.providerUpdatedAt,
    };
  const previous = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM legal_source_receipt WHERE source='fy26-federal-metadata' AND complete
     AND scope->>'billId'=$1 AND manifest->>'sourceContentHash'=$2 LIMIT 1`,
    bill.id,
    bill.sourceContentHash,
  );
  if (
    previous.length &&
    current?.updateDate?.getTime() === updated.getTime() &&
    current.updateDateIncludingText?.getTime() === textUpdated.getTime()
  )
    return {
      status: 'reused' as const,
      providerUpdatedAt: bill.providerUpdatedAt,
      reusedReceiptId: previous[0]!.id,
    };
  const [congress, billType, billNumber] = bill.id.split('-');
  const data = {
    title: parent.title,
    introducedDate: federalDate(parent.introducedDate),
    originChamber: parent.originChamber,
    policyArea: parent.policyArea,
    sponsorName: parent.sponsorName,
    sponsorState: parent.sponsorState,
    sponsorParty: parent.sponsorParty,
    sponsorBioguideId: parent.sponsorBioguideId,
    latestActionText: parent.latestActionText,
    latestActionDate: federalDate(parent.latestActionDate),
    updateDate: updated,
    updateDateIncludingText: textUpdated,
  };
  await db.congressBill.upsert({
    where: { id: bill.id },
    select: { id: true },
    create: {
      id: bill.id,
      congress: Number(congress),
      billType: billType!,
      billNumber: billNumber!,
      ...data,
    },
    update: data,
  });
  await replaceCongressBillActionsAtomically(
    db,
    bill.id,
    parent.actions.map((a) => ({
      date: federalDate(a.date)!,
      text: a.text!,
      type: a.type,
      chamber: a.chamber,
    })),
  );
  return { status: 'written' as const, providerUpdatedAt: bill.providerUpdatedAt };
}
