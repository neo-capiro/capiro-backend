import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { LegiscanSession } from '../external/legiscan/legiscan.client.js';
import { parseDatasetZip } from '../external/legiscan/legiscan-dataset.util.js';
import {
  computeSessionKey,
  normalizeLegiscanBill,
  upsertNormalizedStateBill,
  upsertStateSession,
  upsertStateRollCallVote,
} from './legiscan-normalize.js';
import { persistPublishedRecords } from './legiscan-published-records.js';
import {
  getSessionList,
  getDatasetList,
  getDataset,
} from '../external/legiscan/legiscan.client.js';
import { selectHistoricalSessions } from './legiscan-selected-sessions.js';
import { currentQuotaMonth, monthToDateQueries, LEGISCAN_HARD_CAP } from './legiscan-quota.util.js';

export async function pullHistoricalDatasets(
  prisma: PrismaClient,
  state: string,
  ids: number[],
  inventory: {
    state: string;
    sessions: LegiscanSession[];
    datasets: Array<{ session_id: number; dataset_hash: string }>;
  },
) {
  const key = process.env.LEGISCAN_API_KEY;
  if (!key || process.env.LEGISCAN_SELECTED_HISTORY_APPLY !== 'true')
    throw Error('SELECTED_HISTORY_NOT_CONFIGURED');
  if (inventory.state !== state || ids.length > 4)
    throw Error('REVIEWED_HISTORICAL_SCOPE_REQUIRED');
  const reviewed = selectHistoricalSessions(inventory.sessions, 'selected', ids);
  if (reviewed.some((s) => s.prior !== 1 || s.year_end >= new Date().getUTCFullYear()))
    throw Error('EXPLICIT_COMPLETED_PRIOR_SESSION_REQUIRED');
  const month = currentQuotaMonth(),
    cost = 8 + 4 * ids.length,
    cursorId = `${state}-${reviewed[0]!.session_id}`;
  // Dataset operations have up to four transport attempts. Reserve the entire
  // bounded run before the first request; failed runs retain that reservation.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('legiscan-research-quota',0))`;
    const used = monthToDateQueries(
      await tx.stateSyncCursor.findMany({ select: { queriesUsed: true, quotaMonth: true } }),
      month,
    );
    const budget = Math.min(
      LEGISCAN_HARD_CAP,
      Number(process.env.LEGISCAN_MONTHLY_BUDGET ?? 28000),
    );
    if (!Number.isFinite(budget) || used + cost > budget)
      throw Error('EXISTING_PROVIDER_BUDGET_HOLD');
    await tx.stateSyncCursor.upsert({
      where: { id: cursorId },
      create: {
        id: cursorId,
        state,
        sessionId: reviewed[0]!.session_id,
        sessionKey: computeSessionKey(reviewed[0]!),
        queriesUsed: 0,
        quotaMonth: month,
      },
      update: {},
    });
    await tx.$executeRaw`UPDATE state_sync_cursor SET queries_used=CASE WHEN quota_month=${month} THEN queries_used+${cost} ELSE ${cost} END,quota_month=${month} WHERE id=${cursorId}`;
  });
  const sessions = selectHistoricalSessions(await getSessionList(key, state), 'selected', ids),
    list = await getDatasetList(key, state),
    outcomes = [];
  for (const session of sessions) {
    const previous = reviewed.find((s) => s.session_id === session.session_id),
      listing = list.find((d) => d.session_id === session.session_id),
      approved = inventory.datasets.find((d) => d.session_id === session.session_id);
    if (
      !previous ||
      JSON.stringify([previous.year_start, previous.year_end, previous.special, previous.prior]) !==
        JSON.stringify([session.year_start, session.year_end, session.special, session.prior]) ||
      !listing ||
      !approved ||
      approved.dataset_hash !== listing.dataset_hash
    )
      throw Error('REVIEWED_SESSION_OR_DATASET_CHANGED');
    const dataset = await getDataset(key, session.session_id, listing.access_key);
    if (
      !dataset ||
      dataset.session_id !== session.session_id ||
      dataset.dataset_hash !== listing.dataset_hash ||
      dataset.zip.length > 160_000_000
    )
      throw Error('DATASET_IDENTITY_OR_SIZE_UNQUALIFIED');
    outcomes.push(
      await applyHistoricalDataset(prisma, state, session, Buffer.from(dataset.zip, 'base64')),
    );
  }
  return { reservedQueries: cost, outcomes };
}

/** Additive prior-session ingestion through canonical writers. Conflicting
 * retained bills are held, never refreshed behind an existing client watch.
 * Each new bill and all returned vote evidence commit together. */
export async function applyHistoricalDataset(
  prisma: PrismaClient,
  state: string,
  session: LegiscanSession,
  archive: Buffer,
) {
  if (
    !/^[A-Z]{2}$/.test(state) ||
    session.prior !== 1 ||
    session.year_end >= new Date().getUTCFullYear()
  )
    throw Error('EXPLICIT_COMPLETED_PRIOR_SESSION_REQUIRED');
  const parsed = await parseDatasetZip(archive),
    sessionKey = computeSessionKey(session);
  if (
    !parsed.bills.length ||
    parsed.bills.length > 20000 ||
    Object.values(parsed.skipped).some(Boolean)
  )
    throw Error('HISTORICAL_DATASET_INCOMPLETE');
  const normalized = parsed.bills.map((raw) => ({ raw, bill: normalizeLegiscanBill(raw, state) }));
  if (
    normalized.some(
      ({ raw, bill }) =>
        !bill ||
        raw.state !== state ||
        raw.session.session_id !== session.session_id ||
        bill.sessionKey !== sessionKey,
    ) ||
    new Set(normalized.map((x) => x.bill!.billKey)).size !== normalized.length
  )
    throw Error('HISTORICAL_DATASET_IDENTITY_MISMATCH');
  const voteIds = new Set(parsed.votes.map((v) => v.roll_call_id));
  if (
    voteIds.size !== parsed.votes.length ||
    parsed.votes.some((v) => !normalized.some((x) => x.raw.bill_id === v.bill_id)) ||
    normalized.some(
      (x) => !Array.isArray(x.raw.votes) || x.raw.votes.some((v) => !voteIds.has(v.roll_call_id)),
    )
  )
    throw Error('HISTORICAL_DATASET_VOTE_COVERAGE_INCOMPLETE');
  const archiveHash = createHash('sha256').update(archive).digest('hex');
  await prisma.$executeRaw`INSERT INTO legal_dataset_archive(content_hash,original_bytes_base64) VALUES(${archiveHash},${archive.toString('base64')}) ON CONFLICT DO NOTHING`;
  await upsertStateSession(prisma, state, session);
  const outcomes: Array<{ billId: string; status: string; reason?: string }> = [];
  for (const { raw, bill } of normalized) {
    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${bill!.billKey},0))`;
        const existing = await tx.stateBill.findUnique({
          where: { id: bill!.billKey },
          select: { legiscanBillId: true, legiscanChangeHash: true },
        });
        if (existing)
          return {
            billId: bill!.billKey,
            status:
              existing.legiscanBillId === raw.bill_id &&
              existing.legiscanChangeHash === raw.change_hash
                ? 'retained'
                : 'held',
            reason: 'EXISTING_CANONICAL_STATE_PRESERVED',
          };
        // Existing writers accept PrismaClient; flatten their inner transactions
        // onto this per-bill transaction so a failed child rolls back the bill.
        const writer = new Proxy(tx, {
          get(target, key) {
            return key === '$transaction'
              ? (fn: (t: typeof tx) => unknown) => fn(tx)
              : Reflect.get(target, key);
          },
        }) as unknown as PrismaClient;
        await upsertNormalizedStateBill(writer, bill!, { historical: true });
        await persistPublishedRecords(writer, bill!.billKey, raw, { historical: true });
        for (const vote of parsed.votes.filter((v) => v.bill_id === raw.bill_id))
          await upsertStateRollCallVote(writer, state, bill!.billKey, vote, {
            historical: true,
            stub: raw.votes!.find((v) => v.roll_call_id === vote.roll_call_id),
            providerBillId: raw.bill_id,
            providerBillHash: raw.change_hash,
          });
        await tx.stateBill.update({
          where: { id: bill!.billKey },
          data: {
            sourceCheckStatus: 'success',
            sourceCheckedAt: new Date(),
            sourceCheckAttemptedAt: new Date(),
          },
        });
        return { billId: bill!.billKey, status: 'imported' };
      },
      { timeout: 60000 },
    );
    outcomes.push(outcome);
  }
  const receipt = {
    state,
    sessionId: session.session_id,
    sessionKey,
    archiveHash,
    providerBills: parsed.bills.length,
    providerVotes: parsed.votes.length,
    providerPeople: parsed.people.length,
    outcomes,
    peoplePolicy: 'retained_in_original_archive; current_directory_unchanged',
    calendarEvents: 0,
    sourceTransitions: 0,
    clientAssignments: 0,
    delivery: 0,
    documentBytes: 'selective_hydration_required',
    complete: outcomes.every((o) => o.status !== 'held'),
  };
  const id = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  await prisma.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES(${id},'legiscan-selected-history',${JSON.stringify({ jurisdiction: state, sessionKey, providerSessionId: session.session_id })}::jsonb,${JSON.stringify(receipt)}::jsonb,${receipt.complete}) ON CONFLICT DO NOTHING`;
  return receipt;
}
