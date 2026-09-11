import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { LegiscanBill } from '../external/legiscan/legiscan.client.js';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const dateOnly = (s?: string) =>
  s &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s
    ? s
    : null;

/** A content-based fallback survives reordered provider arrays. Repeated identical
 * actions retain a duplicate ordinal. With no provider action ID, changed text is
 * a new attributable observation, not an asserted correction of an arbitrary row.
 * Amendment revisions share the durable provider ID and retain earlier versions.
 */
export function publishedRecords(raw: LegiscanBill) {
  const duplicates = new Map<string, number>();
  const actions = (raw.history ?? []).map((a, sourceOrder) => {
    const eventDate = dateOnly(a.date);
    const text = a.action.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const base = hash([eventDate, a.chamber ?? null, text]);
    const ordinal = (duplicates.get(base) ?? 0) + 1;
    duplicates.set(base, ordinal);
    const evidence = {
      text: a.action,
      date: eventDate,
      chamber: a.chamber ?? null,
      url: raw.state_link ?? raw.url ?? null,
      provenance: 'published_record',
      identityPolicy: 'normalized-content-and-duplicate-ordinal',
    };
    return {
      kind: 'action',
      sourceIdentity: `${base}:${ordinal}`,
      revisionHash: hash(evidence),
      eventDate,
      sourceOrder,
      evidence,
    };
  });
  const amendments = (raw.amendments ?? []).map((a, sourceOrder) => {
    const evidence = {
      text: a.title ?? a.description ?? 'Published amendment',
      date: dateOnly(a.date),
      chamber: a.chamber ?? null,
      url: a.state_link ?? a.url ?? null,
      providerId: a.amendment_id,
      adopted: a.adopted === 1,
      documentHash: a.amendment_hash ?? null,
      provenance: 'published_record',
      identityPolicy: 'provider-amendment-id',
    };
    return {
      kind: 'amendment',
      sourceIdentity: String(a.amendment_id),
      revisionHash: hash(evidence),
      eventDate: dateOnly(a.date),
      sourceOrder,
      evidence,
    };
  });
  return [...actions, ...amendments];
}

export function reportSourceFacts(raw: LegiscanBill) {
  return {
    policy: 'legiscan-published-records-v1',
    coverage: {
      actions: Array.isArray(raw.history),
      committees: Array.isArray(raw.referrals),
      relations: Array.isArray(raw.sasts),
      amendments: Array.isArray(raw.amendments),
    },
    committees: (raw.referrals ?? []).map((r) => ({
      id: String(r.committee_id ?? ''),
      name: r.name ?? r.committee_name ?? '',
      date: dateOnly(r.date),
      chamber: r.chamber ?? null,
      current: r.committee_id != null && r.committee_id === raw.committee?.committee_id,
    })),
    currentCommittee: raw.committee?.name
      ? {
          id: String(raw.committee.committee_id ?? ''),
          name: raw.committee.name,
          date: null,
          chamber: raw.committee.chamber ?? null,
          current: true,
        }
      : null,
    relations: (raw.sasts ?? []).map((r) => ({
      providerId: r.sast_bill_id ?? null,
      number: r.sast_bill_number ?? null,
      category: r.type,
      typeId: r.type_id,
    })),
  };
}

export async function persistPublishedRecords(
  prisma: PrismaClient,
  billKey: string,
  raw: LegiscanBill,
) {
  const records = publishedRecords(raw);
  // Both record history and coverage become visible together. No backdated
  // firstObservedAt: a late-published action belongs to the next observed window.
  await prisma.$transaction(async (tx) => {
    if (records.length)
      await tx.stateBillPublishedRecord.createMany({
        data: records.map((r) => ({ billKey, ...r })),
        skipDuplicates: true,
      });
    await tx.stateBill.update({
      where: { id: billKey },
      data: { reportSourceFacts: reportSourceFacts(raw) },
    });
  });
}
