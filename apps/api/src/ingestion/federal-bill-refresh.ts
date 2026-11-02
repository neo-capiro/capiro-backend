import type { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import {
  FEDERAL_BILL_TYPES,
  federalHash,
  federalIdentity,
  type FederalBillType,
} from './federal-billstatus.js';
import {
  importFrozenFederalBillStatus,
  stageFederalAmendmentList,
} from './federal-billstatus-import.js';
import {
  loadFederalGeneration,
  enumerateFederalInventories,
  finalizeFederalDiscovery,
} from './federal-bill-inventory.js';
import {
  hydrateFederalInventories,
  federalHydrationPassComplete,
  type FederalHydrationPass,
} from './federal-bill-hydration.js';
import { refreshHeldFederalMetadata } from './federal-bill-metadata.js';
import { federalInventoryReuse } from './federal-inventory-reuse.js';
import {
  federalRefreshTransport,
  parseFederalAmendmentPage,
  type FederalAmendmentMember,
} from './federal-refresh-source.js';
import { createCongressRequestPacer } from './congress-request-pacer.js';

const SOURCE = 'fy26-federal-refresh:119';
const PHASES = [
  'archives',
  'amendments',
  'verify-amendments',
  'imports',
  'metadata',
  'inventory',
  'finalize',
  'hydrate',
  'completed',
] as const;
type Phase = (typeof PHASES)[number];
type Archive = { billType: FederalBillType; hash: string; count: number };
export type FederalRefreshCursor = {
  schemaVersion: 1;
  phase: Phase;
  startedAt: string;
  archives: Archive[];
  pages: string[];
  offset: number;
  expected: number | null;
  verifyPage: number;
  verifyOffset: number;
  listHash: string | null;
  importIndex: number;
  hydration: FederalHydrationPass | null;
  completedAt: string | null;
};
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function parseFederalRefreshCursor(value: unknown): FederalRefreshCursor {
  const c = value as FederalRefreshCursor;
  if (
    !c ||
    c.schemaVersion !== 1 ||
    !PHASES.includes(c.phase) ||
    !Number.isFinite(Date.parse(c.startedAt)) ||
    !Array.isArray(c.archives) ||
    c.archives.length > 8 ||
    c.archives.some(
      (a, i) =>
        a.billType !== FEDERAL_BILL_TYPES[i] ||
        !hash(a.hash) ||
        !Number.isSafeInteger(a.count) ||
        a.count < 1 ||
        a.count > 50000,
    ) ||
    !Array.isArray(c.pages) ||
    c.pages.length > 400 ||
    c.pages.some((p) => !hash(p)) ||
    [c.offset, c.verifyPage, c.verifyOffset, c.importIndex].some(
      (v) => !Number.isSafeInteger(v) || v < 0,
    ) ||
    c.importIndex > 8 ||
    c.verifyPage > c.pages.length ||
    c.verifyOffset > c.offset ||
    (c.expected !== null &&
      (!Number.isSafeInteger(c.expected) ||
        c.expected < 1 ||
        c.expected > 100000 ||
        c.offset > c.expected)) ||
    (c.listHash !== null && !hash(c.listHash)) ||
    (c.phase !== 'archives' && c.archives.length !== 8) ||
    (PHASES.indexOf(c.phase) >= PHASES.indexOf('imports') &&
      (!c.listHash || !c.expected || c.offset !== c.expected || c.verifyOffset !== c.expected)) ||
    (c.completedAt !== null && !Number.isFinite(Date.parse(c.completedAt))) ||
    (c.hydration !== null &&
      (!c.hydration ||
        !hash(c.hydration.taskHash) ||
        [
          'listedVersions',
          'unavailableListedVersions',
          'scanned',
          'processed',
          'retained',
          'failed',
          'partial',
          'unreadable',
          'unavailable',
        ].some(
          (key) =>
            !Number.isSafeInteger(c.hydration![key as keyof FederalHydrationPass]) ||
            Number(c.hydration![key as keyof FederalHydrationPass]) < 0,
        ) ||
        c.hydration.scanned > c.hydration.listedVersions ||
        c.hydration.processed + c.hydration.retained !== c.hydration.scanned)) ||
    (c.phase === 'completed' &&
      (!c.completedAt || !c.hydration || c.hydration.scanned !== c.hydration.listedVersions))
  )
    throw Error('FEDERAL_REFRESH_CHECKPOINT_INVALID');
  return c;
}
async function stageBytes(db: PrismaClient, bytes: Buffer) {
  const digest = federalHash(bytes),
    base64 = bytes.toString('base64');
  await db.$executeRawUnsafe(
    'INSERT INTO legal_dataset_archive(content_hash,original_bytes_base64) VALUES($1,$2) ON CONFLICT DO NOTHING',
    digest,
    base64,
  );
  const retained = await db.$queryRawUnsafe<unknown[]>(
    'SELECT content_hash FROM legal_dataset_archive WHERE content_hash=$1 AND original_bytes_base64=$2',
    digest,
    base64,
  );
  if (retained.length !== 1) throw Error('FEDERAL_REFRESH_ARCHIVE_CONFLICT');
  return digest;
}
async function retainedBytes(db: PrismaClient, digest: string, max: number) {
  const rows = await db.$queryRawUnsafe<Array<{ bytes: string }>>(
    'SELECT original_bytes_base64 AS bytes FROM legal_dataset_archive WHERE content_hash=$1',
    digest,
  );
  if (rows.length !== 1 || rows[0]!.bytes.length > Math.ceil(max / 3) * 4 + 4)
    throw Error('FEDERAL_REFRESH_ARCHIVE_MISSING');
  const bytes = Buffer.from(rows[0]!.bytes, 'base64');
  if (bytes.length > max || federalHash(bytes) !== digest)
    throw Error('FEDERAL_REFRESH_ARCHIVE_HASH_MISMATCH');
  return bytes;
}
async function members(db: PrismaClient, pages: string[], check = () => {}) {
  const all: FederalAmendmentMember[] = [];
  let expected: number | null = null;
  for (const page of pages) {
    check();
    const stored = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await retainedBytes(db, page, 8_000_000)),
    );
    if (
      stored.offset !== all.length ||
      typeof stored.complete !== 'boolean' ||
      !Array.isArray(stored.members)
    )
      throw Error('FEDERAL_REFRESH_PAGE_INVALID');
    const replay = parseFederalAmendmentPage(
      {
        amendments: stored.members,
        pagination: {
          count: stored.count,
          ...(stored.complete
            ? {}
            : {
                next: `https://api.congress.gov/v3/amendment/119?offset=${all.length + stored.members.length}`,
              }),
        },
      },
      all.length,
      expected,
    );
    expected = replay.count;
    all.push(...replay.members);
  }
  if (new Set(all.map((v) => federalIdentity(v, true))).size !== all.length)
    throw Error('FEDERAL_REFRESH_AMENDMENT_DUPLICATE');
  return all;
}
/** One existing writer lease is supplied by the CLI. Acquisition pages share one bounded slice. */
export async function refreshFederalBills(
  db: PrismaClient,
  options: {
    limit: number;
    requestCap: number;
    apiKey: string;
    now?: () => number;
    deadlineMs?: number;
    sleep?: (ms: number) => Promise<void>;
    transport?: typeof import('../meri/hardenedWebTransport.js').withGuardedWebResponse;
  },
) {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 1000 ||
    !Number.isSafeInteger(options.requestCap) ||
    options.requestCap < 1 ||
    options.requestCap > 4800 ||
    !options.apiKey
  )
    throw Error('FEDERAL_REFRESH_OPTIONS_INVALID');
  const now = options.now ?? Date.now,
    bound = options.deadlineMs ?? 600000;
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 600000)
    throw Error('FEDERAL_REFRESH_DEADLINE_INVALID');
  const deadline = now() + bound,
    check = () => {
      if (now() >= deadline) throw Error('FEDERAL_REFRESH_DEADLINE');
    };
  const pacer = createCongressRequestPacer({
    limit: options.requestCap,
    now,
    sleep: options.sleep,
  });
  let apiCalls = 0,
    publisherCalls = 0;
  const beforeAttempt = async (url?: URL) => {
    check();
    await pacer.beforeAttempt();
    check();
    await db.$queryRawUnsafe('SELECT 1');
    if (url?.origin === 'https://api.congress.gov') apiCalls++;
    else publisherCalls++;
  };
  const transport = federalRefreshTransport({
    beforeAttempt,
    check,
    remainingMs: () => Math.max(1, deadline - now()),
    sleep: options.sleep,
    transport: options.transport,
  });
  const saved = await db.federalEvidenceCheckpoint.findUnique({
    where: { source: SOURCE },
    select: { cursor: true },
  });
  let cursor = saved ? parseFederalRefreshCursor(saved.cursor) : null;
  const staleCycleRestarted = Boolean(
    cursor &&
    ['archives', 'amendments', 'verify-amendments'].includes(cursor.phase) &&
    now() - Date.parse(cursor.startedAt) >= 7 * 86400000,
  );
  if (
    cursor?.phase === 'completed' &&
    cursor.completedAt &&
    now() - Date.parse(cursor.completedAt) < 7 * 86400000
  )
    return {
      phase: 'completed',
      cycleComplete: true,
      complete: federalHydrationPassComplete(cursor.hydration),
      hydrationComplete: federalHydrationPassComplete(cursor.hydration),
      hydration: cursor.hydration,
      due: false,
      providerCalls: 0,
      apiCalls: 0,
      publisherCalls: 0,
    };
  if (!cursor || cursor.phase === 'completed' || staleCycleRestarted)
    cursor = {
      schemaVersion: 1,
      phase: 'archives',
      startedAt: new Date(now()).toISOString(),
      archives: [],
      pages: [],
      offset: 0,
      expected: null,
      verifyPage: 0,
      verifyOffset: 0,
      listHash: null,
      importIndex: 0,
      hydration: null,
      completedAt: null,
    };
  const save = async (error: string | null = null) => {
    const data = {
      cursor: JSON.parse(JSON.stringify(cursor)),
      status: error ? 'failed' : cursor!.phase === 'completed' ? 'completed' : 'running',
      lastError: error,
      completedAt: cursor!.completedAt ? new Date(cursor!.completedAt) : null,
    };
    await db.federalEvidenceCheckpoint.upsert({
      where: { source: SOURCE },
      create: { source: SOURCE, ...data },
      update: data,
    });
  };
  await save();
  const phase = cursor.phase;
  let result: Record<string, unknown> = {};
  try {
    check();
    if (phase === 'archives') {
      const billType = FEDERAL_BILL_TYPES[cursor.archives.length]!;
      const bytes = await transport.archive(billType),
        zip = await JSZip.loadAsync(bytes),
        count = Object.keys(zip.files).length,
        digest = federalHash(bytes);
      check();
      await importFrozenFederalBillStatus(
        db,
        bytes,
        { congress: 119, billType, archiveHash: digest, expectedBills: count },
        { limit: options.limit, inventoryOnly: true, refresh: true, check },
      );
      cursor.archives.push({ billType, hash: digest, count });
      if (cursor.archives.length === 8) cursor.phase = 'amendments';
      result = { archives: cursor.archives.length };
    } else if (phase === 'amendments' || phase === 'verify-amendments') {
      // Capture and verify as many pages as this invocation's existing request/deadline
      // budget allows. Every accepted page is durable before attempting the next one.
      while (cursor.phase === 'amendments' || cursor.phase === 'verify-amendments') {
        check();
        if (
          cursor.phase === 'verify-amendments' &&
          cursor.expected !== null &&
          cursor.verifyOffset === cursor.expected
        ) {
          if (cursor.offset !== cursor.expected || cursor.verifyPage !== cursor.pages.length)
            throw Error('FEDERAL_REFRESH_AMENDMENT_SOURCE_MOVED');
          // Verification is already durable. A deadline or transient database failure
          // during local qualification resumes here without fetching offset=count.
          const list = Buffer.from(JSON.stringify(await members(db, cursor.pages, check))),
            listHash = federalHash(list);
          check();
          await stageFederalAmendmentList(db, list, listHash, 119, cursor.expected, cursor.pages);
          check();
          // Exact cross-archive membership and nested parent graph proof BEFORE metadata writes.
          await loadFederalGeneration(
            db,
            cursor.archives.map((a) => a.hash),
            listHash,
            119,
            cursor.expected,
            false,
          );
          cursor.listHash = listHash;
          cursor.phase = 'imports';
          break;
        }
        const offset = cursor.phase === 'amendments' ? cursor.offset : cursor.verifyOffset;
        const url = new URL('https://api.congress.gov/v3/amendment/119');
        url.searchParams.set('format', 'json');
        url.searchParams.set('limit', '250');
        url.searchParams.set('offset', String(offset));
        url.searchParams.set('api_key', options.apiKey);
        const page = parseFederalAmendmentPage(
          await transport.json(url.href),
          offset,
          cursor.expected,
        );
        const bytes = Buffer.from(
            JSON.stringify({
              offset,
              count: page.count,
              complete: page.complete,
              members: page.members,
            }),
          ),
          digest = federalHash(bytes);
        if (cursor.phase === 'amendments') {
          const prior = await members(db, cursor.pages, check),
            ids = new Set(prior.map((v) => federalIdentity(v, true)));
          if (page.members.some((v) => ids.has(federalIdentity(v, true))))
            throw Error('FEDERAL_REFRESH_AMENDMENT_DUPLICATE');
          await stageBytes(db, bytes);
          cursor.pages.push(digest);
          cursor.offset += page.members.length;
          cursor.expected = page.count;
          if (page.complete) cursor.phase = 'verify-amendments';
        } else {
          if (cursor.pages[cursor.verifyPage] !== digest)
            throw Error('FEDERAL_REFRESH_AMENDMENT_SOURCE_MOVED');
          cursor.verifyPage++;
          cursor.verifyOffset += page.members.length;
          if (page.complete) {
            if (cursor.verifyPage !== cursor.pages.length)
              throw Error('FEDERAL_REFRESH_AMENDMENT_SOURCE_MOVED');
          }
        }
        await save();
      }
      result = {
        enumerated: cursor.offset,
        verified: cursor.verifyOffset,
        expected: cursor.expected,
      };
    } else if (phase === 'imports') {
      const a = cursor.archives[cursor.importIndex]!;
      const imported = await importFrozenFederalBillStatus(
        db,
        await retainedBytes(db, a.hash, 120_000_000),
        { congress: 119, billType: a.billType, archiveHash: a.hash, expectedBills: a.count },
        { limit: options.limit, refresh: true, refreshId: cursor.startedAt, check },
      );
      if (imported.complete) cursor.importIndex++;
      if (cursor.importIndex === 8) cursor.phase = 'metadata';
      result = imported;
    } else {
      const generation = await loadFederalGeneration(
        db,
        cursor.archives.map((a) => a.hash),
        cursor.listHash!,
        119,
        cursor.expected!,
        true,
        cursor.startedAt,
      );
      if (phase === 'metadata') {
        const metadata = await refreshHeldFederalMetadata(db, generation, {
          limit: options.limit,
          apiKey: options.apiKey,
          fetchJson: transport.json,
          check,
        });
        if (metadata.complete) cursor.phase = 'inventory';
        result = metadata;
      } else if (phase === 'inventory') {
        const inventory = await enumerateFederalInventories(db, generation, {
          limit: options.limit,
          apiKey: options.apiKey,
          fetchJson: transport.json,
          check,
          reuse: await federalInventoryReuse(db, generation),
        });
        if (inventory.complete) cursor.phase = 'finalize';
        result = inventory;
      } else if (phase === 'finalize') {
        result = await finalizeFederalDiscovery(db, generation, cursor.startedAt);
        cursor.phase = 'hydrate';
      } else if (phase === 'hydrate') {
        const hydrated = await hydrateFederalInventories(db, generation, {
          limit: options.limit,
          beforeAttempt,
          check,
          fetchImpl: (url, init) => {
            check();
            return fetch(url, {
              ...init,
              signal: AbortSignal.any([
                init?.signal ?? AbortSignal.timeout(60000),
                AbortSignal.timeout(Math.max(1, deadline - now())),
              ]),
            });
          },
          sleep: async (ms) => {
            check();
            if (ms >= deadline - now()) throw Error('FEDERAL_REFRESH_DEADLINE');
            await (options.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(
              ms,
            );
          },
        });
        if (!hydrated.pass) throw Error('FEDERAL_REFRESH_HYDRATION_PASS_MISSING');
        cursor.hydration = hydrated.pass;
        // A full bounded pass ends the refresh cycle; partial/unavailable documents remain explicit.
        if (hydrated.pass.scanned === hydrated.pass.listedVersions) {
          cursor.phase = 'completed';
          cursor.completedAt = new Date(now()).toISOString();
        }
        result = { ...hydrated, hydrationComplete: federalHydrationPassComplete(hydrated.pass) };
      }
    }
    await save();
    return {
      ...result,
      phase,
      nextPhase: cursor.phase,
      cycleComplete: cursor.phase === 'completed',
      complete: cursor.phase === 'completed' && federalHydrationPassComplete(cursor.hydration),
      hydration: cursor.hydration,
      providerCalls: pacer.count(),
      apiCalls,
      publisherCalls,
      staleCycleRestarted,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^[A-Z][A-Z0-9_]{1,100}$/.test(message)
      ? message
      : 'FEDERAL_REFRESH_OPERATION_FAILED';
    const capped = ['CONGRESS_REQUEST_CAP_REACHED', 'FEDERAL_REFRESH_DEADLINE'].includes(code);
    // A moving acquisition cannot be promoted or retried forever against pinned stale archives.
    if (
      /AMENDMENT_(?:SOURCE_MOVED|EXACT_ENUMERATION_MISMATCH|ENUMERATION_COUNT_MISMATCH|COUNT_INVALID|DUPLICATE|TRUNCATED|PARENT_UNRESOLVED)|DISCOVERY_CANONICAL_ADMISSION_MISMATCH|FEDERAL_REFRESH_PARENT_INCOMPLETE/.test(
        code,
      )
    ) {
      cursor = {
        schemaVersion: 1,
        phase: 'archives',
        startedAt: new Date(now()).toISOString(),
        archives: [],
        pages: [],
        offset: 0,
        expected: null,
        verifyPage: 0,
        verifyOffset: 0,
        listHash: null,
        importIndex: 0,
        hydration: null,
        completedAt: null,
      };
    }
    if (code.startsWith('FEDERAL_WRITER_')) throw error;
    await save(capped ? null : code);
    return {
      phase,
      nextPhase: cursor.phase,
      complete: false,
      cycleComplete: false,
      hydration: cursor.hydration,
      capped,
      error: capped ? null : code,
      providerCalls: pacer.count(),
      apiCalls,
      publisherCalls,
      staleCycleRestarted,
    };
  }
}
