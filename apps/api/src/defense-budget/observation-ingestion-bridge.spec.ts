/**
 * Phase 10B-1 — governed observation-to-SourceDocument ingestion bridge.
 *
 * Exercises `ObservationIngestionBridgeService` end-to-end against fakes for
 * all five ports (store / fetcher / registrar / parser handoff / archive
 * reader), covering the bridge's exact owned scope:
 *
 *   observation -> verify exact bytes -> immutable archive -> SourceDocument
 *   -> parser -> verification -> durable evidence -> SOURCE INGESTION COMPLETE
 *
 * Canonical promotion is explicitly OUT OF SCOPE for this bridge and is
 * proven absent both structurally (no `CanonicalProjectionPort` type exists
 * to inject, and the service's constructor takes exactly 5 dependencies) and
 * by a source-level negative control at the bottom of this file.
 *
 *   - exact SHA match -> archive + SourceDocument registration + PASS
 *     verification with durably persisted evidence -> ingestionSucceeded
 *   - URL now returns changed bytes -> fail closed, no SourceDocument attached
 *   - identical replay -> no duplicate SourceDocument/archive
 *   - review_required/blocked/withdrawn observation rejected
 *   - alternative-funding provenance retained
 *   - every non-alternative-funding authority track stays isolated from it
 *   - source_document_id bound to a document with matching SHA
 *   - existing Phase 1-7 parser/verification gates still execute unchanged (handoff invoked)
 *   - [repair] archive/register succeeds -> observation attach throws -> retry converges
 *   - [repair] transient parser/infra failure -> non-success, retryable, retry converges
 *   - [repair] verification persistence failure -> non-success, retryable (same transient path)
 *   - [repair] verification REVIEW -> governed review disposition, not endless retry
 *   - [repair] verification REJECT -> deterministic governed disposition, never success
 *   - [repair] an unresolved terminal decision is treated as retryable, never a governed disposition
 *   - [repair] remote URL changes after registration -> retry succeeds from immutable archived bytes
 *   - [repair] successful retry produces zero duplicate archive/SourceDocument artifacts
 *   - [repair] archived bytes SHA mismatch (corruption) -> refuses to parse
 *   - [repair] canonical promotion is never invoked from this bridge (structural + source-level)
 *
 * `DocumentRegistrar` itself is exercised for real (not faked) — only its
 * two dependencies (`RawArchiveService`, `SourceDocumentClient`) are faked —
 * so the "archive-before-register" and "idempotent by (sourceKey, sha256)"
 * invariants it already guarantees are proven through the bridge's own call
 * path, not assumed.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  VerifierDecision,
} from './observation-ingestion-bridge.ports.js';
import type { AuthorityTrack } from '@capiro/defense-domain';

const OFFICIAL_BYTES = Buffer.from('%PDF-1.7 official FY2024 R-2 exhibit bytes');
const OFFICIAL_SHA256 = createHash('sha256').update(OFFICIAL_BYTES).digest('hex');
const CHANGED_BYTES = Buffer.from('%PDF-1.7 a DIFFERENT document entirely');

function makeObservation(
  overrides: Partial<BridgeObservationRecord> = {},
): BridgeObservationRecord {
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

function makeExpectedSource(
  overrides: Partial<BridgeExpectedSourceRecord> = {},
): BridgeExpectedSourceRecord {
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
      return {
        observation: { ...current },
        expectedSource: initial.expectedSource,
        cycle: initial.cycle,
      };
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
      if (
        current.observationState === 'ingested' &&
        current.sourceDocumentId === input.sourceDocumentId
      ) {
        return { applied: false, alreadyApplied: true };
      }
      if (current.observationState !== 'changed') {
        throw new Error(`observation is '${current.observationState}', not 'changed'`);
      }
      if (current.contentSha256 !== input.expectedContentSha256) {
        throw new Error('content_sha256 changed since load; refusing to attach');
      }
      current = {
        ...current,
        sourceDocumentId: input.sourceDocumentId,
        observationState: 'ingested',
      };
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

function makeFetcher(
  byUrl: Map<string, Buffer | ObservationByteFetchFailure>,
  calls: { n: number },
): ObservationByteFetchPort {
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
          rows.find((r) =>
            Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
          ) ?? null
        );
      },
      async create({ data }) {
        const row = {
          id: `sd-${rows.length + 1}`,
          supersededByDocumentId: null,
          ...data,
        } as SourceDocumentRow;
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
      const bytes = fs.readFileSync(descriptor.localPath);
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
  const registrar = new DocumentRegistrar(
    archiveSvc,
    client,
    () => new Date('2026-08-23T00:00:00Z'),
  );
  return { registrar, rows, archiveCalls };
}

/**
 * Scripted parser-handoff fake. Each call consumes the next scripted result
 * from the queue (FIFO); once exhausted, defaults to a resolved `PASS`
 * decision. A `throw` entry models a genuine transient/infrastructure
 * failure (parser runtime crash, unreachable database, verification-
 * persistence failure) — the handoff call rejects, exactly as the real
 * `DefaultParserHandoffAdapter` does when `runParserHandoffForSourceDocument`
 * throws. A `decision` entry models a RESOLVED, durably-persisted terminal
 * verifier outcome (PASS / REVIEW / REJECT / the defensive UNKNOWN corner).
 */
type ScriptedHandoffResult =
  | { readonly kind: 'throw'; readonly message: string }
  | { readonly kind: 'decision'; readonly decision: VerifierDecision };

function makeParserHandoff(script: ScriptedHandoffResult[] = []): {
  port: ParserHandoffPort;
  calls: ParserHandoffInput[];
  enqueue: (...results: ScriptedHandoffResult[]) => void;
} {
  const calls: ParserHandoffInput[] = [];
  const queue: ScriptedHandoffResult[] = [...script];
  const port: ParserHandoffPort = {
    async handoff(input) {
      calls.push(input);
      const next: ScriptedHandoffResult = queue.shift() ?? { kind: 'decision', decision: 'PASS' };
      if (next.kind === 'throw') {
        throw new Error(next.message);
      }
      const finalState =
        next.decision === 'PASS'
          ? 'TERMINAL_PASSED'
          : next.decision === 'REVIEW'
            ? 'TERMINAL_REVIEW'
            : next.decision === 'REJECT'
              ? 'TERMINAL_REJECTED'
              : 'FAILED';
      return {
        invoked: true,
        decision: next.decision,
        finalState,
        artifactLocator: `artifact://${input.sourceDocumentId}`,
      } satisfies ParserHandoffResult;
    },
  };
  return { port, calls, enqueue: (...results) => queue.push(...results) };
}

/** In-memory archive-read port keyed by (bucket,key) -> bytes, mirroring immutable S3 storage. */
function makeArchiveReader(): {
  port: SourceDocumentArchiveReadPort;
  calls: SourceDocumentArchiveLocator[];
  signals: Array<AbortSignal | undefined>;
  put: (locator: SourceDocumentArchiveLocator, bytes: Buffer) => void;
} {
  const objects = new Map<string, Buffer>();
  const calls: SourceDocumentArchiveLocator[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const keyOf = (locator: SourceDocumentArchiveLocator) => `${locator.bucket}/${locator.key}`;
  const port: SourceDocumentArchiveReadPort = {
    async readMaterializedBytes(locator, options) {
      calls.push(locator);
      signals.push(options?.abortSignal);
      const bytes = objects.get(keyOf(locator));
      if (!bytes) throw new Error(`no archived object at ${keyOf(locator)}`);
      return {
        bytes,
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
      } satisfies ArchivedSourceBytes;
    },
  };
  return {
    port,
    calls,
    signals,
    put: (locator, bytes) => objects.set(keyOf(locator), bytes),
  };
}

function buildBridge(input: {
  observation: BridgeObservationRecord;
  expectedSource?: BridgeExpectedSourceRecord;
  cycle?: BridgeCycleRecord;
  urlBytes: Map<string, Buffer | ObservationByteFetchFailure>;
  parserHandoffScript?: ScriptedHandoffResult[];
}) {
  const { store, attachCalls, getCurrent } = makeStore({
    observation: input.observation,
    expectedSource: input.expectedSource ?? makeExpectedSource(),
    cycle: input.cycle ?? makeCycle(),
  });
  const fetchCalls = { n: 0 };
  const fetcher = makeFetcher(input.urlBytes, fetchCalls);
  const { registrar, rows: sourceDocumentRows, archiveCalls } = makeRealRegistrar();
  const {
    port: parserHandoff,
    calls: handoffCalls,
    enqueue: enqueueHandoffResults,
  } = makeParserHandoff(input.parserHandoffScript);
  const {
    port: archiveReader,
    calls: archiveReadCalls,
    signals: archiveReadSignals,
    put: putArchivedBytes,
  } = makeArchiveReader();
  const bridge = new ObservationIngestionBridgeService(
    store,
    fetcher,
    registrar,
    parserHandoff,
    archiveReader,
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
    enqueueHandoffResults,
    archiveReadCalls,
    archiveReadSignals,
    putArchivedBytes,
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
    // Phase 10B-31: mirror the real store, which returns this same
    // already-registered row's actual component -- a replay must see the
    // real persisted value, never an absent/undefined one.
    component: row.component as string | null,
    account:
      typeof (row.metadata as Record<string, unknown>).appropriationAccount === 'string'
        ? ((row.metadata as Record<string, unknown>).appropriationAccount as string)
        : null,
  });
  ctx.putArchivedBytes(locator, bytes);
}

describe('ObservationIngestionBridgeService', () => {
  it('exact SHA match: archives, registers a SourceDocument, persists source_document_id; parser verification PASSES and evidence is durably persisted -> ingestionSucceeded', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    // SourceDocument registration succeeded.
    expect(result.sourceDocumentBound).toBe(true);
    expect(result.sourceDocumentId).not.toBeNull();
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.sourceDocumentRows[0]!.sha256).toBe(OFFICIAL_SHA256);
    expect(ctx.archiveCalls).toHaveLength(1);
    expect(ctx.getCurrent().observationState).toBe('ingested');
    expect(ctx.getCurrent().sourceDocumentId).toBe(result.sourceDocumentId);

    // Parser handoff ran (Phase 1-7 gates still execute) and resolved PASS...
    expect(result.parserHandoffInvoked).toBe(true);
    expect(result.parserHandoffError).toBeNull();
    expect(ctx.handoffCalls).toHaveLength(1);
    expect(result.verifierDecision).toBe('PASS');
    // [Phase 10B-31] ...and the handoff received the SAME sourceKey/component
    // that were actually registered onto the SourceDocument, not an absent
    // value the parser/manifest builder would otherwise silently default.
    expect(ctx.handoffCalls[0]!.sourceKey).toBe(ctx.sourceDocumentRows[0]!.sourceKey);
    expect(ctx.handoffCalls[0]!.component).toBe('AF');
    expect(ctx.handoffCalls[0]!.component).toBe(ctx.sourceDocumentRows[0]!.component);

    // ...and the bridge reports full, durable ingestion success — this is the
    // Phase 10B-1 repair's core contract: SOURCE INGESTION COMPLETE, with NO
    // canonical claim attached.
    expect(result.status).toBe('ingested');
    expect(result.parserVerificationSucceeded).toBe(true);
    expect(result.durableEvidencePersisted).toBe(true);
    expect(result.ingestionSucceeded).toBe(true);
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
    expect(result.ingestionSucceeded).toBe(false);
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
    expect(first.ingestionSucceeded).toBe(true);
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1);
    expect(ctx.fetchCalls.n).toBe(1); // the live URL was fetched exactly once (first-time path)

    registerSourceDocumentArchive(ctx, first.sourceDocumentId!, OFFICIAL_BYTES);

    // Replay against the now-'ingested' observation.
    const second = await ctx.bridge.bridge(observation.id);
    expect(second.status).toBe('already_ingested');
    expect(second.sourceDocumentId).toBe(first.sourceDocumentId);
    expect(second.sourceDocumentBound).toBe(true);
    expect(second.ingestionSucceeded).toBe(true);
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
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/review_required/);
    expect(ctx.sourceDocumentRows).toHaveLength(0);
    expect(ctx.fetchCalls.n).toBe(0); // never even fetched — rejected before byte acquisition
  });

  it('blocked observation is rejected, never reaches ingestion', async () => {
    const observation = makeObservation({ observationState: 'blocked' });
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.status).toBe('rejected');
    expect(ctx.sourceDocumentRows).toHaveLength(0);
    expect(ctx.fetchCalls.n).toBe(0);
  });

  it('withdrawn observation is rejected, never reaches ingestion', async () => {
    const observation = makeObservation({ observationState: 'withdrawn' });
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

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
    expect(result.ingestionSucceeded).toBe(true);
    expect(ctx.handoffCalls).toHaveLength(1);
    expect(ctx.handoffCalls[0]!.authorityTrack).toBe('alternative_funding');
  });

  it.each<AuthorityTrack>(['request', 'authorization', 'appropriations'])(
    "'%s' authority track stays isolated: reaches the parser handoff unchanged and never crosses into alternative_funding",
    async (track) => {
      const observation = makeObservation({ classifiedAuthorityTrack: track });
      const cycle = makeCycle({ authorityTrack: track });
      const ctx = buildBridge({
        observation,
        cycle,
        urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      });

      const result = await ctx.bridge.bridge(observation.id);

      expect(result.sourceDocumentBound).toBe(true);
      expect(ctx.handoffCalls).toHaveLength(1);
      expect(ctx.handoffCalls[0]!.authorityTrack).toBe(track);
      expect(ctx.handoffCalls[0]!.authorityTrack).not.toBe('alternative_funding');
    },
  );

  it('source_document_id is only ever bound when the registered document sha256 matches the observation sha256', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(ctx.attachCalls).toHaveLength(1);
    expect(ctx.attachCalls[0]!.sourceDocumentSha256).toBe(
      ctx.attachCalls[0]!.expectedContentSha256,
    );
    expect(ctx.attachCalls[0]!.expectedContentSha256).toBe(OFFICIAL_SHA256);
  });

  it('existing parser/verification handoff is invoked with the registered SourceDocument id and matching SHA (Phase 1-7 gates still execute)', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.parserHandoffInvoked).toBe(true);
    expect(ctx.handoffCalls).toHaveLength(1);
    expect(ctx.handoffCalls[0]!.cycleId).toBe('cycle-1');
    expect(ctx.handoffCalls[0]!.fiscalYear).toBe(2024);
    expect(ctx.handoffCalls[0]!.sourceFamily).toBe('pb_r2');
    // [Phase 10B-31] the registered document's real identity/component reach
    // the handoff too, not just the lifecycle-classification fields above.
    expect(ctx.handoffCalls[0]!.sourceKey).toBe('defense-budget-observation-dedup-obs-1');
    expect(ctx.handoffCalls[0]!.component).toBe('AF');
  });

  it('forwards the optional governed execution object to parser handoff unchanged on first ingestion and replay', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });
    const abortController = new AbortController();
    const governedExecution: NonNullable<ParserHandoffInput['governedExecution']> = {
      executionId: 'manifest-operation-item',
      abortSignal: abortController.signal,
      verificationPersistenceFence: jest.fn(async () => undefined),
      onTerminal: jest.fn(async () => undefined),
    };

    const first = await ctx.bridge.bridge(observation.id, { governedExecution });
    registerSourceDocumentArchive(ctx, first.sourceDocumentId!, OFFICIAL_BYTES);
    await ctx.bridge.bridge(observation.id, { governedExecution });

    expect(ctx.handoffCalls).toHaveLength(2);
    for (const handoff of ctx.handoffCalls) {
      expect(handoff.governedExecution).toBe(governedExecution);
      expect(handoff.governedExecution!.verificationPersistenceFence).toBe(
        governedExecution.verificationPersistenceFence,
      );
      expect(handoff.governedExecution!.onTerminal).toBe(governedExecution.onTerminal);
      expect(handoff.governedExecution!.abortSignal).toBe(abortController.signal);
    }
    expect(ctx.archiveReadSignals).toEqual([abortController.signal]);
  });

  /* ------------------------------------------------------------------ */
  /* Phase 10B-31 repair: sourceKey/component metadata-contract fields   */
  /* ------------------------------------------------------------------ */

  it('[10B-31] a non-default component reaches the handoff unchanged on first ingestion, and the SAME persisted value reaches it again on replay', async () => {
    const observation = makeObservation();
    const expectedSource = makeExpectedSource({ component: 'NAVY' });
    const ctx = buildBridge({
      observation,
      expectedSource,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [{ kind: 'throw', message: 'simulated parser runtime crash' }],
    });

    const first = await ctx.bridge.bridge(observation.id);
    expect(first.sourceDocumentBound).toBe(true);
    // First-time path: reads back the ACTUAL persisted row's component
    // (registered.registry.document.component), not a re-derivation of
    // expectedSource.component -- the two happen to be equal here, but the
    // handoff call proves which one is actually wired.
    expect(ctx.handoffCalls[0]!.component).toBe('NAVY');
    expect(ctx.sourceDocumentRows[0]!.component).toBe('NAVY');

    registerSourceDocumentArchive(ctx, first.sourceDocumentId!, OFFICIAL_BYTES);
    const retry = await ctx.bridge.bridge(observation.id);
    expect(retry.status).toBe('already_ingested');
    // Replay path: reads the component back from the store's
    // loadSourceDocumentArchive record (never re-derived from expectedSource
    // a second time), and it is the SAME real, persisted value.
    expect(ctx.handoffCalls[1]!.component).toBe('NAVY');
    expect(ctx.handoffCalls[1]!.sourceKey).toBe(ctx.handoffCalls[0]!.sourceKey);
  });

  it('[Package 3] preserves an explicit appropriation account through first ingestion and replay', async () => {
    const observation = makeObservation();
    const expectedSource = makeExpectedSource({
      component: 'ARMY',
      account: '2031A: Aircraft Procurement, Army',
    });
    const ctx = buildBridge({
      observation,
      expectedSource,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [{ kind: 'throw', message: 'simulated parser runtime crash' }],
    });

    const first = await ctx.bridge.bridge(observation.id);
    expect(ctx.handoffCalls[0]!.account).toBe('2031A: Aircraft Procurement, Army');
    expect(
      (ctx.sourceDocumentRows[0]!.metadata as Record<string, unknown>).appropriationAccount,
    ).toBe('2031A: Aircraft Procurement, Army');

    registerSourceDocumentArchive(ctx, first.sourceDocumentId!, OFFICIAL_BYTES);
    await ctx.bridge.bridge(observation.id);
    expect(ctx.handoffCalls[1]!.account).toBe('2031A: Aircraft Procurement, Army');
  });

  it('[10B-31] a null component (all-component/committee document) is forwarded as an explicit null, never silently substituted', async () => {
    const observation = makeObservation();
    const expectedSource = makeExpectedSource({ component: null });
    const ctx = buildBridge({
      observation,
      expectedSource,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.ingestionSucceeded).toBe(true);
    expect(ctx.sourceDocumentRows[0]!.component).toBeNull();
    expect(ctx.handoffCalls[0]!.component).toBeNull();
  });

  it('[10B-31] sourceKey reaching the handoff is always the exact "defense-budget-observation-<dedupKey>" identity, matching what was actually registered', async () => {
    const observation = makeObservation({ dedupKey: 'a-very-specific-dedup-key-123' });
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(ctx.handoffCalls[0]!.sourceKey).toBe(
      'defense-budget-observation-a-very-specific-dedup-key-123',
    );
    expect(ctx.handoffCalls[0]!.sourceKey).toBe(ctx.sourceDocumentRows[0]!.sourceKey);
  });

  it('unknown observation id is rejected without any side effects', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

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
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
    });

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
    expect(retry.ingestionSucceeded).toBe(true);
    expect(retry.sourceDocumentId).toBe(ctx.sourceDocumentRows[0]!.id);
    expect(ctx.sourceDocumentRows).toHaveLength(1); // still exactly one logical SourceDocument
    expect(ctx.archiveCalls).toHaveLength(2); // archiveOriginal invoked twice, idempotently, same content
    expect(ctx.archiveCalls[0]!.documentId).toBe(ctx.archiveCalls[1]!.documentId); // same content-addressed key
    expect(ctx.getCurrent().observationState).toBe('ingested');
    expect(ctx.getCurrent().sourceDocumentId).toBe(ctx.sourceDocumentRows[0]!.id);
  });

  it('[repair] attach succeeds, then a transient parser/infra failure occurs: bridge reports non-success (downstream_failed), sourceDocumentBound stays true, retry converges', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [{ kind: 'throw', message: 'simulated parser runtime crash' }],
    });

    const result = await ctx.bridge.bridge(observation.id);

    // The SourceDocument IS bound — that part succeeded and must not be redone.
    expect(result.sourceDocumentBound).toBe(true);
    expect(result.sourceDocumentId).not.toBeNull();
    expect(ctx.getCurrent().observationState).toBe('ingested');

    // But the bridge does NOT report overall success: this was a transient
    // failure, not a resolved verification decision.
    expect(result.status).toBe('downstream_failed');
    expect(result.ingestionSucceeded).toBe(false);
    expect(result.parserVerificationSucceeded).toBe(false);
    expect(result.durableEvidencePersisted).toBe(false);
    expect(result.parserHandoffInvoked).toBe(false);
    expect(result.parserHandoffError).toMatch(/simulated parser runtime crash/);
    expect(result.verifierDecision).toBeNull();

    // Register the archive record a real successful run would have left
    // behind, so the retry can read from it (replay path).
    registerSourceDocumentArchive(ctx, result.sourceDocumentId!, OFFICIAL_BYTES);

    // Retry: parser now succeeds (no more injected failures) and resolves PASS.
    const retry = await ctx.bridge.bridge(observation.id);
    expect(retry.status).toBe('already_ingested');
    expect(retry.ingestionSucceeded).toBe(true);
    expect(retry.sourceDocumentId).toBe(result.sourceDocumentId);
    expect(retry.parserHandoffInvoked).toBe(true);
    // Retry read bytes from the archive, not the live URL, and did not
    // create a second SourceDocument or archive row.
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1);
    expect(ctx.archiveReadCalls).toHaveLength(1);
  });

  it('[repair] verification-persistence failure is treated exactly like any other transient downstream failure: non-success, retryable', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [
        {
          kind: 'throw',
          message:
            'persist_audit mode requires a repository, but no repository was configured: BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT missing',
        },
      ],
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(result.status).toBe('downstream_failed');
    expect(result.ingestionSucceeded).toBe(false);
    expect(result.durableEvidencePersisted).toBe(false);
    expect(result.parserHandoffError).toMatch(/BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT/);

    // The exact missing capability is surfaced, not swallowed into a generic
    // message and not silently retried against an ephemeral-only fallback.
    registerSourceDocumentArchive(ctx, result.sourceDocumentId!, OFFICIAL_BYTES);
    const retry = await ctx.bridge.bridge(observation.id);
    expect(retry.ingestionSucceeded).toBe(true); // once the capability is available, retry converges
  });

  it('[repair] verification REVIEW: governed review disposition, durably persisted, never reported as success and never conflated with a transient failure', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [{ kind: 'decision', decision: 'REVIEW' }],
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(result.parserHandoffInvoked).toBe(true);
    expect(result.parserHandoffError).toBeNull();
    expect(result.verifierDecision).toBe('REVIEW');
    expect(result.status).toBe('review_required');
    expect(result.status).not.toBe('downstream_failed'); // distinguishable from a transient/retryable failure
    expect(result.parserVerificationSucceeded).toBe(false);
    expect(result.ingestionSucceeded).toBe(false);
    // The decision itself WAS durably persisted — this is a resolved,
    // auditable disposition, not evidence loss.
    expect(result.durableEvidencePersisted).toBe(true);
  });

  it('[repair] verification REJECT: deterministic governed disposition, durably persisted, auditable, never silently called success', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [{ kind: 'decision', decision: 'REJECT' }],
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(result.verifierDecision).toBe('REJECT');
    expect(result.status).toBe('verification_rejected');
    expect(result.status).not.toBe('downstream_failed');
    expect(result.parserVerificationSucceeded).toBe(false);
    expect(result.ingestionSucceeded).toBe(false);
    expect(result.durableEvidencePersisted).toBe(true);
  });

  it('[repair] an unresolved terminal decision (UNKNOWN) is treated as retryable, never as a governed REVIEW/REJECT disposition or as success', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [{ kind: 'decision', decision: 'UNKNOWN' }],
    });

    const result = await ctx.bridge.bridge(observation.id);

    expect(result.sourceDocumentBound).toBe(true);
    expect(result.verifierDecision).toBe('UNKNOWN');
    expect(result.status).toBe('downstream_failed');
    expect(result.durableEvidencePersisted).toBe(false);
    expect(result.ingestionSucceeded).toBe(false);
  });

  it('[repair] remote URL changes after registration: retry succeeds from immutable archived bytes, never re-fetches the (now different) live URL', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [{ kind: 'throw', message: 'simulated parser runtime crash' }], // force a downstream failure so a retry is needed
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

    const retry = await ctx.bridge.bridge(observation.id);

    expect(retry.status).toBe('already_ingested');
    expect(retry.sourceDocumentId).toBe(first.sourceDocumentId);
    expect(ctx.fetchCalls.n).toBe(0); // the live URL was NEVER consulted on replay
    expect(ctx.archiveReadCalls).toHaveLength(1);
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1);
  });

  it('[repair] successful retry after a downstream failure produces zero duplicate archive/SourceDocument artifacts', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [{ kind: 'throw', message: 'simulated parser runtime crash' }],
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
    // Parser handoff is invoked once per attempt (at-least-once semantics —
    // never skipped, never accidentally coalesced across attempts).
    expect(ctx.sourceDocumentRows).toHaveLength(1);
    expect(ctx.archiveCalls).toHaveLength(1); // first-time path only; replay never re-archives
    expect(ctx.handoffCalls).toHaveLength(3); // first (failed) + second + third, each a real invocation
  });

  it('[repair] archived bytes SHA mismatch on replay (corruption) refuses to parse rather than silently promoting mismatched bytes', async () => {
    const observation = makeObservation();
    const ctx = buildBridge({
      observation,
      urlBytes: new Map([[observation.discoveredUrl, OFFICIAL_BYTES]]),
      parserHandoffScript: [{ kind: 'throw', message: 'simulated parser runtime crash' }],
    });

    const first = await ctx.bridge.bridge(observation.id);
    expect(first.status).toBe('downstream_failed');

    // Simulate archive corruption: the stored archive record now points at
    // bytes that do NOT match the observation's content_sha256.
    registerSourceDocumentArchive(ctx, first.sourceDocumentId!, CHANGED_BYTES);

    const retry = await ctx.bridge.bridge(observation.id);
    expect(retry.status).toBe('downstream_failed');
    expect(retry.sourceDocumentBound).toBe(true); // still bound — the SourceDocument itself is fine
    expect(retry.reason).toMatch(
      /does not match the observation's content_sha256|refusing to parse/,
    );
    // The corrupted bytes were never handed to the parser.
    expect(ctx.handoffCalls).toHaveLength(1); // only the first attempt's (failed) call
  });

  /* ------------------------------------------------------------------ */
  /* Phase 10B-1 repair: canonical promotion is out of scope, structurally */
  /* ------------------------------------------------------------------ */

  it('[repair] the bridge constructor takes exactly 5 ports — no canonical-projection dependency exists to inject', () => {
    expect(ObservationIngestionBridgeService.length).toBe(5);
  });

  it('[repair] canonical promotion is never invoked from this bridge: no import, no type reference, no env-var read of canonical-promotion machinery in actual code (doc-comment mentions of WHY it is out of scope are expected and fine)', () => {
    const sourceFiles = [
      'observation-ingestion-bridge.service.ts',
      'observation-ingestion-bridge.ports.ts',
      'default-parser-handoff.adapter.ts',
    ];
    for (const file of sourceFiles) {
      const contents = fs.readFileSync(path.join(__dirname, file), 'utf8');
      const codeLines = contents.split('\n').filter((line) => !/^\s*(\/\*|\*|\/\/)/.test(line)); // strip comment-only lines
      const code = codeLines.join('\n');
      // No import/require of canonical-promotion machinery.
      expect(code).not.toMatch(/from ['"].*promotion/);
      expect(code).not.toMatch(/DefenseBudgetCanonicalPromotionServiceV1/);
      // No CanonicalProjectionPort type declared, exported, or used as a
      // parameter/property type (the actual injectable seam PR #1249
      // originally added and this repair removes).
      expect(code).not.toMatch(/CanonicalProjectionPort/);
      expect(code).not.toMatch(/CanonicalProjectionInput/);
      expect(code).not.toMatch(/CanonicalProjectionOutcome/);
      // No read of the promoter-role credential.
      expect(code).not.toMatch(/PROMOTER_DATABASE_URL/);
    }
    // The bridge's constructor takes exactly 5 ports (store, fetcher,
    // registrar, parserHandoff, archiveReader) — no 6th canonical-projection
    // dependency to inject.
    expect(ObservationIngestionBridgeService.length).toBe(5);
    // The old boundary-missing adapter file must not exist in the active
    // ingestion path at all — deleted, not merely unreferenced.
    expect(
      fs.existsSync(
        path.join(__dirname, 'phase10b1-canonical-projection-boundary-missing.adapter.ts'),
      ),
    ).toBe(false);
  });
});
