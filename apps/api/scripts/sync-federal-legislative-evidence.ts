/** @cleanup-smoke noArgsExit=2 */
/**
 * Package 4 federal legislative evidence worker.
 *
 * Frozen GovInfo windows, credential-free qualified continuations, per-item
 * durable cursor commits, a 48-hour incremental overlap, and complete full-run
 * removal reconciliation. Dry-run is the default and performs no source calls.
 */
import { randomUUID } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../src/config/config.schema.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  GovInfoService,
  type FederalEvidenceCollection,
} from '../src/external/govinfo/govinfo.service.js';
import {
  persistFederalEvidenceRemoval,
  persistFederalEvidenceSnapshot,
  replayPendingFederalEvidenceMentions,
} from '../src/program-element/federal-evidence/persistence.js';
import { runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import { FEDERAL_FY26_SQL } from '../src/ingestion/bill-text-scope.js';
import { withFederalBillWriter } from '../src/ingestion/federal-bill-writer.js';
import {
  FY26_YEAR,
  fiscalYearMode,
  fy26ScopedSuffix,
  type FiscalYearMode,
} from '../src/ingestion/bill-fy26-admission.js';
import { assertFullFederalEvidenceReconciliationSafe } from './lib/federal-legislative-sync-safety.js';

dotenvConfig();

const ALLOWED_COLLECTIONS = new Set<FederalEvidenceCollection>([
  'BILLS',
  'CRPT',
  'CPRT',
  'PLAW',
  'CREC',
]);
const DEFAULT_CAP = 100;
const OVERLAP_MS = 48 * 60 * 60 * 1000;

interface Cursor {
  since: string;
  until: string;
  next: string | null;
  offset: number;
  full: boolean;
}

interface CheckpointRow {
  cursor: Cursor | null;
  status: string;
  completedAt: Date | null;
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function billIdentity(packageId: string): {
  billId: string | null;
  versionCode: string | null;
  lineageKey: string;
} {
  const match = /^BILLS-(\d+)([a-z]+)(\d+)([a-z]+)$/i.exec(packageId);
  if (!match) return { billId: null, versionCode: null, lineageKey: packageId };
  const congress = match[1]!;
  const billType = match[2]!.toLowerCase();
  const number = match[3]!;
  const versionCode = match[4]!.toLowerCase();
  const billId = `${congress}-${billType}-${number}`;
  const chamber = billType.startsWith('h')
    ? 'house'
    : billType.startsWith('s')
      ? 'senate'
      : 'joint';
  return { billId, versionCode, lineageKey: `${billId}:${chamber}` };
}

function sourceKey(packageId: string): string {
  return `govinfo:${packageId}`;
}

function checkpointSourceFor(
  collection: FederalEvidenceCollection,
  congress: number,
  full: boolean,
  scopedSuffix = '',
): string {
  return `govinfo-federal:${full ? 'full' : 'incremental'}:${collection}:${congress}${scopedSuffix}`;
}

async function recordCoverageGap(
  prisma: PrismaService,
  collection: FederalEvidenceCollection,
  packageId: string,
  reason: string,
  detail: string,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO federal_evidence_coverage_gap(source_key, package_id, collection, reason, detail)
    VALUES (${sourceKey(packageId)}, ${packageId}, ${collection}, ${reason}, ${detail.slice(0, 4000)})
    ON CONFLICT (source_key, reason) DO UPDATE
      SET detail = EXCLUDED.detail, last_observed_at = clock_timestamp(), resolved_at = NULL`;
}

export async function syncCollection(args: {
  prisma: PrismaService;
  gov: GovInfoService;
  collection: FederalEvidenceCollection;
  congress: number;
  full: boolean;
  historical: boolean;
  cap: number;
  /** Non-null only for the FY26 BILLS scope (SCRUM-247). */
  fy26: FiscalYearMode;
}): Promise<RunCounts & { complete: boolean; coverageGaps: number; pendingUnknown: number }> {
  const { prisma, gov, collection, congress, full, historical, cap, fy26 } = args;
  // Incremental and full reconciliation keep independent resumable cursors so
  // an hourly run cannot overwrite a capped/failed full-corpus page (or vice
  // versa). Only complete full inventories participate in removal detection.
  // FY26 reuses the same scoped namespace with a :fy26 suffix so an existing
  // all-session baseline can never mark this bounded work as already done.
  const scopeSuffix = fy26ScopedSuffix(fy26);
  const checkpointSource = checkpointSourceFor(collection, congress, full, scopeSuffix);
  const inventorySource = `govinfo-federal-inventory:${collection}:${congress}${scopeSuffix}`;
  // FY26 admission is a PARENT-bill gate resolved once before any provider
  // text request, so an excluded package costs neither a provider call nor a
  // snapshot write. Non-BILLS collections pass fy26 = null and are untouched.
  const eligibleBillIds =
    fy26 === FY26_YEAR
      ? new Set(
          (
            await prisma.$queryRawUnsafe<Array<{ id: string }>>(
              `SELECT b.id FROM congress_bill b WHERE ${FEDERAL_FY26_SQL}`,
            )
          ).map((row) => row.id),
        )
      : null;
  const leaseToken = randomUUID();
  const claimed = await prisma.$queryRaw<CheckpointRow[]>`
    INSERT INTO federal_evidence_checkpoint(source, status, lease_token, lease_until)
    VALUES (${checkpointSource}, 'running', ${leaseToken}::uuid, clock_timestamp() + interval '15 minutes')
    ON CONFLICT (source) DO UPDATE
      SET status = 'running', lease_token = EXCLUDED.lease_token,
          lease_until = EXCLUDED.lease_until, updated_at = clock_timestamp()
      WHERE federal_evidence_checkpoint.lease_until IS NULL
         OR federal_evidence_checkpoint.lease_until < clock_timestamp()
    RETURNING cursor_jsonb AS cursor, status, completed_at AS "completedAt"`;
  if (!claimed[0]) {
    if (fy26 !== null) throw Error('FY26_FEDERAL_TEXT_LEASE_NOT_ACQUIRED');
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      complete: false,
      coverageGaps: 0,
      pendingUnknown: 0,
    };
  }

  const old = claimed[0];
  const priorCursorWasComplete = Boolean(
    old.cursor &&
    old.completedAt &&
    old.cursor.next === null &&
    old.cursor.offset === 0 &&
    old.completedAt.toISOString().replace(/\.\d+Z$/, 'Z') ===
      old.cursor.until.replace(/\.\d+Z$/, 'Z'),
  );
  const resume = Boolean(old.cursor && !priorCursorWasComplete && old.cursor.full === full);
  const cursor: Cursor = resume
    ? old.cursor!
    : {
        since: full
          ? '1970-01-01T00:00:00Z'
          : new Date((old.completedAt?.getTime() ?? Date.now()) - OVERLAP_MS).toISOString(),
        until: new Date().toISOString(),
        next: null,
        offset: 0,
        full,
      };
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let coverageGaps = 0;
  let pendingUnknown = 0;
  let processed = 0;
  let complete = false;
  try {
    while (processed < cap) {
      const page = await gov.listFederalEvidencePage(
        collection,
        congress,
        cursor.since,
        cursor.until,
        cursor.next,
      );
      for (; cursor.offset < page.packages.length && processed < cap; cursor.offset += 1) {
        const row = page.packages[cursor.offset]!;
        processed += 1;
        if (row.congress != null && Number(row.congress) !== congress) {
          skipped += 1;
          continue;
        }
        // Cap counts every inspected package, so a bounded run still ends even
        // when most pages are outside the FY26 parent scope.
        const identity = billIdentity(row.packageId);
        if (eligibleBillIds && (!identity.billId || !eligibleBillIds.has(identity.billId))) {
          skipped += 1;
          continue;
        }
        const key = sourceKey(row.packageId);
        if (full) {
          await prisma.$executeRaw`
            INSERT INTO federal_evidence_inventory_member(
              inventory_source, source_key, package_id, last_seen_window_end
            ) VALUES (${inventorySource}, ${key}, ${row.packageId}, ${new Date(cursor.until)})
            ON CONFLICT (inventory_source, source_key) DO UPDATE
              SET package_id = EXCLUDED.package_id,
                  last_seen_window_end = EXCLUDED.last_seen_window_end,
                  updated_at = clock_timestamp()`;
        }
        let doc: Awaited<ReturnType<GovInfoService['getFederalPackageText']>>;
        try {
          doc = fy26 === FY26_YEAR
            ? await gov.getFederalPackageText(row.packageId, { retainOriginalBytes: true })
            : await gov.getFederalPackageText(row.packageId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/No qualified text available|Empty federal text/i.test(message)) {
            await recordCoverageGap(
              prisma,
              collection,
              row.packageId,
              'qualified_text_unavailable',
              message,
            );
            coverageGaps += 1;
            continue;
          }
          throw error;
        }
        const result = await persistFederalEvidenceSnapshot(prisma, {
          provider: 'govinfo',
          collection,
          packageId: row.packageId,
          billId: identity.billId,
          versionCode: identity.versionCode,
          lineageKey: identity.lineageKey,
          sourceUrl: doc.sourceUrl,
          sourceModifiedAt: parseDate(doc.lastModified ?? row.lastModified),
          publishedAt: parseDate(doc.dateIssued ?? row.dateIssued),
          rawContent: doc.raw,
          originalBytes: doc.originalBytes,
          capture: doc.capture,
          extractedText: doc.text,
          completeness: doc.completeness ?? 'complete',
          inventoryWindowEnd: new Date(cursor.until),
          observationKey: `${checkpointSource}:${cursor.until}:${row.packageId}:${doc.lastModified ?? row.lastModified ?? 'unversioned'}:${doc.capture?.version ?? doc.originalBytes?.sha256 ?? 'unqualified'}`,
          historical,
          metadata: {
            title: doc.title ?? row.title ?? null,
            format: doc.format,
            extractionWarnings: doc.extractionWarnings ?? [],
            ...(doc.billStructure ? { billStructure: doc.billStructure } : {}),
            providerCollection: doc.collection,
            discoveryWindow: { since: cursor.since, until: cursor.until },
          },
        });
        if (result.revisionInserted) inserted += 1;
        else if (result.observationInserted) updated += 1;
        else skipped += 1;
        pendingUnknown += result.pendingUnknownCodes.length;
      }
      if (cursor.offset >= page.packages.length) {
        cursor.next = page.nextPage;
        cursor.offset = 0;
        if (!cursor.next) complete = true;
      }
      const saved = await prisma.$executeRaw`
        UPDATE federal_evidence_checkpoint
           SET cursor_jsonb = ${JSON.stringify(cursor)}::jsonb,
               window_start = ${new Date(cursor.since)}, window_end = ${new Date(cursor.until)},
               status = ${complete ? 'completed' : 'running'},
               completed_at = ${complete ? new Date(cursor.until) : null},
               last_error = NULL, lease_until = clock_timestamp() + interval '15 minutes',
               updated_at = clock_timestamp()
         WHERE source = ${checkpointSource} AND lease_token = ${leaseToken}::uuid
           AND lease_until > clock_timestamp()`;
      if (saved !== 1) throw new Error('FEDERAL_EVIDENCE_CHECKPOINT_LEASE_EXPIRED');
      if (complete) break;
    }

    // Removal reconciliation is disabled entirely in FY26 mode: this bounded
    // scope never deletes or retires older evidence.
    if (complete && full && fy26 === null) {
      const missing = await prisma.$queryRaw<Array<{ sourceKey: string }>>`
        SELECT source_key AS "sourceKey"
          FROM federal_evidence_inventory_member
         WHERE inventory_source = ${inventorySource}
           AND last_seen_window_end < ${new Date(cursor.until)}`;
      for (const row of missing) {
        const current = await prisma.$queryRaw<Array<{ state: string }>>`
          SELECT state FROM federal_evidence_current WHERE source_key = ${row.sourceKey}`;
        if (current[0]?.state !== 'present') continue;
        const result = await persistFederalEvidenceRemoval(prisma, {
          sourceKey: row.sourceKey,
          observationKey: `${checkpointSource}:${cursor.until}:removed:${row.sourceKey}`,
          inventoryWindowEnd: new Date(cursor.until),
          historical,
          inventoryComplete: true,
          metadata: { reason: 'absent_from_complete_full_inventory' },
        });
        updated += result.eventTypes.length > 0 ? 1 : 0;
      }
    }
  } catch (error) {
    errors += 1;
    await prisma.$executeRaw`
      UPDATE federal_evidence_checkpoint
         SET cursor_jsonb = ${JSON.stringify(cursor)}::jsonb, status = 'failed',
             completed_at = NULL,
             last_error = ${(error instanceof Error ? error.message : String(error)).slice(0, 4000)},
             updated_at = clock_timestamp()
       WHERE source = ${checkpointSource} AND lease_token = ${leaseToken}::uuid`;
  } finally {
    await prisma.$executeRaw`
      UPDATE federal_evidence_checkpoint SET lease_token = NULL, lease_until = NULL
       WHERE source = ${checkpointSource} AND lease_token = ${leaseToken}::uuid`;
  }
  return { inserted, updated, skipped, errors, complete, coverageGaps, pendingUnknown };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      'Usage: sync-federal-legislative-evidence [--collection <name>] [--congress <n>] [--cap <n>] [--full] [--historical] [--commit] (requires DATABASE_URL)',
    );
    process.exitCode = 2;
    return;
  }
  const commit = process.argv.includes('--commit');
  const full = process.argv.includes('--full');
  const historical = process.argv.includes('--historical');
  const collectionArg = (arg('collection') ?? 'BILLS').toUpperCase() as FederalEvidenceCollection;
  if (!ALLOWED_COLLECTIONS.has(collectionArg))
    throw new Error(`--collection must be one of ${[...ALLOWED_COLLECTIONS].join(', ')}`);
  const congress = Number(arg('congress') ?? currentCongress());
  const cap = Number(arg('cap') ?? DEFAULT_CAP);
  if (!Number.isSafeInteger(congress) || congress < 1)
    throw new Error('--congress must be positive');
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1000)
    throw new Error('--cap must be an integer from 1 to 1000');
  // Validate BILL_FISCAL_YEAR for every collection, then apply the FY26 scope
  // to BILLS only; other collections keep their existing all-session scope.
  const fiscalYear = fiscalYearMode();
  if (fiscalYear !== null && collectionArg !== 'BILLS')
    throw Error('FY26_SCOPE_REQUIRES_BILLS_COLLECTION');
  const fy26 = collectionArg === 'BILLS' ? fiscalYear : null;

  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const checkpoint = await prisma.federalEvidenceCheckpoint.findUnique({
      where: {
        source: checkpointSourceFor(collectionArg, congress, full, fy26ScopedSuffix(fy26)),
      },
    });
    const hasCompletedFullBaseline =
      checkpoint?.status === 'completed' && checkpoint.completedAt != null;
    console.log(
      JSON.stringify(
        {
          mode: commit ? 'COMMIT' : 'DRY_RUN',
          collection: collectionArg,
          congress,
          full,
          historical,
          cap,
          fy26,
          checkpoint,
        },
        null,
        2,
      ),
    );
    if (!commit) return;
    // The first full inventory hydrates old source history. Require explicit
    // historical mode before any provider calls or writes so it cannot fan out
    // a corpus-sized set of events as breaking news by accident.
    assertFullFederalEvidenceReconciliationSafe({ full, historical, hasCompletedFullBaseline });
    if (process.env.FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED !== 'true')
      throw new Error('FEDERAL_LEGISLATIVE_EVIDENCE_DISABLED');
    if (!process.env.GOVINFO_API_KEY) throw new Error('GOVINFO_API_KEY is required');
    const config = {
      get: (key: keyof AppConfig) => process.env[key as string],
    } as unknown as ConfigService<AppConfig, true>;
    const gov = new GovInfoService(prisma, config);
    const result = await runWithSyncRun(prisma, 'sync-federal-legislative-evidence', async () => {
      const run = async (writer: PrismaService) => {
        const counts = await syncCollection({
          prisma: writer,
          gov,
          collection: collectionArg,
          congress,
          full,
          historical,
          cap,
          fy26,
        });
        // A scoped text backfill does not drain unrelated global replay work.
        const replay =
          fy26 === null ? await replayPendingFederalEvidenceMentions(writer, cap) : null;
        console.log(JSON.stringify({ ...counts, pendingReplay: replay }, null, 2));
        return counts;
      };
      return ['BILLS', 'PLAW'].includes(collectionArg)
        ? await withFederalBillWriter(prisma, (writer) => run(writer as PrismaService))
        : await run(prisma);
    });
    if (fy26 !== null && result.errors > 0) throw Error('FY26_FEDERAL_TEXT_ERRORS');
    console.log(
      JSON.stringify(
        { status: result.complete === false ? 'partial' : 'complete', result },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

/** Congresses begin on January 3 of each odd-numbered year. */
function currentCongress(now = new Date()): number {
  const year = now.getUTCFullYear();
  const oddYear = year % 2 === 1 ? year : year - 1;
  let congress = Math.floor((oddYear - 1789) / 2) + 1;
  if (year % 2 === 1 && now < new Date(Date.UTC(year, 0, 3))) congress -= 1;
  return congress;
}

if (require.main === module)
  void main().catch((error) => {
    console.error(
      '[sync-federal-legislative-evidence] FAILED',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
