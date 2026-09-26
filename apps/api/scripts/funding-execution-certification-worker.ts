/** Package 6 certification worker; all persistence is through the narrow store port. */
import type { FundingExecutionFact } from '../src/program-element/funding-execution/funding-execution-read.service.js';
import { FundingExecutionStore } from '../src/funding-execution/funding-execution.store.js';
import type {
  CertifiedFundingExecutionPublication,
  FundingExecutionCheckpoint,
  FundingExecutionPublicationPort,
} from '../src/funding-execution/funding-execution-worker.types.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

export type {
  FundingExecutionCheckpoint,
  FundingExecutionPublicationPort,
  FundingExecutionWorkerPage,
} from '../src/funding-execution/funding-execution-worker.types.js';

export interface FundingExecutionWorkerResult {
  mode: 'DRY_RUN' | 'COMMIT';
  examined: number;
  publishable: number;
  published: number;
  rejected: number;
  hasMore: boolean;
  cursor: string | null;
  throughId: string | null;
  checkpointAdvanced: boolean;
}

const MAX_BATCH = 5_000;

export function fundingExecutionWritesEnabled(commit: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return commit && env.FUNDING_EXECUTION_PUBLICATION_ENABLED === 'true';
}

export async function runFundingExecutionCertificationWorker(
  port: FundingExecutionPublicationPort,
  options: { commit: boolean; limit: number; env?: NodeJS.ProcessEnv },
): Promise<FundingExecutionWorkerResult> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_BATCH) {
    throw new Error(`limit must be an integer between 1 and ${MAX_BATCH}`);
  }
  const enabled = fundingExecutionWritesEnabled(options.commit, options.env);
  const prior = await port.loadCheckpoint();
  // A completed window is also the durable low-water mark for the next run.
  // Starting from null would replay the full allocation history on every
  // schedule. The port freezes a new through-watermark when throughId is null.
  const checkpoint = prior?.complete
    ? { version: 1 as const, cursor: prior.throughId, throughId: null, complete: false }
    : prior;
  const page = await port.readBoundedPage({
    cursor: checkpoint?.cursor ?? null,
    throughId: checkpoint?.throughId ?? null,
    take: options.limit + 1,
  });
  if (page.rows.length > options.limit + 1) throw new Error('worker port exceeded the requested bounded page');
  const boundedRows = page.rows.slice(0, options.limit);
  const hasMore = page.hasMore || page.rows.length > options.limit;
  const cursor = hasMore ? page.nextCursor : null;
  if (hasMore && !cursor) throw new Error('worker port reported continuation without a cursor');
  const publications = boundedRows.flatMap(toCertifiedPublication);
  let published = 0;
  let checkpointAdvanced = false;
  if (enabled) {
    if (publications.length) published = (await port.publishCertified(publications)).published;
    const next: FundingExecutionCheckpoint = {
      version: 1,
      cursor,
      throughId: page.throughId,
      complete: !hasMore,
    };
    if (page.throughId !== null || boundedRows.length > 0) {
      // Persistence follows publication; a retry before this point is safe only
      // because the narrow publisher is idempotent by source fact identity.
      await port.saveCheckpoint(next);
      checkpointAdvanced = true;
    }
  }
  return {
    mode: enabled ? 'COMMIT' : 'DRY_RUN',
    examined: boundedRows.length,
    publishable: publications.length,
    published,
    rejected: boundedRows.length - publications.length,
    hasMore,
    cursor,
    throughId: page.throughId,
    checkpointAdvanced,
  };
}

function toCertifiedPublication(row: FundingExecutionFact): CertifiedFundingExecutionPublication[] {
  if (
    (row.measure === 'transfer_leg' || row.measure === 'residual') ||
    row.authorityState !== 'enacted' ||
    row.allocationCertification !== 'certified' || row.reviewState !== 'verified' ||
    !row.exactAccountLevel || !row.accountId || !row.amountUsd ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(row.amountUsd) || row.evidence.length === 0
  ) return [];
  const sourceNativeIds = [...new Set(row.evidence.map((item) => item.sourceNativeId).filter((id): id is string => !!id))];
  if (sourceNativeIds.length === 0) return [];
  return [{
    factId: row.factId,
    authorityState: 'enacted',
    accountId: row.accountId,
    amountUsd: row.amountUsd,
    certification: 'certified',
    verification: 'verified',
    exactAccountLevel: true,
    sourceNativeIds,
  }];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index < 0 ? undefined : args[index + 1];
  };
  const limit = Number(value('limit') ?? 100);
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const store = new FundingExecutionStore(prisma);
    const result = await runFundingExecutionCertificationWorker(store, { commit: args.includes('--commit'), limit });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/funding-execution-certification-worker.ts')) {
  void main().catch(() => {
    console.error('Funding/execution certification worker failed; source or database details withheld.');
    process.exit(1);
  });
}
