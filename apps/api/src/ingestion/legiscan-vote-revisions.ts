import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { observeStateRecord } from './published-record-observations.js';
import type {
  LegiscanBillVoteStub,
  LegiscanRollCall,
} from '../external/legiscan/legiscan.client.js';

export interface VoteObservation {
  stub?: LegiscanBillVoteStub;
  providerBillHash?: string;
  providerBillId?: number;
  observedAt?: Date;
}
function sourceLink(value?: string) {
  if (!value) return null;
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
export function voteRevision(rc: LegiscanRollCall, observation: VoteObservation = {}) {
  const members = [...(rc.votes ?? [])].sort((a, b) => a.people_id - b.people_id);
  const counts = [rc.yea, rc.nay, rc.nv, rc.absent];
  const tally = ['Yea', 'Nay', 'NV', 'Absent'].map(
    (v) => members.filter((m) => m.vote_text === v).length,
  );
  if (
    !Array.isArray(rc.votes) ||
    members.some((m) => !Number.isSafeInteger(m.people_id) || m.people_id <= 0) ||
    new Set(members.map((m) => m.people_id)).size !== members.length ||
    counts.some((n, i) => !Number.isSafeInteger(n) || n! < 0 || n !== tally[i]) ||
    tally.reduce((a, b) => a + b, 0) !== members.length ||
    (rc.total != null && rc.total !== members.length)
  )
    throw Error('LEGISCAN_VOTE_DETAIL_INCOMPLETE');
  if (observation.providerBillId != null && rc.bill_id !== observation.providerBillId)
    throw Error('LEGISCAN_VOTE_BILL_MISMATCH');
  if (observation.stub && observation.stub.roll_call_id !== rc.roll_call_id)
    throw Error('LEGISCAN_VOTE_ID_MISMATCH');
  const date =
    rc.date &&
    /^\d{4}-\d{2}-\d{2}$/.test(rc.date) &&
    Number.isFinite(Date.parse(rc.date)) &&
    new Date(rc.date).toISOString().slice(0, 10) === rc.date
      ? rc.date
      : null;
  const url = sourceLink(observation.stub?.state_link) ?? sourceLink(observation.stub?.url);
  const evidence = {
    provider: 'LegiScan',
    publisher:
      url && observation.stub?.state_link
        ? 'legislature (source link supplied by LegiScan)'
        : 'LegiScan normalized record',
    providerId: rc.roll_call_id,
    providerBillId: rc.bill_id ?? null,
    date,
    chamber: rc.chamber ?? null,
    motion: rc.desc ?? null,
    yeas: rc.yea!,
    nays: rc.nay!,
    nv: rc.nv!,
    absent: rc.absent!,
    passed: rc.passed === 1 ? true : rc.passed === 0 ? false : null,
    url,
    sourcePublicationTime: null,
    parserVersion: 'legiscan-roll-call-v2',
    coverage: 'complete_returned_roll_call',
    locator: { type: 'structured', path: '/roll_call' },
    members: members.map((m) => ({ providerPersonId: m.people_id, voteCast: m.vote_text })),
    raw: { ...rc, votes: members.map((m) => ({ ...m })) },
  };
  return {
    evidence,
    revisionHash: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
  };
}

/** Aggregate totals cannot establish unchanged member positions or motion. A
 * changed parent hash is a refresh signal only; identical vote content dedupes.
 * TTL applies when the existing owner queues the bill, never a second poller. */
export function voteNeedsRefresh(
  existing: {
    currentRevisionHash?: string | null;
    providerBillHash?: string | null;
    lastSyncedAt?: Date;
  } | null,
  billHash: string,
  now = new Date(),
  maxAgeMs = 7 * 24 * 60 * 60_000,
) {
  return (
    !existing?.currentRevisionHash ||
    existing.providerBillHash !== billHash ||
    !existing.lastSyncedAt ||
    now.getTime() - existing.lastSyncedAt.getTime() >= maxAgeMs
  );
}

export async function persistVoteRevision(
  prisma: PrismaClient,
  state: string,
  billKey: string | null,
  rc: LegiscanRollCall,
  observation: VoteObservation = {},
) {
  // Unmatched dataset votes cannot create an uncitable canonical projection.
  if (!billKey) throw Error('LEGISCAN_VOTE_BILL_UNRESOLVED');
  const id = `${state.toLowerCase()}-rc-${rc.roll_call_id}`;
  const { evidence, revisionHash } = voteRevision(rc, observation);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`;
    const bill = await tx.stateBill.findUnique({
      where: { id: billKey },
      select: { state: true, legiscanBillId: true },
    });
    if (
      !bill ||
      bill.state.toUpperCase() !== state.toUpperCase() ||
      (rc.bill_id != null && bill.legiscanBillId !== rc.bill_id)
    )
      throw Error('LEGISCAN_VOTE_BILL_MISMATCH');
    const previous = await tx.stateRollCallVote.findUnique({ where: { id } });
    if (previous?.billKey && previous.billKey !== billKey)
      throw Error('LEGISCAN_VOTE_BILL_MISMATCH');
    if (previous && !previous.currentRevisionHash) {
      const positions = await tx.stateMemberVote.findMany({
        where: { voteId: id },
        orderBy: { legiscanPeopleId: 'asc' },
      });
      const legacy = {
        provider: 'LegiScan',
        publisher: 'LegiScan normalized record',
        providerId: previous.legiscanRollCallId,
        providerBillId: bill.legiscanBillId,
        date: previous.date?.toISOString().slice(0, 10) ?? null,
        chamber: previous.chamber,
        motion: previous.motion,
        yeas: previous.yeas,
        nays: previous.nays,
        nv: previous.nv,
        absent: previous.absent,
        passed: previous.passed,
        url: previous.sourceUrl,
        parserVersion: 'legacy-current-vote-v1',
        coverage: 'legacy_projection',
        rawUnavailable: true,
        members: positions.map((m) => ({
          providerPersonId: m.legiscanPeopleId,
          voteCast: m.voteCast,
        })),
      };
      await tx.stateBillPublishedRecord.createMany({
        data: [
          {
            billKey,
            kind: 'vote',
            sourceIdentity: id,
            revisionHash: createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
            eventDate: legacy.date,
            sourceOrder: 0,
            evidence: legacy,
            firstObservedAt: previous.lastSyncedAt,
          },
        ],
        skipDuplicates: true,
      });
    }
    await tx.stateBillPublishedRecord.createMany({
      data: [
        {
          billKey,
          kind: 'vote',
          sourceIdentity: id,
          revisionHash,
          eventDate: evidence.date,
          sourceOrder: 0,
          evidence,
        },
      ],
      skipDuplicates: true,
    });
    const data = {
      billKey,
      legiscanRollCallId: rc.roll_call_id,
      chamber: evidence.chamber,
      date: evidence.date ? new Date(evidence.date) : null,
      motion: evidence.motion,
      yeas: evidence.yeas,
      nays: evidence.nays,
      nv: evidence.nv,
      absent: evidence.absent,
      passed: evidence.passed,
      sourceUrl: evidence.url,
      currentRevisionHash: revisionHash,
      providerBillHash: observation.providerBillHash ?? null,
      lastSyncedAt: observation.observedAt ?? new Date(),
    };
    await observeStateRecord(tx, billKey, 'vote', id, revisionHash);
    await tx.stateRollCallVote.upsert({ where: { id }, create: { id, ...data }, update: data });
    // Preserve canonical member-row IDs and directory crosswalks when positions change.
    for (const m of evidence.members)
      await tx.stateMemberVote.upsert({
        where: { voteId_legiscanPeopleId: { voteId: id, legiscanPeopleId: m.providerPersonId } },
        create: { voteId: id, legiscanPeopleId: m.providerPersonId, voteCast: m.voteCast },
        update: { voteCast: m.voteCast },
      });
    await tx.stateMemberVote.deleteMany({
      where: {
        voteId: id,
        legiscanPeopleId: { notIn: evidence.members.map((m) => m.providerPersonId) },
      },
    });
  });
}
