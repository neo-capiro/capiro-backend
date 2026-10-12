/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { config as dotenvConfig } from 'dotenv';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  buildAwardDateImpactReport,
  INCIDENT_AWARD_IDS,
  renderAwardDateImpactMarkdown,
  type AwardDateImpactRow,
} from './federal-award-date-impact-report.js';

dotenvConfig();

const DETAIL_URL = 'https://api.usaspending.gov/api/v2/awards';
const DELAY_MS = Number(process.env.USASPENDING_DELAY_MS ?? 150);
const MAX_ATTEMPTS = Number(process.env.USASPENDING_MAX_ATTEMPTS ?? 4);
const BATCH_SIZE = Number(process.env.USASPENDING_BACKFILL_BATCH_SIZE ?? 100);

interface Options {
  commit: boolean;
  limit: number;
  ids: string[];
  since?: Date;
  rail: 'detail' | 'bulk';
  snapshot?: string;
  rollback?: string;
  report: string;
  inputIdsFile?: string;
}

interface SelectedAward {
  id: string | null;
  awardUniqueId: string;
  piid: string | null;
  amount: number | null;
  actionDate: string | null;
  before: AwardDateImpactRow['before'];
}

interface DetailResponse {
  date_signed?: string | null;
  period_of_performance?: {
    start_date?: string | null;
    end_date?: string | null;
    last_modified_date?: string | null;
  } | null;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function usage(): string {
  return `Federal award date backfill (DRY RUN by default)

Usage:
  tsx scripts/backfill-federal-award-dates.ts --limit 3 --report ./award-date-impact.md
  tsx scripts/backfill-federal-award-dates.ts --commit --snapshot ./before.jsonl --limit 500
  tsx scripts/backfill-federal-award-dates.ts --rollback ./before.jsonl

Options:
  --commit                 Persist corrected date columns (requires --snapshot)
  --limit N                Maximum awards, highest-dollar first (default 100)
  --ids a,b,c              Process exact award unique ids
  --input-ids-file PATH    Newline-delimited award ids; enables no-DB dry runs
  --since ISO              Select rows synced on/after this instant
  --rail detail|bulk       USAspending rail (bulk is not implemented)
  --snapshot PATH          Append pre-write values as JSONL
  --rollback PATH          Restore corrected columns from a JSONL snapshot
  --report PATH.md         Write Markdown and sibling JSON impact reports
  --help                   Show this help

When DATABASE_URL is unset, dry-run uses --ids, --input-ids-file, or the three
incident award ids. It never connects to a database.`;
}

function parseOptions(): Options {
  const limit = Number(arg('limit') ?? 100);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  const rail = arg('rail') ?? 'detail';
  if (rail !== 'detail' && rail !== 'bulk') throw new Error('--rail must be detail or bulk');
  const sinceRaw = arg('since');
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  if (since && Number.isNaN(since.getTime())) throw new Error('--since must be an ISO date');
  const commit = has('commit');
  const snapshot = arg('snapshot');
  if (commit && !snapshot) throw new Error('--snapshot is required with --commit');
  return {
    commit,
    limit,
    ids: (arg('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean),
    since,
    rail,
    snapshot,
    rollback: arg('rollback'),
    report: arg('report') ?? 'federal-award-date-impact.md',
    inputIdsFile: arg('input-ids-file'),
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function emptyBefore(): AwardDateImpactRow['before'] {
  return {
    baseAwardSignedDate: null,
    latestActionDate: null,
    sourceLastModifiedDate: null,
    popStartDate: null,
    popEndDate: null,
    dateSemanticsVersion: null,
  };
}

async function noDatabaseAwards(options: Options): Promise<SelectedAward[]> {
  let ids = options.ids;
  if (options.inputIdsFile) {
    ids = (await readFile(options.inputIdsFile, 'utf8'))
      .split(/\r?\n/)
      .map((id) => id.trim())
      .filter(Boolean);
  }
  if (ids.length === 0) ids = [...INCIDENT_AWARD_IDS];
  return ids.slice(0, options.limit).map((awardUniqueId) => ({
    id: null,
    awardUniqueId,
    piid: null,
    amount: null,
    actionDate: null,
    before: emptyBefore(),
  }));
}

async function databaseAwards(prisma: PrismaClient, options: Options): Promise<SelectedAward[]> {
  const rows = await prisma.federalAward.findMany({
    where: {
      ...(options.ids.length ? { awardUniqueId: { in: options.ids } } : {}),
      ...(options.since ? { lastSyncedAt: { gte: options.since } } : {}),
    },
    select: {
      id: true,
      awardUniqueId: true,
      piid: true,
      amount: true,
      actionDate: true,
      baseAwardSignedDate: true,
      latestActionDate: true,
      sourceLastModifiedDate: true,
      popStartDate: true,
      popEndDate: true,
      dateSemanticsVersion: true,
    },
    orderBy: [{ amount: 'desc' }, { id: 'asc' }],
    take: options.limit,
  });
  return rows.map((row) => ({
    id: row.id,
    awardUniqueId: row.awardUniqueId,
    piid: row.piid,
    amount: row.amount == null ? null : Number(row.amount),
    actionDate: iso(row.actionDate),
    before: {
      baseAwardSignedDate: iso(row.baseAwardSignedDate),
      latestActionDate: iso(row.latestActionDate),
      sourceLastModifiedDate: iso(row.sourceLastModifiedDate),
      popStartDate: iso(row.popStartDate),
      popEndDate: iso(row.popEndDate),
      dateSemanticsVersion: row.dateSemanticsVersion,
    },
  }));
}

const FETCH_TIMEOUT_MS = Number(process.env.USASPENDING_FETCH_TIMEOUT_MS ?? 30_000);

/**
 * Returns the detail record, or `null` when USAspending answers with a non-OK status for this
 * award after the retry budget (an "unavailable" award: it must stay NULL, never be written as
 * verified). Network-level failures still throw after the retry budget.
 *
 * Every non-OK body is drained before retrying or returning: an unconsumed body wedges the shared
 * keep-alive connection and made every following request in the process fail with
 * `UND_ERR_SOCKET` (observed 2026-09-22 during the production backfill).
 */
async function fetchDetail(awardUniqueId: string): Promise<DetailResponse | null> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${DETAIL_URL}/${encodeURIComponent(awardUniqueId)}/`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) return (await response.json()) as DetailResponse;
      await response.arrayBuffer().catch(() => undefined);
      lastStatus = response.status;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** (attempt - 1)));
  }
  console.log(`[award-date-backfill] unavailable awardUniqueId=${awardUniqueId} status=${lastStatus}`);
  return null;
}

function impactRow(row: SelectedAward, detail: DetailResponse): AwardDateImpactRow {
  const performance = detail.period_of_performance ?? {};
  return {
    ...row,
    after: {
      baseAwardSignedDate: iso(detail.date_signed),
      // The detail response has no authoritative transaction action date.
      latestActionDate: null,
      sourceLastModifiedDate: iso(performance.last_modified_date),
      popStartDate: iso(performance.start_date),
      popEndDate: iso(performance.end_date),
      dateSemanticsVersion: 1,
    },
  };
}

async function writeReports(reportPath: string, rows: AwardDateImpactRow[]): Promise<void> {
  const markdownPath = reportPath.toLowerCase().endsWith('.md') ? reportPath : `${reportPath}.md`;
  const jsonPath = markdownPath.replace(/\.md$/i, '.json');
  const report = buildAwardDateImpactReport(rows);
  await writeFile(markdownPath, renderAwardDateImpactMarkdown(report), 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[award-date-backfill] reports=${path.resolve(markdownPath)},${path.resolve(jsonPath)}`);
}

async function commitRows(
  prisma: PrismaClient,
  rows: AwardDateImpactRow[],
  snapshotPath: string,
): Promise<void> {
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    // Snapshot the entire batch before its first write. Append-only permits safe resume.
    await appendFile(
      snapshotPath,
      batch.map((row) => JSON.stringify({ id: row.id, awardUniqueId: row.awardUniqueId, ...row.before })).join('\n') + '\n',
      'utf8',
    );
    await prisma.$transaction(
      batch.map((row) => {
        if (!row.id) throw new Error(`Cannot commit unresolved local award ${row.awardUniqueId}`);
        return prisma.federalAward.update({
          where: { id: row.id },
          data: {
            baseAwardSignedDate: asDate(row.after.baseAwardSignedDate),
            latestActionDate: asDate(row.after.latestActionDate),
            sourceLastModifiedDate: asDate(row.after.sourceLastModifiedDate),
            popStartDate: asDate(row.after.popStartDate),
            popEndDate: asDate(row.after.popEndDate),
            dateSemanticsVersion: 1,
          },
        });
      }),
    );
  }
}

async function rollback(prisma: PrismaClient, snapshotPath: string): Promise<number> {
  const snapshots = (await readFile(snapshotPath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AwardDateImpactRow['before'] & { id: string });
  for (let start = 0; start < snapshots.length; start += BATCH_SIZE) {
    const batch = snapshots.slice(start, start + BATCH_SIZE);
    await prisma.$transaction(
      batch.map((row) =>
        prisma.federalAward.update({
          where: { id: row.id },
          data: {
            baseAwardSignedDate: asDate(row.baseAwardSignedDate),
            latestActionDate: asDate(row.latestActionDate),
            sourceLastModifiedDate: asDate(row.sourceLastModifiedDate),
            popStartDate: asDate(row.popStartDate),
            popEndDate: asDate(row.popEndDate),
            dateSemanticsVersion: row.dateSemanticsVersion,
          },
        }),
      ),
    );
  }
  return snapshots.length;
}

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    console.error('Usage: backfill-federal-award-dates --limit N --report PATH [--commit --snapshot PATH]; use --help for all options');
    process.exit(2);
  }
  const valueFlags = new Set(['--limit', '--ids', '--input-ids-file', '--since', '--rail', '--snapshot', '--rollback', '--report']);
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index]!;
    if (['--commit', '--dry-run', '--help'].includes(flag)) continue;
    if (valueFlags.has(flag) && process.argv[index + 1] && !process.argv[index + 1]!.startsWith('--')) {
      index++;
      continue;
    }
    console.error(`Usage: backfill-federal-award-dates --help; unknown option or missing value: ${flag}`);
    process.exit(2);
  }
  if (has('help')) {
    console.log(usage());
    return;
  }
  const options = parseOptions();
  if (options.rail === 'bulk') throw new Error('--rail bulk is NOT IMPLEMENTED; use --rail detail');

  if (options.rollback) {
    if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/backfill-federal-award-dates.ts requires DATABASE_URL (database configuration is required)');
    process.exit(1);
  }

    const prisma = new PrismaClient();
    try {
      const count = await rollback(prisma, options.rollback);
      console.log(`[award-date-backfill] ROLLBACK restored=${count}`);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  const useDatabase = Boolean(process.env.DATABASE_URL);
  if (options.commit && !useDatabase) {
    console.error('Usage: apps/api/scripts/backfill-federal-award-dates.ts requires DATABASE_URL (database configuration is required)');
    process.exit(1);
  }

  const prisma = useDatabase ? new PrismaClient() : null;
  try {
    const selected = prisma ? await databaseAwards(prisma, options) : await noDatabaseAwards(options);
    const rows: AwardDateImpactRow[] = [];
    console.log(
      `[award-date-backfill] mode=${options.commit ? 'COMMIT' : 'DRY-RUN'} rail=detail rows=${selected.length} database=${useDatabase}`,
    );
    let unavailable = 0;
    for (const [index, row] of selected.entries()) {
      if (index > 0 && DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      const detail = await fetchDetail(row.awardUniqueId);
      // Unavailable source records are skipped entirely: their columns stay NULL and they never
      // receive date_semantics_version = 1.
      if (detail === null) {
        unavailable += 1;
        continue;
      }
      rows.push(impactRow(row, detail));
    }
    await writeReports(options.report, rows);
    if (options.commit) await commitRows(prisma!, rows, options.snapshot!);
    console.log(
      `[award-date-backfill] complete examined=${selected.length} fetched=${rows.length} unavailable=${unavailable} written=${options.commit ? rows.length : 0}`,
    );
  } finally {
    await prisma?.$disconnect();
  }
}

if (require.main === module) {
void main().catch((error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const causeText = cause ? ` cause=${cause.code ?? cause.message ?? 'unknown'}` : '';
  console.error(`[award-date-backfill] ${(error as Error).message}${causeText}`);
  process.exitCode = 1;
});
}
