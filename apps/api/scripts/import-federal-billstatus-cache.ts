/** @cleanup-smoke noArgsExit=2 */
import 'dotenv/config';
import { readFileSync, statSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  FEDERAL_BILL_TYPES,
  inspectFrozenFederalBillStatus,
  type FederalBillType,
} from '../src/ingestion/federal-billstatus.js';
import { importFrozenFederalBillStatus } from '../src/ingestion/federal-billstatus-import.js';

const HOST = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const USAGE =
  'import-federal-billstatus-cache --congress 119 --type TYPE --expected-bills N (--archive FILE --sha256 HASH | --archive-hash HASH) [--limit 1..1000] [--inventory-only] [--commit --expected-host CLONE_HOST]';
export function parseFederalCacheArgs(argv: string[], env: NodeJS.ProcessEnv) {
  let congress = 0,
    billType = '',
    expectedBills = 0,
    archivePath = '',
    archiveHash = '',
    storedHash = '',
    limit = 100,
    commit = false,
    inventoryOnly = false,
    expectedHost = '',
    amendmentListPath = '',
    amendmentListHash = '',
    expectedAmendments = 7119;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--congress') congress = Number(argv[++i]);
    else if (key === '--type') billType = argv[++i] ?? '';
    else if (key === '--expected-bills') expectedBills = Number(argv[++i]);
    else if (key === '--archive') archivePath = argv[++i] ?? '';
    else if (key === '--sha256') archiveHash = argv[++i] ?? '';
    else if (key === '--archive-hash') storedHash = argv[++i] ?? '';
    else if (key === '--limit') limit = Number(argv[++i]);
    else if (key === '--commit') commit = true;
    else if (key === '--inventory-only') inventoryOnly = true;
    else if (key === '--expected-host') expectedHost = argv[++i] ?? '';
    else if (key === '--amendment-list') amendmentListPath = argv[++i] ?? '';
    else if (key === '--amendment-list-sha256') amendmentListHash = argv[++i] ?? '';
    else if (key === '--expected-amendments') expectedAmendments = Number(argv[++i]);
    else throw Error('UNKNOWN_FEDERAL_CACHE_ARGUMENT');
  }
  if (
    congress !== 119 ||
    !(FEDERAL_BILL_TYPES as readonly string[]).includes(billType) ||
    !Number.isInteger(expectedBills) ||
    expectedBills < 1 ||
    expectedBills > 50000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    (storedHash ? Boolean(archivePath || archiveHash) : !archivePath) ||
    !/^[a-f0-9]{64}$/.test(storedHash || archiveHash) ||
    Boolean(amendmentListPath) !== Boolean(amendmentListHash) ||
    (amendmentListHash && !/^[a-f0-9]{64}$/.test(amendmentListHash)) ||
    !Number.isInteger(expectedAmendments) ||
    expectedAmendments < 1 ||
    expectedAmendments > 100000
  )
    throw Error('INVALID_FEDERAL_CACHE_SCOPE');
  if (commit || storedHash) {
    if (!env.DATABASE_URL) throw Error('DATABASE_URL_REQUIRED');
    const db = new URL(env.DATABASE_URL);
    if (
      !['postgres:', 'postgresql:'].includes(db.protocol) ||
      db.hostname !== HOST ||
      db.pathname !== '/capiro' ||
      (commit && expectedHost !== HOST)
    )
      throw Error('FEDERAL_CACHE_DATABASE_MISMATCH');
  }
  return {
    congress,
    billType: billType as FederalBillType,
    expectedBills,
    archivePath,
    archiveHash: storedHash || archiveHash,
    limit,
    commit,
    inventoryOnly,
    amendmentListPath,
    amendmentListHash,
    expectedAmendments,
  };
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  if (!argv.length) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const options = parseFederalCacheArgs(argv, process.env),
    prisma = options.commit || !options.archivePath ? new PrismaClient() : null;
  try {
    let archive: Buffer;
    if (options.archivePath) {
      const stat = statSync(options.archivePath);
      if (!stat.isFile() || stat.size > 120_000_000) throw Error('BILLSTATUS_ARCHIVE_SIZE_LIMIT');
      archive = readFileSync(options.archivePath);
    } else {
      const rows = await prisma!.$queryRawUnsafe<Array<{ bytes: string }>>(
        'SELECT original_bytes_base64 AS bytes FROM legal_dataset_archive WHERE content_hash=$1',
        options.archiveHash,
      );
      if (rows.length !== 1 || rows[0]!.bytes.length > 160_000_000)
        throw Error('BILLSTATUS_STAGED_ARCHIVE_MISSING');
      archive = Buffer.from(rows[0]!.bytes, 'base64');
    }
    let amendmentList: { bytes: Buffer; hash: string; expectedCount: number } | undefined;
    if (options.amendmentListPath) {
      const stat = statSync(options.amendmentListPath);
      if (!stat.isFile() || stat.size > 10_000_000)
        throw Error('FEDERAL_AMENDMENT_LIST_SIZE_LIMIT');
      amendmentList = {
        bytes: readFileSync(options.amendmentListPath),
        hash: options.amendmentListHash,
        expectedCount: options.expectedAmendments,
      };
    }
    if (options.commit)
      console.log(
        'FROZEN_FEDERAL_BILLSTATUS_RESULT ' +
          JSON.stringify(
            await importFrozenFederalBillStatus(prisma!, archive, options, {
              ...options,
              amendmentList,
            }),
          ),
      );
    else {
      const prepared = await inspectFrozenFederalBillStatus(archive, options);
      console.log(
        'FROZEN_FEDERAL_BILLSTATUS_PREVIEW ' +
          JSON.stringify({
            inspectedBills: prepared.bills.length,
            eligibleBills: prepared.eligible.length,
            amendments: prepared.manifest.amendments.length,
            versions: prepared.eligible.reduce((n, b) => n + b.versions.length, 0),
            providerCalls: 0,
            mutations: 0,
          }),
      );
    }
  } finally {
    await prisma?.$disconnect();
  }
}
if (require.main === module)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
