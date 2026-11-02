/**
 * Package 5 projection bridge.
 *
 * Reads already-synced SAM.gov and USAspending rows and appends source-qualified
 * acquisition continuity revisions. It performs no network calls. Writes require
 * both --commit and PROGRAM_ACQUISITION_CONTINUITY_ENABLED=true; otherwise the
 * command is an inventory-only dry run.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { openSync, readSync, closeSync } from 'node:fs';
import { runPrismaTransaction } from '../src/prisma/prisma-transaction-deadline.js';
import {
  awardEnrichmentFileArgument, continuityWritesEnabled as writesEnabled, enrichAwardCohort,
  MAX_ENRICHMENT_FILE_BYTES, parseAwardEnrichmentFile,
  validateAwardEnrichmentIds, type AwardEnrichmentSnapshot, type AwardEnrichmentHead, type AwardEnrichmentReceipt,
} from './lib/procurement-award-enrichment.js';
import {
  AcquisitionContinuityStore,
  acquisitionRecordKindFromNoticeType,
} from '../src/program-element/acquisition-continuity/acquisition-continuity.store.js';

interface ProjectionSummary {
  mode: 'DRY_RUN' | 'COMMIT';
  cap: number;
  sam: { examined: number; records: number; relationships: number; continuation: ContinuationEvidence };
  awards: { examined: number; records: number; relationships: number; coverageGaps: number; continuation: ContinuationEvidence };
}

export type ContinuityStream = 'sam' | 'awards';

interface CursorPayload {
  v: 1;
  stream: ContinuityStream;
  afterId: string;
  throughId: string;
}

export interface ContinuationEvidence {
  hasMore: boolean;
  inputCursor: string | null;
  nextCursor: string | null;
  afterId: string | null;
  throughId: string | null;
  firstId: string | null;
  lastId: string | null;
}

export interface BoundedContinuityPage<T extends { id: string }> {
  items: T[];
  continuation: ContinuationEvidence;
}

interface StreamCheckpoint {
  complete: boolean;
  cursor: string | null;
  throughId: string | null;
}

interface ProjectorCheckpoint {
  version: 1;
  sam: StreamCheckpoint;
  awards: StreamCheckpoint;
}

const PROJECTOR_SYNC_SOURCE = 'program_acquisition_continuity_projector';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function encodeContinuityCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeContinuityCursor(value: string, expectedStream: ContinuityStream): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (
      parsed.v !== 1 ||
      parsed.stream !== expectedStream ||
      !isUuid(parsed.afterId) ||
      !isUuid(parsed.throughId) ||
      parsed.afterId > parsed.throughId
    ) throw new Error('cursor shape mismatch');
    return parsed as CursorPayload;
  } catch {
    throw new Error(`Invalid or stream-mismatched ${expectedStream} continuation cursor`);
  }
}

/** Read one deterministic ID-ordered slice bounded by the source maximum seen at walk start. */
export async function readBoundedContinuityPage<T extends { id: string }>(input: {
  stream: ContinuityStream;
  cap: number;
  cursor?: string;
  skip?: { throughId: string | null };
  readHighWater: () => Promise<string | null>;
  findPage: (range: { gt?: string; lte: string }, take: number) => Promise<T[]>;
}): Promise<BoundedContinuityPage<T>> {
  if (!Number.isInteger(input.cap) || input.cap < 1 || input.cap > 5_000) {
    throw new Error('cap must be an integer between 1 and 5000');
  }
  if (input.skip) {
    return {
      items: [],
      continuation: {
        hasMore: false, inputCursor: null, nextCursor: null,
        afterId: null, throughId: input.skip.throughId, firstId: null, lastId: null,
      },
    };
  }
  const decoded = input.cursor ? decodeContinuityCursor(input.cursor, input.stream) : null;
  const throughId = decoded?.throughId ?? await input.readHighWater();
  if (throughId == null) {
    return {
      items: [],
      continuation: {
        hasMore: false, inputCursor: input.cursor ?? null, nextCursor: null,
        afterId: decoded?.afterId ?? null, throughId: null, firstId: null, lastId: null,
      },
    };
  }
  if (!isUuid(throughId)) throw new Error('source high-water ID is not a UUID');
  const range: { gt?: string; lte: string } = { lte: throughId };
  if (decoded) range.gt = decoded.afterId;
  const fetched = await input.findPage(range, input.cap + 1);
  const hasMore = fetched.length > input.cap;
  const items = fetched.slice(0, input.cap);
  const firstId = items[0]?.id ?? null;
  const lastId = items.at(-1)?.id ?? null;
  const nextCursor = hasMore && lastId
    ? encodeContinuityCursor({ v: 1, stream: input.stream, afterId: lastId, throughId })
    : null;
  return {
    items,
    continuation: {
      hasMore, inputCursor: input.cursor ?? null, nextCursor,
      afterId: decoded?.afterId ?? null, throughId, firstId, lastId,
    },
  };
}

export function readProjectorCheckpoint(stats: unknown): ProjectorCheckpoint | null {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
  const checkpoint = (stats as Record<string, unknown>).continuationCheckpoint;
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return null;
  const value = checkpoint as Partial<ProjectorCheckpoint>;
  const validStream = (candidate: unknown): candidate is StreamCheckpoint => {
    if (!candidate || typeof candidate !== 'object') return false;
    const stream = candidate as Partial<StreamCheckpoint>;
    return typeof stream.complete === 'boolean' &&
      (stream.cursor === null || typeof stream.cursor === 'string') &&
      (stream.throughId === null || isUuid(stream.throughId));
  };
  return value.version === 1 && validStream(value.sam) && validStream(value.awards)
    ? value as ProjectorCheckpoint
    : null;
}

function streamCheckpoint<T extends { id: string }>(page: BoundedContinuityPage<T>): StreamCheckpoint {
  return {
    complete: !page.continuation.hasMore,
    cursor: page.continuation.nextCursor,
    throughId: page.continuation.throughId,
  };
}

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function capFromArgs(): number {
  const value = Number(arg('cap') ?? 100);
  if (!Number.isInteger(value) || value < 1 || value > 5_000) {
    throw new Error('--cap must be an integer between 1 and 5000');
  }
  return value;
}

export { writesEnabled };

export async function projectFiniteAwardEnrichment(
  prisma: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
  options: { awardIds: readonly string[]; commit: boolean; env?: NodeJS.ProcessEnv },
) {
  validateAwardEnrichmentIds(options.awardIds);
  const readAndAppend = (client: Pick<PrismaClient, '$queryRaw'>) => {
    const store = new AcquisitionContinuityStore(client as never);
    return enrichAwardCohort({
      readAwards: (ids) => client.$queryRaw<AwardEnrichmentSnapshot[]>`
      SELECT award_unique_id AS "awardUniqueId", piid, source_record_jsonb AS "sourceRecord",
        to_char(last_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceObservedAt"
      FROM public.federal_award WHERE award_unique_id = ANY(${[...ids]}::text[])
      ORDER BY award_unique_id COLLATE "C" LIMIT 26
    `,
      readHeads: (keys) => client.$queryRaw<AwardEnrichmentHead[]>`
      WITH scoped AS MATERIALIZED (
        SELECT identity_key, source_record_id, recorded_at, source_observed_at, raw_jsonb
        FROM public.acquisition_record_revision
        WHERE identity_key = ANY(${[...keys]}::text[]) AND source_system = 'usaspending' AND record_kind = 'award'
          AND jsonb_typeof(raw_jsonb->'generated_internal_id') = 'string'
          AND jsonb_typeof(raw_jsonb->'Award ID') = 'string'
          AND raw_jsonb->>'generated_internal_id' = source_record_id
          AND raw_jsonb->>'Award ID' = split_part(source_record_id, '_', 3)
          AND identity_key = 'usaspending|award|' || source_record_id
      ), clocks AS (SELECT identity_key, max(recorded_at) AS latest FROM scoped GROUP BY identity_key)
      SELECT r.identity_key AS "identityKey", r.raw_jsonb AS "sourceRecord",
        to_char(r.source_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceObservedAt",
        to_char(r.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt"
      FROM scoped r JOIN clocks c ON c.identity_key = r.identity_key AND c.latest = r.recorded_at
      ORDER BY r.identity_key COLLATE "C" LIMIT 26
    `,
      appendRecord: (input) => store.appendRecord(input),
    }, options);
  };
  const enabled = writesEnabled(options.commit, options.env);
  let staged: AwardEnrichmentReceipt | undefined;
  try {
    return await runPrismaTransaction<AwardEnrichmentReceipt>(
      (work, engine) => prisma.$transaction(work, engine),
      async (tx) => {
        if (!enabled) return;
        await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
        // Standard table locking blocks every concurrent catalog writer, including older producers.
        // Re-read and validate heads after the lock, under READ COMMITTED rather than an older snapshot.
        await tx.$executeRaw`LOCK TABLE public.acquisition_record_revision IN SHARE ROW EXCLUSIVE MODE`;
      },
      async (tx) => {
        staged = await readAndAppend(tx);
        if (staged.status === 'WRITE_OUTCOME_UNRESOLVED') throw new Error('Finite catalog append failed');
        return staged;
      },
      { timeoutMs: 15000, deadline: { at: Date.now() + 15000 }, readOnly: !enabled,
        isolationLevel: enabled ? 'ReadCommitted' : 'RepeatableRead' },
    );
  } catch (error) {
    if (!enabled || !staged || staged.status === 'REFUSED') throw error;
    // A transaction rejection can include a lost COMMIT acknowledgement. Neither staged rows nor rollback
    // are asserted durable here; the same attempt must be reconciled by its executor before any retry.
    return { ...staged, status: 'TRANSACTION_OUTCOME_UNRESOLVED', inserted: null, existing: null,
      outcomes: staged.outcomes.map((outcome) => outcome.state === 'inserted' || outcome.state === 'existing'
        ? { ...outcome, state: 'write_outcome_unresolved' as const } : outcome) };
  }
}

export async function projectProgramAcquisitionContinuity(
  prisma: PrismaClient,
  options: { commit: boolean; cap: number; samCursor?: string; awardsCursor?: string },
): Promise<ProjectionSummary> {
  const enabled = writesEnabled(options.commit);
  const store = new AcquisitionContinuityStore(prisma as never);
  const previousRun = await prisma.syncRun.findFirst({
    where: { source: PROJECTOR_SYNC_SOURCE, status: 'success' },
    orderBy: { startedAt: 'desc' },
    select: { stats: true },
  });
  const previousCheckpoint = readProjectorCheckpoint(previousRun?.stats);
  const previousCycleComplete = !!previousCheckpoint?.sam.complete && !!previousCheckpoint.awards.complete;
  const resumePriorCycle = !!previousCheckpoint && !previousCycleComplete;
  const skipSamFromCheckpoint = resumePriorCycle && previousCheckpoint!.sam.complete && !options.samCursor;
  const skipAwardsFromCheckpoint = resumePriorCycle && previousCheckpoint!.awards.complete && !options.awardsCursor;
  const samCursor = options.samCursor ?? (resumePriorCycle ? previousCheckpoint!.sam.cursor ?? undefined : undefined);
  const awardsCursor = options.awardsCursor ?? (resumePriorCycle ? previousCheckpoint!.awards.cursor ?? undefined : undefined);
  const summary: ProjectionSummary = {
    mode: enabled ? 'COMMIT' : 'DRY_RUN',
    cap: options.cap,
    sam: { examined: 0, records: 0, relationships: 0, continuation: {
      hasMore: false, inputCursor: null, nextCursor: null, afterId: null, throughId: null, firstId: null, lastId: null,
    } },
    awards: { examined: 0, records: 0, relationships: 0, coverageGaps: 0, continuation: {
      hasMore: false, inputCursor: null, nextCursor: null, afterId: null, throughId: null, firstId: null, lastId: null,
    } },
  };

  const samPage = await readBoundedContinuityPage({
    stream: 'sam',
    cap: options.cap,
    cursor: samCursor,
    ...(skipSamFromCheckpoint ? { skip: { throughId: previousCheckpoint!.sam.throughId } } : {}),
    readHighWater: async () =>
      (await prisma.samOpportunity.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id ?? null,
    findPage: (range, take) =>
      prisma.samOpportunity.findMany({
        where: { id: range },
        take,
        orderBy: [{ id: 'asc' }],
        select: {
          id: true,
          noticeId: true,
          solicitationNumber: true,
          title: true,
          noticeType: true,
          agency: true,
          office: true,
          postedDate: true,
          responseDeadline: true,
          archiveDate: true,
          active: true,
          sourceUrl: true,
          lastSyncedAt: true,
          updatedAt: true,
          raw: true,
          matches: {
            where: { reviewStatus: { in: ['accepted', 'candidate'] } },
            select: { programId: true, peCode: true, matchBasis: true, confidence: true, reviewStatus: true },
          },
        },
      }),
  });
  const notices = samPage.items;
  summary.sam.continuation = samPage.continuation;
  summary.sam.examined = notices.length;
  for (const notice of notices) {
    summary.sam.records += 1;
    summary.sam.relationships += notice.matches.filter((match) => match.programId || match.peCode).length;
    if (!enabled) continue;
    const record = await store.appendRecord({
      source: 'sam_gov',
      sourceRecordId: notice.noticeId,
      noticeId: notice.noticeId,
      recordKind: acquisitionRecordKindFromNoticeType(notice.noticeType),
      title: notice.title,
      status: notice.active ? 'active' : 'archived',
      buyerOffice: notice.office ?? notice.agency,
      postedAt: notice.postedDate?.toISOString() ?? null,
      responseDeadline: notice.responseDeadline?.toISOString() ?? null,
      validTo: notice.archiveDate?.toISOString() ?? null,
      sourceUrl: notice.sourceUrl,
      sourceVersion: notice.updatedAt.toISOString(),
      sourceObservedAt: notice.lastSyncedAt.toISOString(),
      raw: notice.raw as Record<string, unknown>,
    });
    for (const match of notice.matches) {
      const subject = match.programId
        ? { subjectKind: 'program' as const, subjectKey: match.programId }
        : match.peCode
          ? { subjectKind: 'pe' as const, subjectKey: match.peCode }
          : null;
      if (!subject) continue;
      await store.appendRelationship({
        ...subject,
        acquisitionIdentityKey: record.identityKey!,
        relationshipClass: 'reviewed_association',
        sourceSystem: 'sam_gov',
        sourceRecordId: notice.noticeId,
        reviewStatus: match.reviewStatus === 'accepted' ? 'accepted' : 'candidate',
        sourceUrl: notice.sourceUrl,
        sourceVersion: notice.updatedAt.toISOString(),
        sourceObservedAt: notice.lastSyncedAt.toISOString(),
        evidence: [{ kind: match.matchBasis, sourceNativeId: notice.noticeId, sourceUrl: notice.sourceUrl }],
        confidence: match.confidence,
        coverageState: 'complete',
      });
    }
  }

  const awardPage = await readBoundedContinuityPage({
    stream: 'awards',
    cap: options.cap,
    cursor: awardsCursor,
    ...(skipAwardsFromCheckpoint ? { skip: { throughId: previousCheckpoint!.awards.throughId } } : {}),
    readHighWater: async () =>
      (await prisma.federalAward.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id ?? null,
    findPage: (range, take) =>
      prisma.federalAward.findMany({
        where: { id: range },
        take,
        orderBy: [{ id: 'asc' }],
        select: {
          id: true,
          awardUniqueId: true,
          piid: true,
          contractorName: true,
          awardingAgency: true,
          awardingSubTier: true,
          description: true,
          peCode: true,
          peCodeSource: true,
          peCodeConfidence: true,
          dodAcqProgramCode: true,
          actionDate: true,
          awardedAt: true,
          latestActionDate: true,
          sourceLastModifiedDate: true,
          popStartDate: true,
          popEndDate: true,
          sourceRecord: true,
          raw: true,
          lastSyncedAt: true,
        },
      }),
  });
  const awards = awardPage.items;
  summary.awards.continuation = awardPage.continuation;
  summary.awards.examined = awards.length;
  const mdapCodes = [...new Set(awards.map((award) => award.dodAcqProgramCode).filter((value): value is string => !!value))];
  const programs = mdapCodes.length === 0
    ? []
    : await prisma.program.findMany({ where: { mdapCode: { in: mdapCodes } }, select: { id: true, mdapCode: true } });
  const programIdsByMdap = new Map<string, string[]>();
  for (const program of programs) {
    if (!program.mdapCode) continue;
    programIdsByMdap.set(program.mdapCode, [...(programIdsByMdap.get(program.mdapCode) ?? []), program.id]);
  }

  for (const award of awards) {
    summary.awards.records += 1;
    const subjects = [
      ...(award.peCode ? [{ subjectKind: 'pe' as const, subjectKey: award.peCode }] : []),
      ...((award.dodAcqProgramCode ? programIdsByMdap.get(award.dodAcqProgramCode) : []) ?? [])
        .map((programId) => ({ subjectKind: 'program' as const, subjectKey: programId })),
    ];
    summary.awards.relationships += subjects.length;
    summary.awards.coverageGaps += subjects.length * 2;
    if (!enabled) continue;
    const record = await store.appendRecord({
      source: 'usaspending',
      sourceRecordId: award.awardUniqueId,
      generatedAwardId: award.awardUniqueId,
      recordKind: 'award',
      title: award.description ?? award.contractorName,
      status: 'current_summary',
      buyerOffice: award.awardingSubTier ?? award.awardingAgency,
      postedAt: award.awardedAt?.toISOString() ?? award.actionDate?.toISOString() ?? null,
      validFrom: award.popStartDate?.toISOString() ?? null,
      validTo: award.popEndDate?.toISOString() ?? null,
      sourceVersion: award.sourceLastModifiedDate?.toISOString() ?? award.latestActionDate?.toISOString() ?? null,
      sourceObservedAt: award.lastSyncedAt.toISOString(),
      raw: (award.sourceRecord ?? award.raw) as Record<string, unknown>,
    });
    const highConfidence = ['dod_acquisition_program', 'uei_confirmed_r3_prime'].includes(award.peCodeSource ?? '');
    for (const subject of subjects) {
      await store.appendRelationship({
        ...subject,
        acquisitionIdentityKey: record.identityKey!,
        relationshipClass: highConfidence ? 'reviewed_association' : 'inferred_relevance',
        sourceSystem: 'usaspending',
        sourceRecordId: award.awardUniqueId,
        reviewStatus: highConfidence ? 'accepted' : 'candidate',
        sourceVersion: award.sourceLastModifiedDate?.toISOString() ?? null,
        sourceObservedAt: award.lastSyncedAt.toISOString(),
        evidence: [{
          kind: award.peCodeSource ?? 'unqualified_current_attribution',
          sourceNativeId: award.awardUniqueId,
          quote: award.description,
        }],
        confidence: award.peCodeConfidence ?? (highConfidence ? 0.9 : 0.5),
        coverageState: 'partial',
      });
      await store.upsertCoverageGap({
        ...subject,
        sourceSystem: 'usaspending',
        relationshipKind: 'award_to_program_financial_allocation',
        reason: 'allocation_not_supported',
        detail: 'The association does not prove dollars allocated to this program; File C is not a universal PE crosswalk.',
        coverageState: 'unsupported',
        sourceAsOf: award.sourceLastModifiedDate?.toISOString() ?? null,
        observedAt: award.lastSyncedAt.toISOString(),
      });
      await store.upsertCoverageGap({
        ...subject,
        sourceSystem: 'usaspending',
        relationshipKind: 'award_transaction_history',
        reason: 'transaction_history_not_ingested',
        detail: 'The current award summary is present, but signed modifications/corrections require a qualified transaction source.',
        coverageState: 'partial',
        sourceAsOf: award.latestActionDate?.toISOString() ?? null,
        observedAt: award.lastSyncedAt.toISOString(),
      });
    }
  }

  if (enabled) {
    await prisma.syncRun.create({
      data: {
        source: PROJECTOR_SYNC_SOURCE,
        startedAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
        rowsInserted: summary.sam.records + summary.awards.records,
        rowsUpdated: 0,
        errorCount: 0,
        stats: JSON.parse(JSON.stringify({
          continuationCheckpoint: {
            version: 1,
            sam: options.samCursor || !resumePriorCycle || !skipSamFromCheckpoint
              ? streamCheckpoint(samPage)
              : previousCheckpoint!.sam,
            awards: options.awardsCursor || !resumePriorCycle || !skipAwardsFromCheckpoint
              ? streamCheckpoint(awardPage)
              : previousCheckpoint!.awards,
          },
          sam: summary.sam,
          awards: summary.awards,
        })) as Prisma.InputJsonValue,
      },
    });
  }
  return summary;
}

export async function runProgramAcquisitionContinuityCli(createClient: () => PrismaClient = () => new PrismaClient()): Promise<void> {
  if (flag('help')) {
    console.log('Usage: sync-program-acquisition-continuity [--cap 1..5000] [--sam-cursor cursor] [--awards-cursor cursor] [--commit]\n'
      + '       sync-program-acquisition-continuity --award-ids-file <JSON array of 1..25 full award IDs> [--commit]\n'
      + 'Finite mode reads existing source snapshots only. Writes require --commit and PROGRAM_ACQUISITION_CONTINUITY_ENABLED=true.\n'
      + 'Exit 0: completed/read-only validation; 1: failure or unknown write outcome; 2: missing configuration or finite cohort refusal.');
    return;
  }
  const file = awardEnrichmentFileArgument(process.argv.slice(2));
  let awardIds: string[] | null = null;
  if (file !== null) {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_ENRICHMENT_FILE_BYTES + 1);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      awardIds = parseAwardEnrichmentFile(buffer.subarray(0, bytes).toString('utf8'));
    } finally { closeSync(fd); }
  }
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-program-acquisition-continuity.ts requires DATABASE_URL (database configuration is required)');
    process.exitCode = 2;
    return;
  }
  const prisma = createClient();
  try {
    await prisma.$connect();
    const summary = awardIds ? await projectFiniteAwardEnrichment(prisma, { awardIds, commit: flag('commit') })
      : await projectProgramAcquisitionContinuity(prisma, {
      commit: flag('commit'),
      cap: capFromArgs(),
      samCursor: arg('sam-cursor'),
      awardsCursor: arg('awards-cursor'),
    });
    console.log(JSON.stringify(summary, null, 2));
    if ('status' in summary && summary.status === 'REFUSED') process.exitCode = 2;
    if ('status' in summary && (summary.status === 'WRITE_OUTCOME_UNRESOLVED' || summary.status === 'TRANSACTION_OUTCOME_UNRESOLVED')) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const direct = typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
if (direct) {
  void runProgramAcquisitionContinuityCli().catch((error) => {
    console.error('[sync-program-acquisition-continuity] FAILED', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
