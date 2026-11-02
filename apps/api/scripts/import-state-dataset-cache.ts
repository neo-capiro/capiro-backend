/** @cleanup-smoke noArgsExit=2 */
/** Offline frozen archive staging/import; never queries the provider. */
import 'dotenv/config';
import { readFileSync, statSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { ALL_US_STATE_CODES } from '../src/external/legiscan/us-states.js';
import {
  inspectFrozenStateDataset,
  importFrozenStateDataset,
} from '../src/ingestion/legiscan-historical-research.js';
import {
  importFrozenStateFormats,
  inspectFrozenStateFormats,
} from '../src/ingestion/legiscan-frozen-formats.js';

const HOST = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const USAGE =
  'import-state-dataset-cache --state XX --session ID --expected-bills N (--archive FILE --sha256 SHA256 | --archive-hash SHA256) [--limit 1..1000] [--inventory-only | --formats-only] [--commit --expected-host CLONE_HOST]';
export function parseCacheArgs(argv: string[], env: NodeJS.ProcessEnv) {
  let state = '',
    sessionId = 0,
    expectedBills = 0,
    archiveHash = '',
    archivePath = '',
    storedHash = '',
    limit = 100,
    expectedHost = '',
    commit = false,
    inventoryOnly = false,
    formatsOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--commit') commit = true;
    else if (key === '--inventory-only') inventoryOnly = true;
    else if (key === '--formats-only') formatsOnly = true;
    else if (key === '--state') state = argv[++i] ?? '';
    else if (key === '--session') sessionId = Number(argv[++i]);
    else if (key === '--expected-bills') expectedBills = Number(argv[++i]);
    else if (key === '--archive') archivePath = argv[++i] ?? '';
    else if (key === '--sha256') archiveHash = argv[++i] ?? '';
    else if (key === '--archive-hash') storedHash = argv[++i] ?? '';
    else if (key === '--limit') limit = Number(argv[++i]);
    else if (key === '--expected-host') expectedHost = argv[++i] ?? '';
    else throw Error('UNKNOWN_CACHE_ARGUMENT');
  }
  if (
    (inventoryOnly && formatsOnly) ||
    !(ALL_US_STATE_CODES as readonly string[]).includes(state) ||
    !Number.isSafeInteger(sessionId) ||
    sessionId < 1 ||
    !Number.isInteger(expectedBills) ||
    expectedBills < 1 ||
    expectedBills > 50000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    (storedHash ? Boolean(archivePath || archiveHash) : !archivePath) ||
    !/^[a-f\d]{64}$/.test(storedHash || archiveHash)
  )
    throw Error('INVALID_CACHE_SCOPE');
  if (commit || storedHash) {
    if (!env.DATABASE_URL) throw Error('DATABASE_URL_REQUIRED');
    const db = new URL(env.DATABASE_URL);
    if (
      db.hostname !== HOST ||
      db.pathname !== '/capiro' ||
      !['postgres:', 'postgresql:'].includes(db.protocol) ||
      (commit && expectedHost !== HOST)
    )
      throw Error('CACHE_DATABASE_MISMATCH');
  }
  return {
    state,
    sessionId,
    expectedBills,
    archiveHash: storedHash || archiveHash,
    archivePath,
    limit,
    commit,
    inventoryOnly,
    formatsOnly,
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
  const options = parseCacheArgs(argv, process.env);
  const prisma = options.commit || !options.archivePath ? new PrismaClient() : null;
  try {
    let archive: Buffer;
    if (options.archivePath) {
      const stat = statSync(options.archivePath);
      if (!stat.isFile() || stat.size > 120000000) throw Error('DATASET_COMPRESSED_SIZE_LIMIT');
      archive = readFileSync(options.archivePath);
    } else {
      const rows = await prisma!.$queryRaw<
        Array<{ bytes: string }>
      >`SELECT original_bytes_base64 AS bytes FROM legal_dataset_archive WHERE content_hash=${options.archiveHash}`;
      if (rows.length !== 1 || rows[0]!.bytes.length > 160000000)
        throw Error('STAGED_ARCHIVE_MISSING_OR_TOO_LARGE');
      archive = Buffer.from(rows[0]!.bytes, 'base64');
    }
    if (options.commit) {
      console.log(
        'FROZEN_STATE_DATASET_RESULT ' +
          JSON.stringify(
            await (options.formatsOnly ? importFrozenStateFormats : importFrozenStateDataset)(
              prisma!,
              archive,
              options,
              options,
            ),
          ),
      );
    } else {
      const formats = options.formatsOnly
        ? await inspectFrozenStateFormats(archive, options)
        : null;
      const prepared = formats?.prepared ?? (await inspectFrozenStateDataset(archive, options));
      console.log(
        'FROZEN_STATE_DATASET_PREVIEW ' +
          JSON.stringify({
            state: options.state,
            sessionId: options.sessionId,
            sessionKey: prepared.sessionKey,
            archiveHash: options.archiveHash,
            inspectedBills: prepared.manifest.inspectedBills,
            eligibleBills: prepared.manifest.eligibleBills,
            documents: prepared.manifest.bills.reduce((n, b) => n + b.documents.length, 0),
            ...(formats
              ? {
                  alternateFormats: formats.manifest.bills.reduce(
                    (n, b) => n + b.formats.length,
                    0,
                  ),
                }
              : {}),
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
