/**
 * SELECT-only Program Elements trust baseline.
 *
 * This command intentionally performs no create/update/delete/upsert, writes no
 * SyncRun row, advances no watermark and catches no individual query failure.
 * Any database/query error rejects main(), prints one fatal message and exits 1.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { SOURCE_PRIORITY } from '../src/program-element/types.js';
import { sourceBaseKey } from '../src/program-element/source-priority.js';

dotenvConfig();

const MONEY_FIELDS = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'conference',
  'ndaaConference',
  'enacted',
  'reprogrammed',
  'executed',
] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];

const SAMPLE_LIMIT = 20;
const FIXED_SYNC_SOURCES = [
  'pe-derive-chain',
  'sync-sam-opportunities',
  'send-pe-alert-emails',
] as const;

function buildDatabaseUrlFromParts(): void {
  if (process.env.DATABASE_URL) return;
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`DATABASE_URL is unset and required DB_* values are missing: ${missing.join(', ')}`);
  }
  const password = encodeURIComponent(process.env.DB_PASSWORD!);
  process.env.DATABASE_URL =
    `postgresql://${process.env.DB_USER}:${password}@${process.env.DB_HOST}:` +
    `${process.env.DB_PORT}/${process.env.DB_NAME}?schema=public&sslmode=require&connection_limit=10`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringMap(value: unknown): Record<string, string> {
  const obj = asObject(value);
  if (!obj) return {};
  return Object.fromEntries(
    Object.entries(obj).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(
    typeof value === 'object' && value !== null && 'toString' in value
      ? (value as { toString(): string }).toString()
      : value,
  );
  return Number.isFinite(n) ? n : null;
}

function inc(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function sortCountRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })),
  );
}

function databaseHost(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return 'UNAVAILABLE';
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${parsed.pathname.replace(/^\//, '')}`;
  } catch {
    return 'UNPARSEABLE_DATABASE_URL';
  }
}

function gitSha(): string {
  return (
    process.env.GIT_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION ??
    process.env.ECS_CONTAINER_METADATA_URI_V4?.split('/').pop() ??
    'UNVERIFIED'
  );
}

function ageSeconds(date: Date | null | undefined, now: Date): number | null {
  return date ? Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000)) : null;
}

async function main(): Promise<void> {
  buildDatabaseUrlFromParts();
  const prisma = new PrismaClient();
  const generatedAt = new Date();

  try {
    const years = await prisma.programElementYear.findMany({
      select: {
        peCode: true,
        fy: true,
        request: true,
        hascMark: true,
        sascMark: true,
        hacDMark: true,
        sacDMark: true,
        conference: true,
        ndaaConference: true,
        enacted: true,
        reprogrammed: true,
        executed: true,
        raw: true,
      },
      orderBy: [{ fy: 'asc' }, { peCode: 'asc' }],
    });

    const yearCountByFy: Record<string, number> = {};
    const nonNullByField: Record<string, number> = Object.fromEntries(
      MONEY_FIELDS.map((field) => [field, 0]),
    );
    const overMagnitudeByField: Record<string, { count: number; samples: unknown[] }> =
      Object.fromEntries(MONEY_FIELDS.map((field) => [field, { count: 0, samples: [] }]));
    const missingAttributionByField: Record<string, number> = Object.fromEntries(
      MONEY_FIELDS.map((field) => [field, 0]),
    );
    const missingAttributionSamples: unknown[] = [];
    let rowsMissingAttribution = 0;
    let rowsWithUnknownFieldSources = 0;
    const unknownFieldSourceCounts: Record<string, number> = {};
    const unknownFieldSourceSamples: unknown[] = [];
    const knownSources = new Set<string>(SOURCE_PRIORITY);

    for (const row of years) {
      inc(yearCountByFy, String(row.fy));
      const raw = asObject(row.raw) ?? {};
      const attribution = asStringMap(raw.sourceAttribution);
      const fieldSources = asStringMap(raw.fieldSources);
      const missingFields: string[] = [];

      for (const field of MONEY_FIELDS) {
        const numeric = toNumber(row[field]);
        if (numeric === null) continue;
        nonNullByField[field] += 1;
        if (Math.abs(numeric) > 100_000) {
          const bucket = overMagnitudeByField[field]!;
          bucket.count += 1;
          if (bucket.samples.length < SAMPLE_LIMIT) {
            bucket.samples.push({ peCode: row.peCode, fy: row.fy, value: numeric });
          }
        }
        if (!attribution[field]) {
          missingAttributionByField[field] += 1;
          missingFields.push(field);
        }
      }

      if (missingFields.length > 0) {
        rowsMissingAttribution += 1;
        if (missingAttributionSamples.length < SAMPLE_LIMIT) {
          missingAttributionSamples.push({ peCode: row.peCode, fy: row.fy, fields: missingFields });
        }
      }

      const unknownOnRow: Array<{ field: string; source: string }> = [];
      for (const [field, source] of Object.entries(fieldSources)) {
        const base = sourceBaseKey(source);
        if (!knownSources.has(base)) {
          inc(unknownFieldSourceCounts, source);
          unknownOnRow.push({ field, source });
        }
      }
      if (unknownOnRow.length > 0) {
        rowsWithUnknownFieldSources += 1;
        if (unknownFieldSourceSamples.length < SAMPLE_LIMIT) {
          unknownFieldSourceSamples.push({ peCode: row.peCode, fy: row.fy, sources: unknownOnRow });
        }
      }
    }

    const observations = await prisma.programElementYearSourceValue.findMany({
      select: {
        peCode: true,
        fy: true,
        fieldName: true,
        source: true,
        valueDecimal: true,
        sourceDocumentId: true,
      },
      orderBy: [{ peCode: 'asc' }, { fy: 'asc' }, { fieldName: 'asc' }, { source: 'asc' }],
    });
    const observationByField: Record<string, number> = {};
    const observationBySource: Record<string, number> = {};
    let legacyRowCount = 0;
    let observationsWithoutSourceDocument = 0;
    const duplicateObservationMap = new Map<string, { count: number; sample: unknown }>();
    for (const row of observations) {
      inc(observationByField, row.fieldName);
      inc(observationBySource, row.source);
      if (row.fieldName === '__row__') legacyRowCount += 1;
      if (!row.sourceDocumentId) observationsWithoutSourceDocument += 1;
      const value = row.valueDecimal?.toString() ?? 'NULL';
      const key = [
        row.peCode,
        row.fy,
        row.fieldName,
        row.source,
        value,
        row.sourceDocumentId ?? 'NULL',
      ].join('|');
      const current = duplicateObservationMap.get(key);
      if (current) current.count += 1;
      else {
        duplicateObservationMap.set(key, {
          count: 1,
          sample: {
            peCode: row.peCode,
            fy: row.fy,
            fieldName: row.fieldName,
            source: row.source,
            valueDecimal: value === 'NULL' ? null : value,
            sourceDocumentId: row.sourceDocumentId,
          },
        });
      }
    }
    const duplicateObservations = [...duplicateObservationMap.values()]
      .filter((entry) => entry.count > 1)
      .sort((a, b) => b.count - a.count);

    const openReconciliation = await prisma.reconciliationReviewQueue.findMany({
      where: { status: 'open' },
      select: { fieldName: true, conflictingSource: true, queuedAt: true },
      orderBy: { queuedAt: 'asc' },
    });
    const reconciliationByFieldAndSource: Record<string, number> = {};
    for (const row of openReconciliation) {
      inc(reconciliationByFieldAndSource, `${row.fieldName}|${row.conflictingSource}`);
    }

    const programElements = await prisma.programElement.findMany({ select: { peCode: true, raw: true } });
    let pDocDetail = 0;
    let op5Detail = 0;
    let bothDetails = 0;
    let rawNotObject = 0;
    const rawNotObjectSamples: string[] = [];
    for (const row of programElements) {
      const raw = asObject(row.raw);
      if (!raw) {
        rawNotObject += 1;
        if (rawNotObjectSamples.length < SAMPLE_LIMIT) rawNotObjectSamples.push(row.peCode);
        continue;
      }
      const hasPdoc = Object.prototype.hasOwnProperty.call(raw, 'pDocDetail') && raw.pDocDetail != null;
      const hasOp5 = Object.prototype.hasOwnProperty.call(raw, 'op5Detail') && raw.op5Detail != null;
      if (hasPdoc) pDocDetail += 1;
      if (hasOp5) op5Detail += 1;
      if (hasPdoc && hasOp5) bothDetails += 1;
    }

    const watches = await prisma.programElementWatch.findMany({
      select: { tenantId: true, userId: true, peCode: true },
      orderBy: [{ tenantId: 'asc' }, { userId: 'asc' }, { peCode: 'asc' }],
    });
    const watchesByTenant: Record<string, number> = {};
    const watchesByUser: Record<string, number> = {};
    const watchTripleCounts = new Map<string, number>();
    const userPeTenants = new Map<string, Set<string>>();
    for (const row of watches) {
      inc(watchesByTenant, row.tenantId);
      inc(watchesByUser, row.userId);
      const triple = `${row.tenantId}|${row.userId}|${row.peCode}`;
      watchTripleCounts.set(triple, (watchTripleCounts.get(triple) ?? 0) + 1);
      const pair = `${row.userId}|${row.peCode}`;
      const tenants = userPeTenants.get(pair) ?? new Set<string>();
      tenants.add(row.tenantId);
      userPeTenants.set(pair, tenants);
    }
    const duplicateWatchTriples = [...watchTripleCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([key, count]) => ({ key, count }));
    const crossTenantUserPePairs = [...userPeTenants.entries()]
      .filter(([, tenants]) => tenants.size > 1)
      .map(([key, tenants]) => ({ key, tenants: [...tenants].sort() }));

    const sourceDocuments = await prisma.sourceDocument.findMany({
      select: {
        id: true,
        sourceKey: true,
        fiscalYear: true,
        budgetCycle: true,
        documentType: true,
        sha256: true,
        supersededByDocumentId: true,
        archiveBucket: true,
        archiveS3Key: true,
        archiveVersionId: true,
        archivedAt: true,
      },
      orderBy: [{ sourceKey: 'asc' }, { ingestedAt: 'desc' }],
    });
    const liveHeads = new Map<string, string[]>();
    const sourceDocumentCounts: Record<string, number> = {};
    const missingShaSamples: unknown[] = [];
    const missingArchiveSamples: unknown[] = [];
    let missingSha = 0;
    let missingImmutableArchiveMetadata = 0;
    for (const row of sourceDocuments) {
      inc(
        sourceDocumentCounts,
        `${row.documentType}|FY${row.fiscalYear ?? 'unknown'}|${row.budgetCycle}`,
      );
      if (!row.supersededByDocumentId) {
        const heads = liveHeads.get(row.sourceKey) ?? [];
        heads.push(row.id);
        liveHeads.set(row.sourceKey, heads);
      }
      if (!row.sha256) {
        missingSha += 1;
        if (missingShaSamples.length < SAMPLE_LIMIT) {
          missingShaSamples.push({ id: row.id, sourceKey: row.sourceKey });
        }
      }
      const missingArchive =
        !row.archiveBucket || !row.archiveS3Key || !row.archiveVersionId || !row.archivedAt;
      if (missingArchive) {
        missingImmutableArchiveMetadata += 1;
        if (missingArchiveSamples.length < SAMPLE_LIMIT) {
          missingArchiveSamples.push({
            id: row.id,
            sourceKey: row.sourceKey,
            missing: [
              !row.archiveBucket ? 'archiveBucket' : null,
              !row.archiveS3Key ? 'archiveS3Key' : null,
              !row.archiveVersionId ? 'archiveVersionId' : null,
              !row.archivedAt ? 'archivedAt' : null,
            ].filter(Boolean),
          });
        }
      }
    }
    const duplicateLiveHeads = [...liveHeads.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([sourceKey, ids]) => ({ sourceKey, count: ids.length, ids }));

    const ingestRuns = await prisma.programElementIngestRun.findMany({
      select: {
        id: true,
        source: true,
        fy: true,
        artifactSha256: true,
        status: true,
        rowsEmitted: true,
        upserted: true,
        changed: true,
        quarantined: true,
        titleTruncated: true,
        unitsAnomalies: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    const ingestStatusCounts: Record<string, number> = {};
    const latestIngestBySource = new Map<string, unknown>();
    const ingestQualityRows: unknown[] = [];
    for (const row of ingestRuns) {
      inc(ingestStatusCounts, row.status);
      if (!latestIngestBySource.has(row.source)) latestIngestBySource.set(row.source, row);
      if (row.unitsAnomalies > 0 || row.titleTruncated > 0) {
        if (ingestQualityRows.length < SAMPLE_LIMIT) ingestQualityRows.push(row);
      }
    }

    const syncRuns = await prisma.syncRun.findMany({
      where: {
        OR: [
          { source: { in: [...FIXED_SYNC_SOURCES] } },
          { source: { startsWith: 'parse-' } },
          { source: { startsWith: 'load-' } },
          { source: { startsWith: 'llamaparse_' } },
        ],
      },
      select: {
        source: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        rowsInserted: true,
        rowsUpdated: true,
        errorCount: true,
        errorMessage: true,
      },
      orderBy: { startedAt: 'desc' },
    });
    const latestSyncBySource = new Map<string, unknown>();
    for (const row of syncRuns) {
      if (latestSyncBySource.has(row.source)) continue;
      latestSyncBySource.set(row.source, {
        ...row,
        ageSeconds: ageSeconds(row.finishedAt ?? row.startedAt, generatedAt),
      });
    }
    for (const source of FIXED_SYNC_SOURCES) {
      if (!latestSyncBySource.has(source)) {
        latestSyncBySource.set(source, {
          source,
          status: 'UNOBSERVED',
          startedAt: null,
          finishedAt: null,
          ageSeconds: null,
        });
      }
    }

    const report = {
      generatedAt: generatedAt.toISOString(),
      gitSha: gitSha(),
      databaseHost: databaseHost(),
      readOnly: true,
      programElementYears: {
        total: years.length,
        countByFiscalYear: sortCountRecord(yearCountByFy),
        nonNullByField,
        absoluteValueOver100000ByField: overMagnitudeByField,
        sourceAttributionMissing: {
          rows: rowsMissingAttribution,
          byField: missingAttributionByField,
          samples: missingAttributionSamples,
        },
        unknownFieldSources: {
          rows: rowsWithUnknownFieldSources,
          bySource: sortCountRecord(unknownFieldSourceCounts),
          samples: unknownFieldSourceSamples,
        },
      },
      sourceObservations: {
        total: observations.length,
        countByField: sortCountRecord(observationByField),
        countBySource: sortCountRecord(observationBySource),
        legacyRowCount,
        duplicateGroups: duplicateObservations.length,
        duplicateRowsBeyondFirst: duplicateObservations.reduce(
          (sum, entry) => sum + entry.count - 1,
          0,
        ),
        duplicateSamples: duplicateObservations.slice(0, SAMPLE_LIMIT),
        withoutSourceDocument: observationsWithoutSourceDocument,
      },
      reconciliation: {
        openCount: openReconciliation.length,
        oldestOpenQueuedAt: openReconciliation[0]?.queuedAt ?? null,
        oldestOpenAgeSeconds: ageSeconds(openReconciliation[0]?.queuedAt, generatedAt),
        countByFieldAndConflictingSource: sortCountRecord(reconciliationByFieldAndSource),
      },
      enrichmentRetention: {
        totalProgramElements: programElements.length,
        withPDocDetail: pDocDetail,
        withOp5Detail: op5Detail,
        withBoth: bothDetails,
        rawNotObject,
        rawNotObjectSamples,
      },
      watches: {
        total: watches.length,
        countByTenant: sortCountRecord(watchesByTenant),
        countByUser: sortCountRecord(watchesByUser),
        duplicateTenantUserPeGroups: duplicateWatchTriples,
        userPePairsAcrossMultipleTenants: crossTenantUserPePairs,
        schemaLimitation:
          'The current database unique constraint is (user_id, pe_code), so zero cross-tenant user/PE rows is not proof that multi-tenant watch intent does not exist; the schema currently prevents representing it.',
      },
      sourceDocuments: {
        total: sourceDocuments.length,
        duplicateLiveHeads,
        lackingSha256: { count: missingSha, samples: missingShaSamples },
        lackingImmutableArchiveMetadata: {
          count: missingImmutableArchiveMetadata,
          samples: missingArchiveSamples,
        },
        countByDocumentTypeFiscalYearBudgetCycle: sortCountRecord(sourceDocumentCounts),
      },
      ingestRuns: {
        total: ingestRuns.length,
        statusCounts: sortCountRecord(ingestStatusCounts),
        latestBySource: Object.fromEntries(
          [...latestIngestBySource.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
        withUnitAnomaliesOrTruncatedTitles: ingestRuns.filter(
          (row) => row.unitsAnomalies > 0 || row.titleTruncated > 0,
        ).length,
        qualitySamples: ingestQualityRows,
      },
      syncRuns: {
        latestBySource: Object.fromEntries(
          [...latestSyncBySource.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[diag-pe-trust] FAILED\n${message}`);
  process.exit(1);
});
