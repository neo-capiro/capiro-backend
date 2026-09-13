import { createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { LegiscanBill } from '../external/legiscan/legiscan.client.js';
import {observeStateRecord} from './published-record-observations.js';

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
      adopted: a.adopted === 1 ? true : a.adopted === 0 ? false : null,
      rawAdopted: a.adopted ?? null,
      interpretationVersion: 'legiscan-amendment-v2',
      disposition:
        a.adopted === 1 ? 'marked_adopted' : a.adopted === 0 ? 'not_marked_adopted' : 'unknown',
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
      votes: Array.isArray(raw.votes),
      documentMetadata: Array.isArray(raw.texts),
      supplementMetadata: Array.isArray(raw.supplements),
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
    const data: Prisma.StateBillPublishedRecordCreateManyInput[] = [];
    for (const r of records) {
      if (r.kind !== 'amendment') {
        data.push({ billKey, ...r });
        continue;
      }
      const ev = r.evidence as Record<string, unknown>;
      const legacy = {
        text: ev.text,
        date: ev.date,
        chamber: ev.chamber,
        url: ev.url,
        providerId: ev.providerId,
        adopted: ev.adopted === true,
        documentHash: ev.documentHash,
        provenance: ev.provenance,
        identityPolicy: ev.identityPolicy,
      };
      const prior = await tx.stateBillPublishedRecord.findFirst({
        where: {
          billKey,
          kind: 'amendment',
          sourceIdentity: r.sourceIdentity,
          revisionHash: hash(legacy),
        },
        select: { id: true },
      });
      const evidence = prior
        ? { ...ev, changeKind: 'interpretation_revision', supersedesEvidenceId: prior.id }
        : ev;
      data.push({
        billKey,
        ...r,
        evidence: evidence as Prisma.InputJsonValue,
        revisionHash: hash(evidence),
      });
    }
    if (records.length)
      await tx.stateBillPublishedRecord.createMany({
        data,
        skipDuplicates: true,
      });
    for(const r of data)await observeStateRecord(tx,billKey,r.kind,r.sourceIdentity,r.revisionHash);
    await tx.stateBill.update({
      where: { id: billKey },
      data: { reportSourceFacts: reportSourceFacts(raw) },
    });
  });
}
