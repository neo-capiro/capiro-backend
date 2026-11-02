import { withStateBillWriter } from './state-bill-writer.js';
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
  stateSessionId,
  upsertStateBillVersions,
} from './legiscan-normalize.js';
import { persistPublishedRecords } from './legiscan-published-records.js';
import {
  getSessionList,
  getDatasetList,
  getDataset,
} from '../external/legiscan/legiscan.client.js';
import { selectHistoricalSessions } from './legiscan-selected-sessions.js';
import { currentQuotaMonth, monthToDateQueries, LEGISCAN_HARD_CAP } from './legiscan-quota.util.js';
import { ALL_US_STATE_CODES } from '../external/legiscan/us-states.js';
import { admitsRawBill } from './bill-fy26-admission.js';
import { stateDocumentStubs } from './state-document-stub.js';
import { queueBillDocumentChecks } from './bill-document-queue.js';

export interface FrozenDatasetScope {
  state: string;
  sessionId: number;
  archiveHash: string;
  expectedBills: number;
}

/** Offline validation precedes any write. The exact frozen ZIP is the source;
 * current provider listings are neither queried nor substituted. */
export async function inspectFrozenStateDataset(archive: Buffer, scope: FrozenDatasetScope) {
  if (
    !(ALL_US_STATE_CODES as readonly string[]).includes(scope.state) ||
    !Number.isSafeInteger(scope.sessionId) ||
    scope.sessionId < 1 ||
    !Number.isSafeInteger(scope.expectedBills) ||
    scope.expectedBills < 1 ||
    scope.expectedBills > 50000 ||
    !/^[a-f\d]{64}$/.test(scope.archiveHash) ||
    createHash('sha256').update(archive).digest('hex') !== scope.archiveHash
  )
    throw Error('FROZEN_DATASET_SCOPE_OR_HASH_MISMATCH');
  const parsed = await parseDatasetZip(archive);
  if (parsed.bills.length !== scope.expectedBills || Object.values(parsed.skipped).some(Boolean))
    throw Error('FROZEN_DATASET_INCOMPLETE');
  const session = parsed.bills[0]!.session;
  if (
    !session ||
    !Number.isInteger(session.year_start) ||
    !Number.isInteger(session.year_end) ||
    session.year_start > 2026 ||
    session.year_end < 2025 ||
    ![0, 1].includes(session.special)
  )
    throw Error('FROZEN_DATASET_SESSION_INVALID');
  const sessionKey = computeSessionKey(session);
  const normalized = parsed.bills.map((raw) => ({
    raw,
    bill: normalizeLegiscanBill(raw, scope.state),
  }));
  if (
    normalized.some(
      ({ raw, bill }) =>
        !bill ||
        raw.state !== scope.state ||
        raw.session?.session_id !== scope.sessionId ||
        raw.session.year_start !== session.year_start ||
        raw.session.year_end !== session.year_end ||
        raw.session.special !== session.special ||
        bill.sessionKey !== sessionKey ||
        !Number.isSafeInteger(raw.bill_id) ||
        raw.bill_id < 1 ||
        !/^[a-f\d]{32}$/i.test(raw.change_hash) ||
        !Array.isArray(raw.texts) ||
        !Array.isArray(raw.amendments) ||
        !Array.isArray(raw.supplements) ||
        !Array.isArray(raw.votes),
    ) ||
    new Set(normalized.map((x) => x.bill!.billKey)).size !== normalized.length ||
    new Set(normalized.map((x) => x.raw.bill_id)).size !== normalized.length
  )
    throw Error('FROZEN_DATASET_IDENTITY_MISMATCH');
  const byProvider = new Map(normalized.map((x) => [x.raw.bill_id, x]));
  const votesByBill = new Map<number, typeof parsed.votes>();
  const voteIds = new Set(parsed.votes.map((v) => v.roll_call_id));
  const voteParents = new Map(parsed.votes.map((v) => [v.roll_call_id, v.bill_id]));
  if (
    voteIds.size !== parsed.votes.length ||
    parsed.votes.some((v) => !v.bill_id || !byProvider.has(v.bill_id)) ||
    normalized.some((x) =>
      x.raw.votes!.some((v) => voteParents.get(v.roll_call_id) !== x.raw.bill_id),
    )
  )
    throw Error('FROZEN_DATASET_VOTE_COVERAGE_INCOMPLETE');
  for (const vote of parsed.votes)
    votesByBill.set(vote.bill_id!, [...(votesByBill.get(vote.bill_id!) ?? []), vote]);
  const eligible = normalized
    .filter((x) => admitsRawBill(x.raw, 2026))
    .sort((a, b) => a.raw.bill_id - b.raw.bill_id);
  const manifest = {
    schemaVersion: 1,
    state: scope.state,
    sessionId: scope.sessionId,
    sessionKey,
    archiveHash: scope.archiveHash,
    sourceListComplete: true,
    inspectedBills: parsed.bills.length,
    eligibleBills: eligible.length,
    bills: eligible.map(({ raw, bill }) => ({
      providerBillId: raw.bill_id,
      providerChangeHash: raw.change_hash,
      billKey: bill!.billKey,
      sessionKey,
      documents: stateDocumentStubs(raw),
    })),
  };
  return { session, sessionKey, eligible, votesByBill, manifest };
}

/** Additive resumable FY26 bootstrap through the historical canonical writer.
 * Frozen inventory persists before parents. Current metadata is never replaced
 * by an older weekly archive, including when its provider hash differs. */
export async function importFrozenStateDataset(
  prisma: PrismaClient,
  archive: Buffer,
  scope: FrozenDatasetScope,
  options: { limit: number; inventoryOnly?: boolean },
) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)
    throw Error('FROZEN_DATASET_LIMIT_INVALID');
  const prepared = await inspectFrozenStateDataset(archive, scope);
  return withStateBillWriter(prisma, [scope.state], async (prisma) => {
    const { session, sessionKey, eligible, votesByBill, manifest } = prepared;
    const receiptScope = {
      jurisdiction: scope.state,
      providerSessionId: scope.sessionId,
      sessionKey,
      fiscalYear: 2026,
      archiveHash: scope.archiveHash,
    };
    const id = createHash('sha256')
      .update(JSON.stringify(['fy26-state-frozen-inventory', 1, receiptScope]))
      .digest('hex');
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO legal_dataset_archive(content_hash,original_bytes_base64) VALUES(${scope.archiveHash},${archive.toString('base64')}) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES(${id},'fy26-state-frozen-inventory',${JSON.stringify(receiptScope)}::jsonb,${JSON.stringify(manifest)}::jsonb,true) ON CONFLICT DO NOTHING`;
      const same = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM legal_source_receipt WHERE id=${id} AND source='fy26-state-frozen-inventory' AND scope=${JSON.stringify(receiptScope)}::jsonb AND manifest=${JSON.stringify(manifest)}::jsonb AND complete
        AND EXISTS(SELECT 1 FROM legal_dataset_archive WHERE content_hash=${scope.archiveHash} AND original_bytes_base64=${archive.toString('base64')})`;
      if (same.length !== 1) throw Error('FROZEN_INVENTORY_RECEIPT_CONFLICT');
    });
    if (options.inventoryOnly)
      return {
        receiptId: id,
        archiveHash: scope.archiveHash,
        inventoryBills: eligible.length,
        processed: 0,
        providerCalls: 0,
        metadataComplete: false,
      };
    const sessionRow = await prisma.stateSession.findUnique({
      where: { id: stateSessionId(scope.state, scope.sessionId) },
    });
    if (!sessionRow) await upsertStateSession(prisma, scope.state, session);
    else if (
      sessionRow.legiscanSessionId !== scope.sessionId ||
      sessionRow.sessionKey !== sessionKey ||
      sessionRow.state !== scope.state
    )
      throw Error('FROZEN_CANONICAL_SESSION_CONFLICT');
    const cursorId = `${scope.state}-${scope.sessionId}`;
    await prisma.stateSyncCursor.upsert({
      where: { id: cursorId },
      create: { id: cursorId, state: scope.state, sessionId: scope.sessionId, sessionKey },
      update: {},
    });
    const checkpoint = `fy26-state-archive:${scope.state}:${scope.sessionId}:${scope.archiveHash}`;
    const initial = { offset: 0, imported: 0, retained: 0, held: 0 };
    await prisma.$executeRaw`INSERT INTO federal_evidence_checkpoint(source,cursor_jsonb,status,completed_at) VALUES(${checkpoint},${JSON.stringify(initial)}::jsonb,${eligible.length ? 'running' : 'completed'},CASE WHEN ${eligible.length === 0} THEN clock_timestamp() ELSE NULL END) ON CONFLICT DO NOTHING`;
    const rows = await prisma.$queryRaw<
      Array<{ cursor: typeof initial }>
    >`SELECT cursor_jsonb AS cursor FROM federal_evidence_checkpoint WHERE source=${checkpoint}`;
    const progress = rows[0]?.cursor;
    if (
      !progress ||
      !Number.isInteger(progress.offset) ||
      progress.offset < 0 ||
      progress.offset > eligible.length ||
      ['imported', 'retained', 'held'].some(
        (k) =>
          !Number.isInteger(progress[k as keyof typeof initial]) ||
          progress[k as keyof typeof initial] < 0,
      ) ||
      progress.imported + progress.retained + progress.held !== progress.offset
    )
      throw Error('FROZEN_CHECKPOINT_INVALID');
    let processed = 0;
    while (progress.offset < eligible.length && processed < options.limit) {
      const { raw, bill } = eligible[progress.offset]!;
      const status = await prisma.$transaction(async (tx) => {
        const existing = await tx.stateBill.findUnique({
          where: { id: bill!.billKey },
          select: { legiscanBillId: true, legiscanChangeHash: true },
        });
        const status = !existing
          ? 'imported'
          : existing.legiscanBillId === raw.bill_id &&
              existing.legiscanChangeHash === raw.change_hash
            ? 'retained'
            : 'held';
        // The enclosing lease facade flattens nested canonical transactions.
        const writer = tx as unknown as PrismaClient;
        if (!existing) await upsertNormalizedStateBill(writer, bill!, { historical: true });
        if (!existing || existing.legiscanBillId === raw.bill_id) {
          if (existing) await upsertStateBillVersions(writer, bill!, { preserveExisting: true });
          await persistPublishedRecords(writer, bill!.billKey, raw, {
            historical: true,
            preserveCurrentFacts: Boolean(existing),
          });
          await queueBillDocumentChecks(writer, bill!.billKey, raw, { exactVersions: true });
          if (!existing) {
            for (const vote of votesByBill.get(raw.bill_id) ?? [])
              await upsertStateRollCallVote(writer, scope.state, bill!.billKey, vote, {
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
          }
          if (status !== 'held')
            await tx.$executeRaw`UPDATE state_sync_cursor SET bill_hashes=jsonb_build_object(${String(raw.bill_id)},${raw.change_hash}) || COALESCE(bill_hashes,'{}'::jsonb) WHERE id=${cursorId}`;
        }
        const next = { ...progress, offset: progress.offset + 1, [status]: progress[status] + 1 };
        const done = next.offset === eligible.length;
        await tx.$executeRaw`UPDATE federal_evidence_checkpoint SET cursor_jsonb=${JSON.stringify(next)}::jsonb,status=${done ? 'completed' : 'running'},completed_at=CASE WHEN ${done} THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE source=${checkpoint}`;
        return status;
      });
      progress.offset++;
      progress[status]++;
      processed++;
    }
    return {
      receiptId: id,
      archiveHash: scope.archiveHash,
      inventoryBills: eligible.length,
      processed,
      ...progress,
      providerCalls: 0,
      scanComplete: progress.offset === eligible.length,
      metadataComplete: progress.offset === eligible.length && progress.held === 0,
      documentBytes: 'pending_exact_version_hydration',
    };
  });
}

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
  return withStateBillWriter(prisma, [state], async (prisma) => {
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
        JSON.stringify([
          previous.year_start,
          previous.year_end,
          previous.special,
          previous.prior,
        ]) !==
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
  });
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
  return withStateBillWriter(prisma, [state], async (prisma) => {
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
    const normalized = parsed.bills.map((raw) => ({
      raw,
      bill: normalizeLegiscanBill(raw, state),
    }));
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
  });
}
