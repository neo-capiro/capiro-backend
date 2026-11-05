/** @cleanup-smoke noArgsExit=2 */
import 'dotenv/config';
import { readFileSync, statSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  inspectStateDiscovery,
  retainStateDiscovery,
} from '../src/ingestion/state-discovery-inventory.js';
const HOST = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const USAGE =
  'import-state-discovery --manifest FILE --sha256 SHA256 [--commit --expected-host CLONE_HOST]';
export function parseDiscoveryArgs(argv: string[], env: NodeJS.ProcessEnv) {
  let path = '',
    hash = '',
    expectedHost = '',
    commit = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') path = argv[++i] ?? '';
    else if (argv[i] === '--sha256') hash = argv[++i] ?? '';
    else if (argv[i] === '--expected-host') expectedHost = argv[++i] ?? '';
    else if (argv[i] === '--commit') commit = true;
    else throw Error('UNKNOWN_DISCOVERY_ARGUMENT');
  }
  if (!path || !/^[a-f\d]{64}$/.test(hash)) throw Error('DISCOVERY_SOURCE_REQUIRED');
  if (commit) {
    if (!env.DATABASE_URL) throw Error('DATABASE_URL_REQUIRED');
    const url = new URL(env.DATABASE_URL);
    if (
      expectedHost !== HOST ||
      url.hostname !== HOST ||
      url.pathname !== '/capiro' ||
      !['postgres:', 'postgresql:'].includes(url.protocol)
    )
      throw Error('DISCOVERY_DATABASE_MISMATCH');
  }
  return { path, hash, commit };
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
  const options = parseDiscoveryArgs(argv, process.env),
    stat = statSync(options.path);
  if (!stat.isFile() || stat.size > 2000000) throw Error('DISCOVERY_MANIFEST_HASH_OR_SIZE');
  const bytes = readFileSync(options.path),
    manifest = inspectStateDiscovery(bytes, options.hash);
  if (!options.commit) {
    console.log(
      'STATE_DISCOVERY_PREVIEW ' +
        JSON.stringify({
          manifestSha256: options.hash,
          jurisdictions: manifest.states.length,
          sessions: manifest.states.reduce((n, s) => n + s.sessions.length, 0),
          providerCalls: 0,
          mutations: 0,
        }),
    );
    return;
  }
  const prisma = new PrismaClient();
  try {
    console.log(
      'STATE_DISCOVERY_RESULT ' +
        JSON.stringify(await retainStateDiscovery(prisma, bytes, options.hash)),
    );
  } finally {
    await prisma.$disconnect();
  }
}
if (require.main === module)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
