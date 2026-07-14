/**
 * LegiStorm directory safe refresh — dry-run-first CLI.
 *
 * Composes the offline pipeline (client -> merge -> validation -> publisher) into
 * one operator-safe command. The DEFAULT is a dry run that performs ZERO S3 and
 * ZERO database writes: it reads the current snapshot + overlays, fetches from
 * LegiStorm, merges, validates, and prints an aggregate-only report. Only
 * `--commit` publishes, and only after every validation gate passes.
 *
 *   pnpm --filter @capiro/api sync:legistorm-directory                  # dry run, incremental
 *   pnpm --filter @capiro/api sync:legistorm-directory -- --commit      # publish incremental snapshot
 *   pnpm --filter @capiro/api sync:legistorm-directory -- --full        # dry-run full reconciliation
 *   pnpm --filter @capiro/api sync:legistorm-directory -- --commit --full
 *   pnpm --filter @capiro/api sync:legistorm-directory -- --since=2026-06-01
 *   pnpm --filter @capiro/api sync:legistorm-directory -- --commit --approval-file=/path/approval.json
 *
 * Windows:
 *   - members are ALWAYS fetched as the full current list (floor..today) because
 *     there is no member-retired-ID endpoint and the list is one page (status=c);
 *   - staff/offices are incremental (last successful watermark minus the overlap)
 *     unless `--full` (floor..today) or `--since` (explicit start, no overlap) wins.
 *
 * Commit execution is wrapped in `runWithSyncRun` so the run is represented in
 * `sync_run` and emits exactly one `INGESTION_METRIC`. Dry runs never open a run.
 * Aggregate-only output: no source rows, names, emails, addresses, or DOBs.
 */
import { readFileSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { S3Client } from '@aws-sdk/client-s3';
import {
  LegiStormClient,
  type LegiStormDateRange,
  type LegiStormPagedResult,
  type LegiStormRetiredIdsResult,
} from '../src/directory/legistorm/legistorm-client.js';
import {
  mergeDirectorySnapshot,
  type DirectoryMergeCounts,
  type DirectoryMergeMode,
  type DirectorySnapshotMergeResult,
} from '../src/directory/legistorm/directory-snapshot-merge.js';
import {
  validateDirectorySnapshot,
  type DirectorySnapshotValidationReport,
  type DirectoryValidationApproval,
} from '../src/directory/legistorm/directory-snapshot-validation.js';
import {
  DirectorySnapshotPublisher,
  type DirectoryCurrentSnapshot,
  type DirectoryPublishResult,
  type DirectorySnapshotPublishInput,
} from '../src/directory/legistorm/directory-snapshot-publisher.js';
import {
  lastSuccessfulWatermark,
  runWithSyncRun,
  type RunCounts,
  type SyncRunCapablePrisma,
} from '../src/ingestion/sync-run.helper.js';
import type {
  LegiStormMemberRecord,
  LegiStormOfficeRecord,
  LegiStormStaffRecord,
} from '../src/directory/legistorm/legistorm-types.js';

export const SYNC_SOURCE = 'sync-legistorm-directory';
/** Documented full-reconciliation floor; also the members full-current window start. */
export const DEFAULT_FULL_FLOOR_DATE = '2000-01-01';
const ROOT_PREFIX = 'UPDATED DIRECTORY';

/** The client surface the orchestrator needs — lets tests inject a fake. */
export interface LegiStormSource {
  fetchMembers(range: LegiStormDateRange): Promise<LegiStormPagedResult<LegiStormMemberRecord>>;
  fetchOffices(range: LegiStormDateRange): Promise<LegiStormPagedResult<LegiStormOfficeRecord>>;
  fetchStaff(range: LegiStormDateRange): Promise<LegiStormPagedResult<LegiStormStaffRecord>>;
  fetchRetiredOfficeIds(): Promise<LegiStormRetiredIdsResult>;
  fetchRetiredStaffIds(): Promise<LegiStormRetiredIdsResult>;
}

/** The publisher surface the orchestrator needs — lets tests inject a fake. */
export interface DirectorySnapshotStore {
  loadCurrentSnapshot(): Promise<DirectoryCurrentSnapshot>;
  publish(input: DirectorySnapshotPublishInput): Promise<DirectoryPublishResult>;
}

export interface SyncCliOptions {
  commit: boolean;
  full: boolean;
  since: string | null;
  /** Parsed approval JSON; re-validated at the runtime boundary. */
  approval?: unknown;
}

export interface SyncCliDeps {
  client: LegiStormSource;
  store: DirectorySnapshotStore;
  prisma: SyncRunCapablePrisma;
  now: () => Date;
  overlapDays: number;
  floorDate?: string;
  log?: (message: string) => void;
}

export interface SyncPlan {
  mode: DirectoryMergeMode;
  memberWindow: LegiStormDateRange;
  deltaWindow: LegiStormDateRange;
  snapshotId: string;
  publishedAt: string;
  merge: DirectorySnapshotMergeResult;
  validation: DirectorySnapshotValidationReport;
  fetched: {
    members: number;
    offices: number;
    staff: number;
    retiredOffice: number;
    retiredStaff: number;
  };
  baseline: { snapshotId: string; prefix: string; latestEtag: string };
  overlays: DirectoryCurrentSnapshot['overlays'];
  rawPages: DirectorySnapshotPublishInput['rawPages'];
}

export interface SyncCliResult {
  committed: boolean;
  plan: SyncPlan;
  published: DirectoryPublishResult | null;
}

/** Parse process.argv into CLI options. Unknown flags are ignored. */
export function parseArgs(argv: string[]): {
  commit: boolean;
  full: boolean;
  since: string | null;
  approvalFile: string | null;
} {
  const args = argv.slice(2);
  let since: string | null = null;
  let approvalFile: string | null = null;
  for (const arg of args) {
    const sinceMatch = /^--since=(.+)$/.exec(arg);
    if (sinceMatch) since = sinceMatch[1]!;
    const approvalMatch = /^--approval-file=(.+)$/.exec(arg);
    if (approvalMatch) approvalFile = approvalMatch[1]!;
  }
  return {
    commit: args.includes('--commit'),
    full: args.includes('--full'),
    since,
    approvalFile,
  };
}

function toDateStringUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDaysUTC(dateStr: string, deltaDays: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return toDateStringUTC(date);
}

function compactTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * Resolve fetch windows. Members are always the full current list; staff/offices
 * follow the mode: full -> floor..today; explicit --since -> since..today (no
 * overlap); else watermark-minus-overlap..today, falling back to the floor when
 * the source has never succeeded.
 */
export function computeWindows(
  options: SyncCliOptions,
  watermark: Date | null,
  today: string,
  overlapDays: number,
  floorDate: string,
): { members: LegiStormDateRange; delta: LegiStormDateRange } {
  const members: LegiStormDateRange = { updatedFrom: floorDate, updatedTo: today };
  if (options.full) return { members, delta: { updatedFrom: floorDate, updatedTo: today } };
  if (options.since) return { members, delta: { updatedFrom: options.since, updatedTo: today } };
  if (watermark) {
    const from = shiftDaysUTC(toDateStringUTC(watermark), -Math.max(0, overlapDays));
    return { members, delta: { updatedFrom: from, updatedTo: today } };
  }
  return { members, delta: { updatedFrom: floorDate, updatedTo: today } };
}

function mergeCountsToRunCounts(counts: DirectoryMergeCounts): RunCounts {
  return {
    inserted: counts.inserted,
    updated: counts.updated,
    skipped: counts.unchanged + counts.retired,
    errors: 0,
  };
}

/** Aggregate-only summary line — never includes source rows, names, or contacts. */
function formatSummary(plan: SyncPlan, committed: boolean): string {
  const gates = Object.fromEntries(plan.validation.gates.map((gate) => [gate.name, gate.passed]));
  const summary = {
    source: SYNC_SOURCE,
    mode: plan.mode,
    committed,
    windows: { members: plan.memberWindow, delta: plan.deltaWindow },
    fetched: plan.fetched,
    mergeCounts: plan.merge.counts,
    tombstones: {
      office: plan.merge.tombstones.office.length,
      staff: plan.merge.tombstones.staff.length,
    },
    validation: {
      valid: plan.validation.valid,
      gates,
      errors: plan.validation.errors,
      metrics: plan.validation.metrics,
    },
    proposedSnapshotId: plan.snapshotId,
    proposedPrefix: `${ROOT_PREFIX}/snapshots/${plan.snapshotId}`,
    baseline: { snapshotId: plan.baseline.snapshotId, prefix: plan.baseline.prefix },
    overlays: {
      memberBios: { key: plan.overlays.memberBios.key, sha256: plan.overlays.memberBios.sha256 },
      memberPress: { key: plan.overlays.memberPress.key, sha256: plan.overlays.memberPress.sha256 },
    },
  };
  return `SYNC_LEGISTORM_SUMMARY ${JSON.stringify(summary)}`;
}

async function buildPlan(
  deps: SyncCliDeps,
  options: SyncCliOptions,
  watermark: Date | null,
): Promise<SyncPlan> {
  const now = deps.now();
  const today = toDateStringUTC(now);
  const floorDate = deps.floorDate ?? DEFAULT_FULL_FLOOR_DATE;
  const mode: DirectoryMergeMode = options.full ? 'full' : 'incremental';
  const { members: memberWindow, delta: deltaWindow } = computeWindows(
    options,
    watermark,
    today,
    deps.overlapDays,
    floorDate,
  );

  const current = await deps.store.loadCurrentSnapshot();
  const [members, offices, staff, retiredOffice, retiredStaff] = await Promise.all([
    deps.client.fetchMembers(memberWindow),
    deps.client.fetchOffices(deltaWindow),
    deps.client.fetchStaff(deltaWindow),
    deps.client.fetchRetiredOfficeIds(),
    deps.client.fetchRetiredStaffIds(),
  ]);

  const merge = mergeDirectorySnapshot({
    mode,
    previous: current.active,
    incoming: { members: members.records, staff: staff.records, offices: offices.records },
    retiredIds: { office: retiredOffice.ids, staff: retiredStaff.ids },
  });

  const validation = validateDirectorySnapshot({
    previous: current.active,
    next: merge.active,
    retiredIds: { office: merge.tombstones.office, staff: merge.tombstones.staff },
    approval: options.approval,
  });

  return {
    mode,
    memberWindow,
    deltaWindow,
    snapshotId: `active-current-${compactTimestamp(now)}`,
    publishedAt: now.toISOString(),
    merge,
    validation,
    fetched: {
      members: members.records.length,
      offices: offices.records.length,
      staff: staff.records.length,
      retiredOffice: retiredOffice.ids.length,
      retiredStaff: retiredStaff.ids.length,
    },
    baseline: {
      snapshotId: current.pointer.snapshot_id,
      prefix: current.pointer.snapshot_prefix,
      latestEtag: current.latestEtag,
    },
    overlays: current.overlays,
    rawPages: { members: members.rawPages, offices: offices.rawPages, staff: staff.rawPages },
  };
}

/**
 * Orchestrate one refresh. Dry-run (default) reads only and publishes nothing;
 * commit wraps the run in `runWithSyncRun` and publishes when validation passes.
 */
export async function runSyncLegistormDirectory(
  deps: SyncCliDeps,
  options: SyncCliOptions,
): Promise<SyncCliResult> {
  const log = deps.log ?? (() => {});

  if (!options.commit) {
    // Dry run: resolve the watermark by READ only (no SyncRun row is opened).
    const watermark = await lastSuccessfulWatermark(deps.prisma, SYNC_SOURCE);
    const plan = await buildPlan(deps, options, watermark);
    log(formatSummary(plan, false));
    return { committed: false, plan, published: null };
  }

  // Holder (not a bare `let`) so the value assigned inside the callback survives
  // TypeScript's closure narrowing after the await.
  const holder: { result?: { plan: SyncPlan; published: DirectoryPublishResult } } = {};
  await runWithSyncRun(deps.prisma, SYNC_SOURCE, async (ctx) => {
    const plan = await buildPlan(deps, options, ctx.since);
    log(formatSummary(plan, true));
    if (!plan.validation.valid) {
      throw new Error('directory snapshot validation failed; snapshot not published');
    }
    const published = await deps.store.publish({
      baseline: { snapshotId: plan.baseline.snapshotId, latestEtag: plan.baseline.latestEtag },
      approval: options.approval as DirectoryValidationApproval | undefined,
      snapshotId: plan.snapshotId,
      publishedAt: plan.publishedAt,
      rawPages: plan.rawPages,
      active: plan.merge.active,
      tombstones: plan.merge.tombstones,
      validation: plan.validation,
    });
    holder.result = { plan, published };
    return mergeCountsToRunCounts(plan.merge.counts.total);
  });

  if (!holder.result) throw new Error('commit run produced no result');
  return { committed: true, plan: holder.result.plan, published: holder.result.published };
}

async function main(): Promise<void> {
  dotenvConfig();
  const parsed = parseArgs(process.argv);

  const apiKey = (process.env.LEGISTORM_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('LEGISTORM_API_KEY is required');
  const bucket = process.env.DIRECTORY_S3_BUCKET ?? 'updated-directory-967807252336-us-east-1';
  const region = process.env.AWS_REGION_DEFAULT ?? process.env.AWS_REGION ?? 'us-east-1';
  const overlapDays = Number(process.env.LEGISTORM_OVERLAP_DAYS ?? 2);

  const numeric = (value: string | undefined): number | undefined =>
    value === undefined ? undefined : Number(value);

  const client = new LegiStormClient({
    apiKey,
    baseUrl: process.env.LEGISTORM_BASE_URL,
    pageSize: numeric(process.env.LEGISTORM_PAGE_SIZE),
    maxPages: numeric(process.env.LEGISTORM_MAX_PAGES),
    requestDelayMs: numeric(process.env.LEGISTORM_REQUEST_DELAY_MS),
    requestTimeoutMs: numeric(process.env.LEGISTORM_REQUEST_TIMEOUT_MS),
    maxRetryDelayMs: numeric(process.env.LEGISTORM_MAX_RETRY_DELAY_MS),
  });
  const store = new DirectorySnapshotPublisher({
    s3: new S3Client({ region }),
    bucket,
    rootPrefix: ROOT_PREFIX,
  });
  const prisma = new PrismaClient();

  let approval: unknown;
  if (parsed.approvalFile) {
    approval = JSON.parse(readFileSync(parsed.approvalFile, 'utf8'));
  }

  try {
    const result = await runSyncLegistormDirectory(
      {
        client,
        store,
        prisma,
        now: () => new Date(),
        overlapDays,
        log: (message) => console.log(message),
      },
      { commit: parsed.commit, full: parsed.full, since: parsed.since, approval },
    );

    if (!result.plan.validation.valid) {
      console.error(
        '[sync-legistorm-directory] validation failed — not publishable (see gates above)',
      );
      process.exitCode = 1;
    }
    if (!parsed.commit) {
      console.log(
        '[sync-legistorm-directory] DRY RUN — no S3 or database writes. Pass --commit to publish.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[sync-legistorm-directory] FAILED', (error as Error).message);
    process.exit(1);
  });
}
