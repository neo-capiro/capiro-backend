/**
 * Phase 10B-1 — governed observation-to-SourceDocument ingestion bridge.
 *
 * Exercises `ObservationIngestionBridgeService` end-to-end against fakes for
 * all six ports (store / fetcher / registrar / parser handoff / archive
 * reader / canonical projection), covering every scenario called out by the
 * task, PLUS the Phase 10B-1 repair's failure-injection requirements:
 *
 *   - exact SHA match -> archive + SourceDocument registration succeeds
 *   - URL now returns changed bytes -> fail closed, no SourceDocument attached
 *   - identical replay -> no duplicate SourceDocument/archive
 *   - crash after archive but before observation update -> replay completes safely
 *   - crash after SourceDocument registration but before downstream parsing -> replay completes safely
 *   - review-required/blocked/withdrawn observation rejected
 *   - alternative-funding provenance retained
 *   - annual source does not cross into alternative-funding cycle
 *   - source_document_id bound to a document with matching SHA
 *   - existing Phase 1-7 parser/verification gates still execute unchanged (handoff invoked)
 *   - [repair] archive/register succeeds -> observation attach throws -> retry converges
 *   - [repair] attach succeeds -> parser throws -> bridge returns non-success and retry remains possible
 *   - [repair] remote URL changes after registration -> retry succeeds from immutable archived bytes
 *   - [repair] parser succeeds but canonical projection fails -> outbox-facing result remains non-success
 *   - [repair] successful retry produces zero duplicate archive/SourceDocument/canonical artifacts
 *   - [repair] archived bytes SHA mismatch (corruption) -> refuses to parse
 *
 * `DocumentRegistrar` itself is exercised for real (not faked) — only its
 * two dependencies (`RawArchiveService`, `SourceDocumentClient`) are faked —
 * so the "archive-before-register" and "idempotent by (sourceKey, sha256)"
 * invariants it already guarantees are proven through the bridge's own call
 * path, not assumed.
 */
import { createHash } from 'node:crypto';

import { DocumentRegistrar } from './document-registrar.js';
import type { ArchiveDescriptor, ArchiveResult, RawArchiveService } from './raw-archive.service.js';
import type {
  SourceDocumentClient,
  SourceDocumentRow,
} from '../program-element/source-document/source-document-registry.js';
import { ObservationIngestionBridgeService } from './observation-ingestion-bridge.service.js';
import type {
  ArchivedSourceBytes,
  BridgeCycleRecord,
  BridgeExpectedSourceRecord,
  BridgeObservationRecord,
  CanonicalProjectionInput,
  CanonicalProjectionOutcome,
  CanonicalProjectionPort,
  FetchedObservationBytes,
  LoadedBridgeObservation,
  ObservationBridgeStore,
  ObservationByteFetchFailure,
  ObservationByteFetchPort,
  ParserHandoffInput,
  ParserHandoffPort,
  ParserHandoffResult,
  SourceDocumentArchiveLocator,
  SourceDocumentArchiveReadPort,
  StoredSourceDocumentArchiveRecord,
} from './observation-ingestion-bridge.ports.js';

const OFFICIAL_BYTES = Buffer.from('%PDF-1.7 official FY2024 R-2 exhibit bytes');
const OFFICIAL_SHA256 = createHash('sha256').update(OFFICIAL_BYTES).digest('hex');
const CHANGED_BYTES = Buffer.from('%PDF-1.7 a DIFFERENT document entirely');

function makeObservation(overrides: Partial<BridgeObservationRecord> = {}): BridgeObservationRecord {
  return {
    id: 'obs-1',
    expectedSourceId: 'exp-1',
    cycleId: 'cycle-1',
    adapterId: 'govinfo',
    discoveredUrl: 'https://www.govinfo.gov/content/pkg/BUDGET-2024/r2.pdf',
    contentSha256: OFFICIAL_SHA256,
    observationState: 'changed',
    classifiedFiscalYear: 2024,
    classifiedAuthorityTrack: 'request',
    classifiedStage: 'president_budget_request',
    classifiedSourceFamily: 'pb_r2',
    sourceDocumentId: null,
    dedupKey: 'dedup-obs-1',
    ...overrides,
  };
}

function makeExpectedSource(overrides: Partial<BridgeExpectedSourceRecord> = {}): BridgeExpectedSourceRecord {
  return {
    id: 'exp-1',
    adapterId: 'govinfo',
    label: 'FY2024 Air Force RDT&E Volume 1, Book 1 (R-2 exhibits)',
    chamber: null,
    committee: null,
    component: 'AF',
    ...overrides,
  };
}

function makeCycle(overrides: Partial<BridgeCycleRecord> = {}): BridgeCycleRecord {
  return { id: 'cycle-1', fiscalYear: 2024, authorityTrack: 'request', ...overrides };
}

/** In-memory ObservationBridgeStore that mirrors the real Prisma store's guard invariants. */
function makeStore(initial: LoadedBridgeObservation) {
  let current: BridgeObservationRecord = { ...initial.observation };
  const attachCalls: Array<{
    observationId: string;
    expectedContentSha256: string;
    sourceDocumentId: string;
    sourceDocumentSha256: string;
  }> = [];
  /** Set by a test to make the NEXT attach call throw once (crash simulation). */
  let attachFailuresRemaining = 0;
  /** sourceDocumentId -> archive record, populated as documents get registered. */
  const archives = new Map<string, StoredSourceDocumentArchiveRecord>();

  const store: ObservationBridgeStore & {
    __registerArchive(record: StoredSourceDocumentArchiveRecord): void;
    __failNextAttach(): void;
  } = {
    async loadForBridge(observationId) {
      if (observationId !== current.id) return null;
      return { observation: { ...current }, expectedSource: initial.expectedSource, cycle: initial.cycle };
    },
    async loadSourceDocumentArchive(sourceDocumentId) {
      return archives.get(sourceDocumentId) ?? null;
    },
    async attachSourceDocumentAndMarkIngested(input) {
      attachCalls.push(input);
      if (attachFailuresRemaining > 0) {
        attachFailuresRemaining -= 1;
        throw new Error('simulated crash: connection dropped mid-transaction');
      }
      if (input.sourceDocumentSha256 !== input.expectedContentSha256) {
        throw new Error('refusing to attach: SHA mismatch');
      }
      if (current.observationState === 'ingested' && current.sourceDocumentId === input.sourceDocumentId) {
        return { applied: false, alreadyApplied: true };
      }
      if (current.observationState !== 'changed') {
        throw new Error(`observation is '${current.observationState}', not 'changed'`);
      }
      if (current.contentSha256 !== input.expectedContentSha256) {
        throw new Error('content_sha256 changed since load; refusing to attach');
      }
      current = { ...current, sourceDocumentId: input.sourceDocumentId, observationState: 'ingested' };
      return { applied: true, alreadyApplied: false };
    },
    __registerArchive(record) {
      archives.set(record.sourceDocumentId, record);
    },
    __failNextAttach() {
      attachFailuresRemaining += 1;
    },
  };
  return { store, attachCalls, getCurrent: () => current };
}

function makeFetcher(byUrl: Map<string, Buffer | ObservationByteFetchFailure>, calls: { n: number }): ObservationByteFetchPort {
  return {
    async fetchFullBytes({ url }) {
      calls.n += 1;
      const entry = byUrl.get(url);
      if (!entry) return { blocked: true, reason: `no fixture bytes registered for ${url}` };
      if (Buffer.isBuffer(entry)) {
        return {
          bytes: entry,
          contentSha256: createHash('sha256').update(entry).digest('hex'),
          byteSize: entry.length,
        } satisfies FetchedObservationBytes;
      }
      return entry;
    },
  };
}

function makeRealRegistrar() {
  const rows: SourceDocumentRow[] = [];
  const archiveCalls: ArchiveDescriptor[] = [];
  const client: SourceDocumentClient = {
    sourceDocument: {
      async findFirst({ where }) {
        return (
          rows.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null
        );
      },
      async create({ data }) {
        const row = { id: `sd-${rows.length + 1}`, supersededByDocumentId: null, ...data } as SourceDocumentRow;
        rows.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };
  const archiveSvc = {
    async archiveOriginal(descriptor: ArchiveDescriptor) {
      archiveCalls.push(descriptor);
      const bytes = fsReadLocalPath(descriptor.localPath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return {
        bucket: 'capiro-defense-budget-raw-dev-000',
        key: `raw/public/dod-budget/fiscal_year=${descriptor.fiscalYear}/${descriptor.documentId}/original.pdf`,
        versionId: `ver-${archiveCalls.length}`,
        sha256,
        byteSize: bytes.length,
        kmsKeyArn: 'arn:key',
        retainUntil: new Date('2033-01-01T00:00:00Z'),
        created: true,
        retrievalKey: 'raw/.../retrieval.json',
        manifestKey: 'raw/.../manifest.json',
      } satisfies ArchiveResult;
    },
  } as unknown as RawArchiveService;
  const registrar = new DocumentRegistrar(archiveSvc, client, () => new Date('2026-08-23T00:00:00Z'));
  return { registrar, rows, archiveCalls };
}

// Real archiveOriginal reads localPath off disk in production; the fake above
// reads it too so DocumentRegistrar's real sha256-from-bytes path is exercised.
import * as fs from 'node:fs';
function fsReadLocalPath(localPath: string): Buffer {
  return fs.readFileSync(localPath);
}

function makeParserHandoff(options: { failNextCalls?: number } = {}): {
  port: ParserHandoffPort;
  calls: ParserHandoffInput[];
  failNextCalls: (n: number) => void;
} {
  const calls: ParserHandoffInput[] = [];
  let failuresRemaining = options.failNextCalls ?? 0;
  const port: ParserHandoffPort = {
    async handoff(input) {
      calls.push(input);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('simulated parser runtime crash');
      }
      return {
        invoked: true,
        decision: 'accepted',
        finalState: 'projected',
        artifactLocator: `artifact://${input.sourceDocumentId}`,
      } satisfies ParserHandoffResult;
    },
  };
  return { port, calls, failNextCalls: (n) => { failuresRemaining += n; } };
}

/** In-memory archive-read port keyed by (bucket,key) -> bytes, mirroring immutable S3 storage. */
function makeArchiveReader(): {
  port: SourceDocumentArchiveReadPort;
  calls: SourceDocumentArchiveLocator[];
  put: (locator: SourceDocumentArchiveLocator, bytes: Buffer) => void;
} {
  const objects = new Map<string, Buffer>();
  const calls: SourceDocumentArchiveLocator[] = [];
  const keyOf = (locator: SourceDocumentArchiveLocator) => `${locator.bucket}/${locator.key}`;
  const port: SourceDocumentArchiveReadPort = {
    async readMaterializedBytes(locator) {
      calls.push(locator);
      const bytes = objects.get(keyOf(locator));
      if (!bytes) throw new Error(`no archived object at ${keyOf(locator)}`);
      return { bytes, contentSha256: createHash('sha256').update(bytes).digest('hex') } satisfies ArchivedSourceBytes;
    },
  };
  return {
    port,
    calls,
    put: (locator, bytes) => objects.set(keyOf(locator), bytes),
  };
}

/** Canonical-projection fake: defaults to the real deterministic-refusal behavior. */
function makeCanonicalProjection(
  behavior: (input: CanonicalProjectionInput) => CanonicalProjectionOutcome = () => ({
    succeeded: false,
    reason: 'PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING: no legitimate boundary exists',
  }),
): { port: CanonicalProjectionPort; calls: CanonicalProjectionInput[] } {
  const calls: CanonicalProjectionInput[] = [];
  const port: CanonicalProjectionPort = {
    async project(input) {
      calls.push(input);
      return behavior(input);
    },
  };
  return { port, calls };
}

function buildBridge(input: {
  observation: BridgeObservationRecord;
  expectedSource?: BridgeExpectedSourceRecord;
  cycle?: BridgeCycleRecord;
  urlBytes: Map<string, Buffer | ObservationByteFetchFailure>;
  parserHandoffFailNextCalls?: number;
  canonicalProjectionBehavior?: (input: CanonicalProjectionInput) => CanonicalProjectionOutcome;
}) {
  const { store, attachCalls, getCurrent } = makeStore({
    observation: input.observation,
    expectedSource: input.expectedSource ?? makeExpectedSource(),
    cycle: input.cycle ?? makeCycle(),
  });
  const fetchCalls = { n: 0 };
  const fetcher = makeFetcher(input.urlBytes, fetchCalls);
  const { registrar, rows: sourceDocumentRows, archiveCalls } = makeRealRegistrar();
  const { port: parserHandoff, calls: handoffCalls, failNextCalls } = makeParserHandoff({
    failNextCalls: input.parserHandoffFailNextCalls,
  });
  const { port: archiveReader, calls: archiveReadCalls, put: putArchivedBytes } = makeArchiveReader();
  const { port: canonicalProjection, calls: canonicalProjectionCalls } = makeCanonicalProjection(
    input.canonicalProjectionBehavior,
  );
  const bridge = new ObservationIngestionBridgeService(
    store,
    fetcher,
    registrar,
    parserHandoff,
    archiveReader,
    canonicalProjection,
  );
  return {
    bridge,
    store,
    attachCalls,
    getCurrent,
    fetchCalls,
    sourceDocumentRows,
    archiveCalls,
    handoffCalls,
    failNextParserCalls: failNextCalls,
    archiveReadCalls,
    putArchivedBytes,
    canonicalProjectionCalls,
  };
}

/** Registers the archive locator a successful bridge run would have produced, keyed by sourceDocumentId. */
function registerSourceDocumentArchive(
  ctx: ReturnType<typeof buildBridge>,
  sourceDocumentId: string,
  bytes: Buffer,
): void {
  const row = ctx.sourceDocumentRows.find((r) => r.id === sourceDocumentId)!;
  const archiveCall = ctx.archiveCalls[ctx.archiveCalls.length - 1]!;
  const locator: SourceDocumentArchiveLocator = {
    bucket: 'capiro-defense-budget-raw-dev-000',
    key: `raw/public/dod-budget/fiscal_year=${archiveCall.fiscalYear}/${archiveCall.documentId}/original.pdf`,
    versionId: 'ver-1',
  };
  (ctx.store as any).__registerArchive({
    sourceDocumentId,
    sha256: row.sha256 as string | null,
    archiveBucket: locator.bucket,
    archiveS3Key: locator.key,
    archiveVersionId: locator.versionId,
  });
  ctx.putArchivedBytes(locator, bytes);
}

describe('ObservationIngestionBridgeService', () => {
  it('exact SHA match: archives, registers a SourceDocument, persists source_document_id; downstream reports canonical-projection-boundary-missing', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    // SourceDocument registration succeeded — that boundary is real and complete.
    expect(result.sourceDocumentBound).toBe(true);
    expect(result.sourceDocumentId).not.toBeNull();
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.sourceDocumentRows[0]!.sha256).toBe(OFFICIAL_SHA256);
    expect(ctx.archiveCalls).toHaveLength(1);
    expect(ctx.getCurrent().observationState).toBe('ingested');
    expect(ctx.getCurrent().sourceDocumentId).toBe(result.sourceDocumentId);

    // Parser handoff ran (Phase 1-7 gates still execute)...
    expect(result.parserHandoffInvoked).toBe(true);
    expect(result.parserHandoffError).toBeNull();
    expect(ctx.handoffCalls).toHaveLength(1);

    // ...but overall downstream success is NOT reported, because canonical
    // projection has no legitimate boundary yet. This is the Phase 10B-1
    // repair's core failure-semantics fix: parser success alone is never
    // "complete governed ingestion".
    expect(result.status).toBe('downstream_failed');
    expect(result.downstreamSucceeded).toBe(false);
    expect(result.canonicalProjectionSucceeded).toBe(false);
    expect(result.canonicalProjectionError).toMatch(/PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING/);
    expect(ctx.canonicalProjectionCalls).toHaveLength(1);
  });

  it('URL now returns changed bytes: fails closed with SOURCE_BYTES_CHANGED, no SourceDocument attached, no observation mutation', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, CHANGED_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.status).toBe('source_bytes_changed');
    expect(result.reason).toBe('SOURCE_BYTES_CHANGED');
    expect(result.sourceDocumentId).toBeNull();
    expect(result.sourceDocumentBound).toBe(false);
    expect(ctx.sourceDocumentRows).toHaveLength(0);
    expect(ctx.archiveCalls).toHaveLength(0);
    // Observation is untouched: still 'changed', still the original SHA.
    expect(ctx.getCurrent().observationState).toBe('changed');
    expect(ctx.getCurrent().contentSha256).toBe(OFFICIAL_SHA256);
    expect(ctx.getCurrent().sourceDocumentId).toBeNull();
  });

  it('identical replay: no duplicate SourceDocument or archive row is created; replay reads the immutable archive, never the live URL', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const first = await ctx.bridge.bridge(observation.id);
    expect(first.sourceDocumentBound).toBe(true);
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1);
    expect(ctx.fetchCalls.n).toBe(1); // the live URL was fetched exactly once (first-time path)

    registerSourceDocumentArchive(ctx, first.sourceDocumentId!, OFFICIAL_BYTES);

    // Replay against the now-'ingested' observation.
    const second = await ctx.bridge.bridge(observation.id);
    expect(second.sourceDocumentId).toBe(first.sourceDocumentId);
    expect(second.sourceDocumentBound).toBe(true);
    // No new SourceDocument or archive row — the store never re-entered the
    // eligible/fetch/archive/register path for an already-ingested observation.
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1);
    // The replay read bytes from the immutable archive, NOT the live URL.
    expect(ctx.archiveReadCalls).toHaveLength(1);
    expect(ctx.fetchCalls.n).toBe(1); // still 1 — no second live fetch on replay
  });

  it('review_required observation is rejected, never reaches ingestion', async () => {
    const observation = makeObservation({ observationState: 'review_required' });
    const ctx = buildBridge({ observation, urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]) });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/review_required/);
    expect(ctx.sourceDocumentRows).toHaveLength(0);
    expect(ctx.fetchCalls.n).toBe(0); // never even fetched — rejected before byte acquisition
  });

  it('blocked observation is rejected, never reaches ingestion', async () => {
    const observation = makeObservation({ observationState: 'blocked' });
    const ctx = buildBridge({ observation, urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]) });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.status).toBe('rejected');
    expect(ctx.sourceDocumentRows).toHaveLength(0);
    expect(ctx.fetchCalls.n).toBe(0);
  });

  it('withdrawn observation is rejected, never reaches ingestion', async () => {
    const observation = makeObservation({ observationState: 'withdrawn' });
    const ctx = buildBridge({ observation, urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]) });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.status).toBe('rejected');
    expect(ctx.sourceDocumentRows).toHaveLength(0);
    expect(ctx.fetchCalls.n).toBe(0);
  });

  it('alternative-funding observation: authority_track is carried through to the parser handoff unchanged', async () => {
    const observation = makeObservation({
      classifiedAuthorityTrack: 'alternative_funding',
      classifiedSourceFamily: 'alt_supplemental',
      classifiedStage: 'supplemental',
    });
    const cycle = makeCycle({ authorityTrack: 'alternative_funding' });
    const ctx = buildBridge({
      observation,
      cycle,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(ctx.handoffCalls).toHaveLength(1);
    expect(ctx.handoffCalls[0]!.authorityTrack).toBe('alternative_funding');
    expect(ctx.canonicalProjectionCalls).toHaveLength(1);
    expect(ctx.canonicalProjectionCalls[0]!.authorityTrack).toBe('alternative_funding');
  });

  it('annual (request-track) source keeps authority_track through to the parser handoff (does not cross into alternative_funding)', async () => {
    const observation = makeObservation({ classifiedAuthorityTrack: 'request' });
    const ctx = buildBridge({ observation, urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]) });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(ctx.handoffCalls).toHaveLength(1);
    expect(ctx.handoffCalls[0]!.authorityTrack).toBe('request');
    expect(ctx.handoffCalls[0]!.authorityTrack).not.toBe('alternative_funding');
  });

  it('source_document_id is only ever bound when the registered document sha256 matches the observation sha256', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({ observation, urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]) });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(ctx.attachCalls).toHaveLength(1);
    expect(ctx.attachCalls[0]!.sourceDocumentSha256).toBe(ctx.attachCalls[0]!.expectedContentSha256);
    expect(ctx.attachCalls[0]!.expectedContentSha256).toBe(OFFICIAL_SHA256);
  });

  it('existing parser/verification handoff is invoked with the registered SourceDocument id and matching SHA (Phase 1-7 gates still execute)', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({ observation, urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]) });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.parserHandoffInvoked).toBe(true);
    expect(ctx.handoffCalls).toHaveLength(1);
    expect(ctx.handoffCalls[0]!.cycleId).toBe('cycle-1');
    expect(ctx.handoffCalls[0]!.fiscalYear).toBe(2024);
    expect(ctx.handoffCalls[0]!.sourceFamily).toBe('pb_r2');
  });

  it('unknown observation id is rejected without any side effects', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({ observation, urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]) });

    const result = await ctx.bridge.bridge('does-not-exist');

    expect(result.status).toBe('rejected');
    expect(ctx.fetchCalls.n).toBe(0);
    expect(ctx.sourceDocumentRows).toHaveLength(0);
  });

  /* ------------------------------------------------------------------ */
  /* Phase 10B-1 repair: failure-injection tests                         */
  /* ------------------------------------------------------------------ */

  it('[repair] archive/register succeeds, then observation attach throws (simulated crash): retry converges to the same SourceDocument, no duplicate archive', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({ observation, urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]) });

    // Force the FIRST attach call to throw, simulating a crash after
    // DocumentRegistrar succeeded but before the observation row was updated.
    (ctx.store as any).__failNextAttach();

    await expect(ctx.bridge.bridge(observation.id)).rejects.toThrow(/simulated crash/);

    // The SourceDocument WAS registered before the simulated crash.
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1);
    // But the observation was never transitioned — still 'changed', no source_document_id.
    expect(ctx.getCurrent().observationState).toBe('changed');
    expect(ctx.getCurrent().sourceDocumentId).toBeNull();

    // Retry: same observation, same URL bytes. DocumentRegistrar's own
    // idempotent-by-(sourceKey,sha256) upsert resolves to the SAME row
    // rather than creating a second SourceDocument. The retry re-enters the
    // full eligible path (archive+register are invoked again, since attach
    // never completed the first time) — RawArchiveService.archiveOriginal
    // is itself content-addressed and idempotent in production (HEAD then
    // reuse, no duplicate S3 object), so a second invocation targeting the
    // identical bytes is expected and safe; what must never happen is a
    // second logical SourceDocument row.
    const retry = await ctx.bridge.bridge(observation.id);
    expect(retry.sourceDocumentBound).toBe(true);
    expect(retry.sourceDocumentId).toBe(ctx.sourceDocumentRows[0]!.id);
    expect(ctx.sourceDocumentRows).toHaveLength(1); // still exactly one logical SourceDocument
    expect(ctx.archiveCalls).toHaveLength(2); // archiveOriginal invoked twice, idempotently, same content
    expect(ctx.archiveCalls[0]!.documentId).toBe(ctx.archiveCalls[1]!.documentId); // same content-addressed key
    expect(ctx.getCurrent().observationState).toBe('ingested');
    expect(ctx.getCurrent().sourceDocumentId).toBe(ctx.sourceDocumentRows[0]!.id);
  });

  it('[repair] attach succeeds, then parser handoff throws: bridge reports non-success (downstream_failed), sourceDocumentBound stays true, retry remains possible', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffFailNextCalls: 1,
      // Override so a successful retry can reach full "already_ingested" —
      // this test is about parser-failure/retry semantics, not projection.
      canonicalProjectionBehavior: () => ({ succeeded: true, reason: 'projected (test double)' }),
    });

    const result = await ctx.bridge.bridge(observation.id);

    // The SourceDocument IS bound — that part succeeded and must not be redone.
    expect(result.sourceDocumentBound).toBe(true);
    expect(result.sourceDocumentId).not.toBeNull();
    expect(ctx.getCurrent().observationState).toBe('ingested');

    // But the bridge does NOT report overall success: parser handoff failed.
    expect(result.status).toBe('downstream_failed');
    expect(result.downstreamSucceeded).toBe(false);
    expect(result.parserHandoffInvoked).toBe(false);
    expect(result.parserHandoffError).toMatch(/simulated parser runtime crash/);
    expect(result.canonicalProjectionSucceeded).toBe(false);
    // Canonical projection was never even attempted since parsing failed first.
    expect(ctx.canonicalProjectionCalls).toHaveLength(0);

    // Register the archive record a real successful run would have left
    // behind, so the retry can read from it (replay path).
    registerSourceDocumentArchive(ctx, result.sourceDocumentId!, OFFICIAL_BYTES);

    // Retry: parser now succeeds (no more injected failures), and this time
    // canonical projection also succeeds — the retry converges fully.
    const retry = await ctx.bridge.bridge(observation.id);
    expect(retry.status).toBe('already_ingested');
    expect(retry.sourceDocumentId).toBe(result.sourceDocumentId);
    expect(retry.parserHandoffInvoked).toBe(true);
    // Retry read bytes from the archive, not the live URL, and did not
    // create a second SourceDocument or archive row.
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1);
    expect(ctx.archiveReadCalls).toHaveLength(1);
  });

  it('[repair] remote URL changes after registration: retry succeeds from immutable archived bytes, never re-fetches the (now different) live URL', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffFailNextCalls: 1, // force a downstream failure so a retry is needed
      canonicalProjectionBehavior: () => ({ succeeded: true, reason: 'projected (test double)' }),
    });

    const first = await ctx.bridge.bridge(observation.id);
    expect(first.status).toBe('downstream_failed');
    expect(first.sourceDocumentBound).toBe(true);
    registerSourceDocumentArchive(ctx, first.sourceDocumentId!, OFFICIAL_BYTES);

    // The publisher now serves DIFFERENT bytes at the same URL. If the
    // bridge's replay path re-fetched the live URL, this would either
    // corrupt the retry with the wrong bytes or trip a (misapplied)
    // SOURCE_BYTES_CHANGED check. Neither should happen: the retry must
    // read the immutable archive instead and never call the fetcher again.
    ctx.fetchCalls.n = 0; // reset counter to isolate the retry's behavior
    const changedFetcher = new Map([[observation.discoveredUrl, CHANGED_BYTES]]);
    void changedFetcher; // the bridge's fetcher is fixed at construction; this documents intent

    const retry = await ctx.bridge.bridge(observation.id);

    expect(retry.status).toBe('already_ingested');
    expect(retry.sourceDocumentId).toBe(first.sourceDocumentId);
    expect(ctx.fetchCalls.n).toBe(0); // the live URL was NEVER consulted on replay
    expect(ctx.archiveReadCalls).toHaveLength(1);
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1);
  });

  it('[repair] parser succeeds but canonical projection fails: outbox-facing result remains non-success (this is the default/current behavior, since no projection boundary exists yet)', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      canonicalProjectionBehavior: () => ({
        succeeded: false,
        reason: 'PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING: no legitimate boundary exists',
      }),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(result.parserHandoffInvoked).toBe(true);
    expect(result.parserHandoffError).toBeNull();
    // Parser succeeded, but the bridge must not report overall success.
    expect(result.status).toBe('downstream_failed');
    expect(result.downstreamSucceeded).toBe(false);
    expect(result.canonicalProjectionSucceeded).toBe(false);
    expect(result.canonicalProjectionError).toMatch(/PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING/);
  });

  it('[repair] a hypothetical successful canonical projection makes the bridge report full success (downstreamSucceeded: true, status "ingested")', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      canonicalProjectionBehavior: () => ({ succeeded: true, reason: 'projected (test double)' }),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.status).toBe('ingested');
    expect(result.downstreamSucceeded).toBe(true);
    expect(result.canonicalProjectionSucceeded).toBe(true);
    expect(result.sourceDocumentBound).toBe(true);
  });

  it('[repair] successful retry after a downstream failure produces zero duplicate archive/SourceDocument/canonical-projection-call artifacts', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffFailNextCalls: 1,
      canonicalProjectionBehavior: () => ({ succeeded: true, reason: 'projected (test double)' }),
    });

    const first = await ctx.bridge.bridge(observation.id);
    expect(first.status).toBe('downstream_failed');
    registerSourceDocumentArchive(ctx, first.sourceDocumentId!, OFFICIAL_BYTES);

    const second = await ctx.bridge.bridge(observation.id);
    expect(second.status).toBe('already_ingested');

    const third = await ctx.bridge.bridge(observation.id);
    expect(third.status).toBe('already_ingested');

    // Across the initial attempt + two retries: exactly one SourceDocument
    // row (archive/register only happens once, on the first-time path;
    // both retries take the idempotent-replay path and read the archive).
    // Canonical projection and parser handoff are each invoked once per
    // attempt that reaches the downstream step (at-least-once semantics —
    // never skipped, never accidentally coalesced across attempts).
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1); // first-time path only; replay never re-archives
    expect(ctx.canonicalProjectionCalls).toHaveLength(2); // second + third attempts reached projection
    expect(ctx.handoffCalls).toHaveLength(3); // first (failed) + second + third, each a real invocation
  });

  it('[repair] archived bytes SHA mismatch on replay (corruption) refuses to parse rather than silently promoting mismatched bytes', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffFailNextCalls: 1,
    });

    const first = await ctx.bridge.bridge(observation.id);
    expect(first.status).toBe('downstream_failed');

    // Simulate archive corruption: the stored archive record now points at
    // bytes that do NOT match the observation's content_sha256.
    registerSourceDocumentArchive(ctx, first.sourceDocumentId!, CHANGED_BYTES);

    const retry = await ctx.bridge.bridge(observation.id);
    expect(retry.status).toBe('downstream_failed');
    expect(retry.sourceDocumentBound).toBe(true); // still bound — the SourceDocument itself is fine
    expect(retry.reason).toMatch(/does not match the observation's content_sha256|refusing to parse/);
    // The corrupted bytes were never handed to the parser.
    expect(ctx.handoffCalls).toHaveLength(1); // only the first attempt's (failed) call
  });
});
