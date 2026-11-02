/** @cleanup-smoke noArgsExit=2 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createCongressRequestPacer } from '../src/ingestion/congress-request-pacer.js';
import { fetchCongressJson } from '../src/ingestion/congress-http.js';
import { withFederalBillWriter } from '../src/ingestion/federal-bill-writer.js';
import {
  enumerateFederalInventories,
  finalizeFederalDiscovery,
  loadFederalGeneration,
} from '../src/ingestion/federal-bill-inventory.js';
import { hydrateFederalInventories } from '../src/ingestion/federal-bill-hydration.js';
import { refreshHeldFederalMetadata } from '../src/ingestion/federal-bill-metadata.js';

const HOST = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const USAGE =
  'sync-federal-bill-inventory --congress 119 --archive-hashes HASH,...(8) --amendment-list-hash HASH --stage inventory|metadata|hydrate|finalize [--expected-amendments 7119] [--limit 1..1000] [--request-cap 1..4800] [--commit --expected-host CLONE_HOST]';
export function parseFederalInventoryArgs(argv: string[], env: NodeJS.ProcessEnv) {
  let congress = 0,
    archiveHashes: string[] = [],
    amendmentListHash = '',
    stage = '',
    expectedAmendments = 7119,
    limit = 100,
    requestCap = 100,
    commit = false,
    expectedHost = '';
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--congress') congress = Number(argv[++i]);
    else if (key === '--archive-hashes') archiveHashes = (argv[++i] ?? '').split(',');
    else if (key === '--amendment-list-hash') amendmentListHash = argv[++i] ?? '';
    else if (key === '--stage') stage = argv[++i] ?? '';
    else if (key === '--expected-amendments') expectedAmendments = Number(argv[++i]);
    else if (key === '--limit') limit = Number(argv[++i]);
    else if (key === '--request-cap') requestCap = Number(argv[++i]);
    else if (key === '--commit') commit = true;
    else if (key === '--expected-host') expectedHost = argv[++i] ?? '';
    else throw Error('UNKNOWN_FEDERAL_INVENTORY_ARGUMENT');
  }
  if (
    congress !== 119 ||
    archiveHashes.length !== 8 ||
    new Set(archiveHashes).size !== 8 ||
    [...archiveHashes, amendmentListHash].some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
    !['inventory', 'metadata', 'hydrate', 'finalize'].includes(stage) ||
    !Number.isInteger(expectedAmendments) ||
    expectedAmendments < 1 ||
    expectedAmendments > 100000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isInteger(requestCap) ||
    requestCap < 1 ||
    requestCap > 4800
  )
    throw Error('INVALID_FEDERAL_INVENTORY_SCOPE');
  if (!env.DATABASE_URL) throw Error('DATABASE_URL_REQUIRED');
  const db = new URL(env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(db.protocol) ||
    db.hostname !== HOST ||
    db.pathname !== '/capiro' ||
    (commit && expectedHost !== HOST)
  )
    throw Error('FEDERAL_INVENTORY_DATABASE_MISMATCH');
  if (commit && ['inventory', 'metadata'].includes(stage) && !env.CONGRESS_API_KEY)
    throw Error('CONGRESS_API_KEY_REQUIRED');
  return {
    congress,
    archiveHashes,
    amendmentListHash,
    stage: stage as 'inventory' | 'metadata' | 'hydrate' | 'finalize',
    expectedAmendments,
    limit,
    requestCap,
    commit,
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
  const options = parseFederalInventoryArgs(argv, process.env),
    prisma = new PrismaClient();
  try {
    if (!options.commit) {
      const generation = await loadFederalGeneration(
        prisma,
        options.archiveHashes,
        options.amendmentListHash,
        options.congress,
        options.expectedAmendments,
      );
      console.log(
        'FEDERAL_BILL_INVENTORY_PREVIEW ' +
          JSON.stringify({
            stage: options.stage,
            bills: generation.billIds.length,
            amendments: generation.amendments.length,
            providerCalls: 0,
            mutations: 0,
          }),
      );
      return;
    }
    await withFederalBillWriter(prisma, async (db) => {
      const generation = await loadFederalGeneration(
        db,
        options.archiveHashes,
        options.amendmentListHash,
        options.congress,
        options.expectedAmendments,
      );
      const pacer = createCongressRequestPacer({ limit: options.requestCap });
      const beforeAttempt = async () => {
        await pacer.beforeAttempt();
        await db.$queryRawUnsafe('SELECT 1');
      };
      const result =
        options.stage === 'inventory'
          ? await enumerateFederalInventories(db, generation, {
              limit: options.limit,
              apiKey: process.env.CONGRESS_API_KEY!,
              fetchJson: (url) => fetchCongressJson(url, { beforeAttempt }),
            })
          : options.stage === 'metadata'
            ? await refreshHeldFederalMetadata(db, generation, {
                limit: options.limit,
                apiKey: process.env.CONGRESS_API_KEY!,
                fetchJson: (url) => fetchCongressJson(url, { beforeAttempt }),
              })
            : options.stage === 'hydrate'
              ? await hydrateFederalInventories(db, generation, {
                  limit: options.limit,
                  beforeAttempt,
                })
              : await finalizeFederalDiscovery(db, generation);
      console.log(
        'FEDERAL_BILL_INVENTORY_RESULT ' +
          JSON.stringify({ stage: options.stage, ...result, providerCalls: pacer.count() }),
      );
    });
  } finally {
    await prisma.$disconnect();
  }
}
if (require.main === module)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
