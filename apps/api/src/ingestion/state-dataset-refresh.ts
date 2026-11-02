import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ALL_US_STATE_CODES } from '../external/legiscan/us-states.js';
import {
  getSessionList,
  getDatasetList,
  getDataset,
  type LegiscanSession,
} from '../external/legiscan/legiscan.client.js';
import { withStateBillWriter } from './state-bill-writer.js';
import { reservedLegiscanQuery } from './legiscan-query-reservation.js';
import { withLegiscanApiAllowed } from './legiscan-provider-capacity.js';
import { importFrozenStateDataset } from './legiscan-historical-research.js';
import { retainStateDiscovery } from './state-discovery-inventory.js';
import { loadPinnedStateInventory } from './state-bill-inventory-read.js';

const SOURCE = 'fy26-state-dataset-refresh';
const WEEK_MS = 7 * 24 * 3600_000;
type SessionWork = {
  session: LegiscanSession;
  archiveHash?: string;
  archiveBytes?: number;
  bills?: number;
  providerDatasetHash?: string;
  done?: boolean;
};
export type StateDatasetCycle = {
  schemaVersion: 1;
  startedAt: string;
  sourceCommit: string;
  states: Array<{ state: string; sessions: SessionWork[] | null; complete: boolean }>;
};
export function newStateDatasetCycle(sourceCommit: string, now = new Date()): StateDatasetCycle {
  if (!/^[a-f\d]{40}$/.test(sourceCommit)) throw Error('DATASET_REFRESH_SOURCE_SHA_REQUIRED');
  return {
    schemaVersion: 1,
    startedAt: now.toISOString(),
    sourceCommit,
    states: ALL_US_STATE_CODES.map((state) => ({ state, sessions: null, complete: false })),
  };
}
export function nextStateDatasetSlice(cycle: StateDatasetCycle) {
  if (
    cycle.schemaVersion !== 1 ||
    cycle.states.length !== 51 ||
    new Set(cycle.states.map((s) => s.state)).size !== 51 ||
    cycle.states.some((s) => !(ALL_US_STATE_CODES as readonly string[]).includes(s.state))
  )
    throw Error('DATASET_REFRESH_CURSOR_INVALID');
  return cycle.states.find((state) => !state.complete) ?? null;
}
export function refreshedDiscoveryBytes(cycle: StateDatasetCycle) {
  if (nextStateDatasetSlice(cycle)) throw Error('DATASET_REFRESH_CYCLE_INCOMPLETE');
  return Buffer.from(
    JSON.stringify({
      sourceCommit: cycle.sourceCommit,
      updatedAt: cycle.startedAt,
      completeStates: 51,
      scope:
        'Parent history/progress event in [2025-10-01,2026-10-01); all listed versions retained',
      states: cycle.states.map((state) => ({
        state: state.state,
        status: 'complete',
        sessions: (state.sessions ?? []).map((row) => {
          if (!row.done || !row.archiveHash || !row.bills || !row.archiveBytes)
            throw Error('DATASET_REFRESH_SESSION_INCOMPLETE');
          return {
            id: row.session.session_id,
            name: row.session.session_name,
            archiveSha256: row.archiveHash,
            archiveBytes: row.archiveBytes,
            bills: row.bills,
          };
        }),
      })),
    }),
  );
}

/** One hourly opportunity, at most one state/session and 1,000 parent writes.
 * The cycle claim only coordinates its cursor; actual metadata/queue writes use
 * the same per-state fence as ordinary sync. Prior global discovery remains
 * authoritative until every refreshed session archive is qualified. */
export async function refreshStateDatasetSlice(
  prisma: PrismaClient,
  apiKey: string,
  sourceCommit: string,
) {
  const started = Date.now(),
    deadline = started + 10 * 60_000,
    token = randomUUID();
  const existing = await prisma.$queryRawUnsafe<
    Array<{ cursor: StateDatasetCycle | null; status: string }>
  >(
    'SELECT cursor_jsonb AS cursor,status FROM federal_evidence_checkpoint WHERE source=$1',
    SOURCE,
  );
  if (!existing[0]?.cursor || existing[0].status === 'completed') {
    const pinned = await loadPinnedStateInventory(prisma);
    if (
      !pinned.discovery ||
      pinned.inventories.length !== 51 ||
      pinned.inventories.some((row) => !row.known)
    )
      return {
        status: 'held',
        reason: 'QUALIFIED_GLOBAL_DISCOVERY_REQUIRED',
        processed: 0,
        providerCalls: 0,
      };
    const latest = await prisma.$queryRawUnsafe<Array<{ observedAt: Date }>>(
      'SELECT observed_at AS "observedAt" FROM legal_source_receipt WHERE id=$1',
      pinned.discovery.receiptId,
    );
    if (!latest[0] || started - latest[0].observedAt.getTime() < WEEK_MS)
      return { status: 'not_due', processed: 0, providerCalls: 0 };
  }
  // Refuse missing source identity before any new provider operation.
  newStateDatasetCycle(sourceCommit);
  const claim = await prisma.$queryRawUnsafe<
    Array<{ cursor: StateDatasetCycle | null; status: string }>
  >(
    `INSERT INTO federal_evidence_checkpoint(source,status,lease_token,lease_until) VALUES($1,'running',$2::uuid,clock_timestamp()+interval '15 minutes')
     ON CONFLICT(source) DO UPDATE SET lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until
     WHERE federal_evidence_checkpoint.lease_until IS NULL OR federal_evidence_checkpoint.lease_until<clock_timestamp()
     RETURNING cursor_jsonb AS cursor,status`,
    SOURCE,
    token,
  );
  if (claim.length !== 1)
    return {
      status: 'held',
      reason: 'DATASET_REFRESH_ALREADY_RUNNING',
      processed: 0,
      providerCalls: 0,
    };
  const cycle =
    claim[0]!.cursor && claim[0]!.status !== 'completed'
      ? claim[0]!.cursor!
      : newStateDatasetCycle(sourceCommit);
  let providerCalls = 0;
  const save = async (complete = false, error: string | null = null) => {
    const changed = await prisma.$executeRawUnsafe(
      `UPDATE federal_evidence_checkpoint SET cursor_jsonb=$3::jsonb,status=$4,last_error=$5,
      completed_at=CASE WHEN $4='completed' THEN clock_timestamp() ELSE completed_at END,updated_at=clock_timestamp()
      WHERE source=$1 AND lease_token=$2::uuid AND lease_until>clock_timestamp()`,
      SOURCE,
      token,
      JSON.stringify(cycle),
      complete ? 'completed' : 'running',
      error,
    );
    if (changed !== 1) throw Error('DATASET_REFRESH_CYCLE_LEASE_LOST');
  };
  try {
    const work = nextStateDatasetSlice(cycle);
    if (!work) {
      const bytes = refreshedDiscoveryBytes(cycle),
        hash = createHash('sha256').update(bytes).digest('hex');
      const receipt = await retainStateDiscovery(prisma, bytes, hash);
      await save(true);
      return {
        status: 'completed',
        processed: 0,
        providerCalls,
        manifestSha256: hash,
        receiptId: receipt.receiptId,
      };
    }
    const result = await withStateBillWriter(prisma, [work.state], async (writer) => {
      const quotaCursor = await writer.stateSyncCursor.findFirst({
        where: { state: work.state },
        orderBy: { sessionId: 'desc' },
        select: { id: true },
      });
      if (!quotaCursor) throw Error('EXISTING_PROVIDER_CURSOR_REQUIRED');
      async function query<T>(
        operation: string,
        providerId: number | undefined,
        call: (
          retry: () => void,
          transport: { maxAttempts: number; timeoutMs: number },
        ) => Promise<T>,
      ) {
        if (Date.now() + 60000 >= deadline) throw Error('DATASET_SLICE_DEADLINE');
        let attempted = 0;
        try {
          const response = await withLegiscanApiAllowed(writer, apiKey, () =>
            reservedLegiscanQuery(
              writer,
              { state: work!.state, cursorId: quotaCursor!.id, operation, providerId },
              async (retry) => {
                attempted = 1;
                return call(
                  () => {
                    retry();
                    attempted++;
                  },
                  { maxAttempts: 1, timeoutMs: 60000 },
                );
              },
            ),
          );
          return response.value;
        } finally {
          providerCalls += attempted;
        }
      }
      if (work.sessions === null) {
        const sessions = await query('getSessionList', undefined, (retry, transport) =>
          getSessionList(apiKey, work.state, transport, retry, true),
        );
        const selected = sessions.filter((s) => s.year_start <= 2026 && s.year_end >= 2025);
        const prior = await loadPinnedStateInventory(writer, work.state);
        const expected =
          prior.discovery?.states.find((s) => s.state === work.state)?.sessions ?? [];
        if (
          !prior.discovery ||
          expected.some((old) => !selected.some((current) => current.session_id === old.sessionId))
        )
          throw Error('DATASET_REFRESH_KNOWN_SESSION_DISAPPEARED');
        if (
          selected.length > 20 ||
          new Set(selected.map((s) => s.session_id)).size !== selected.length ||
          selected.some(
            (s) =>
              !Number.isSafeInteger(s.session_id) ||
              s.session_id < 1 ||
              !Number.isInteger(s.year_start) ||
              !Number.isInteger(s.year_end),
          )
        )
          throw Error('DATASET_REFRESH_SESSION_LIST_INVALID');
        work.sessions = selected
          .sort((a, b) => a.session_id - b.session_id)
          .map((session) => ({ session }));
        work.complete = work.sessions.length === 0;
        await save();
        return { status: 'pending', phase: 'state_discovery', state: work.state, processed: 0 };
      }
      const session = work.sessions.find((row) => !row.done);
      if (!session) {
        work.complete = true;
        await save();
        return { status: 'pending', phase: 'state_completed', state: work.state, processed: 0 };
      }
      if (!session.archiveHash) {
        const listings = await query('getDatasetList', undefined, (retry, transport) =>
          getDatasetList(apiKey, work.state, retry, transport),
        );
        const listing = listings.find((row) => row.session_id === session.session.session_id);
        if (!listing || !/^[a-f\d]{32}$/i.test(listing.dataset_hash) || !listing.access_key)
          throw Error('DATASET_REFRESH_LISTING_REQUIRED');
        const dataset = await query('getDataset', session.session.session_id, (retry, transport) =>
          getDataset(apiKey, listing.session_id, listing.access_key, retry, transport),
        );
        if (
          !dataset ||
          dataset.session_id !== listing.session_id ||
          dataset.dataset_hash !== listing.dataset_hash ||
          typeof dataset.zip !== 'string' ||
          dataset.zip.length > 160000000
        )
          throw Error('DATASET_REFRESH_ARCHIVE_IDENTITY');
        const archive = Buffer.from(dataset.zip, 'base64');
        if (archive.length > 120000000) throw Error('DATASET_COMPRESSED_SIZE_LIMIT');
        // Count directory members without inflating every bill twice. The
        // canonical parser then proves every entry/identity/count and byte cap.
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(archive);
        const bills = Object.values(zip.files).filter(
          (row) =>
            !row.dir && row.name.endsWith('.json') && row.name.toLowerCase().includes('/bill/'),
        ).length;
        const archiveHash = createHash('sha256').update(archive).digest('hex');
        await importFrozenStateDataset(
          writer,
          archive,
          { state: work.state, sessionId: listing.session_id, archiveHash, expectedBills: bills },
          { limit: 1, inventoryOnly: true, deadline },
        );
        Object.assign(session, {
          archiveHash,
          archiveBytes: archive.length,
          bills,
          providerDatasetHash: dataset.dataset_hash,
        });
        await save();
        return {
          status: 'pending',
          phase: 'archive_retained',
          state: work.state,
          sessionId: listing.session_id,
          processed: 0,
        };
      }
      const stored = await writer.$queryRaw<
        Array<{ bytes: string }>
      >`SELECT original_bytes_base64 AS bytes FROM legal_dataset_archive WHERE content_hash=${session.archiveHash}`;
      if (stored.length !== 1 || stored[0]!.bytes.length > 160000000)
        throw Error('DATASET_REFRESH_ARCHIVE_MISSING');
      const imported = await importFrozenStateDataset(
        writer,
        Buffer.from(stored[0]!.bytes, 'base64'),
        {
          state: work.state,
          sessionId: session.session.session_id,
          archiveHash: session.archiveHash,
          expectedBills: session.bills!,
        },
        { limit: 1000, deadline },
      );
      session.done = 'scanComplete' in imported && imported.scanComplete;
      if (work.sessions.every((row) => row.done)) work.complete = true;
      await save();
      return {
        status: 'pending',
        phase: 'metadata',
        state: work.state,
        sessionId: session.session.session_id,
        processed: imported.processed,
        sessionScanComplete: session.done,
        metadataComplete: imported.metadataComplete,
      };
    });
    return { ...result, providerCalls, cycleStartedAt: cycle.startedAt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'DATASET_REFRESH_FAILED';
    await save(false, reason.slice(0, 200));
    return {
      status:
        reason === 'DATASET_SLICE_DEADLINE'
          ? 'pending'
          : [
                'EXISTING_PROVIDER_BUDGET_HOLD',
                'STATE_WRITER_ALREADY_RUNNING',
                'LEGISCAN_PROVIDER_MONTHLY_CAPACITY_HOLD',
              ].includes(reason)
            ? 'held'
            : 'failed',
      reason,
      processed: 0,
      providerCalls,
      cycleStartedAt: cycle.startedAt,
    };
  } finally {
    await prisma.$executeRawUnsafe(
      'UPDATE federal_evidence_checkpoint SET lease_token=NULL,lease_until=NULL WHERE source=$1 AND lease_token=$2::uuid',
      SOURCE,
      token,
    );
  }
}
