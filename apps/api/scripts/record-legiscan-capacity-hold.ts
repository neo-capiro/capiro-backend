/** @cleanup-smoke noArgsExit=2 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  recordLegiscanCapacityHold,
  releaseLegiscanCapacityHold,
} from '../src/ingestion/legiscan-provider-capacity.js';
const HOST = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const USAGE =
  'record-legiscan-capacity-hold --month YYYY-MM --observed-used N --observed-limit N [--release --confirmed-account-change] [--commit --expected-host CLONE_HOST]';
export function parseCapacityArgs(argv: string[], env: NodeJS.ProcessEnv) {
  let month = '',
    used = NaN,
    limit = NaN,
    release = false,
    confirmed = false,
    commit = false,
    host = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--month') month = argv[++i] ?? '';
    else if (argv[i] === '--observed-used') used = Number(argv[++i]);
    else if (argv[i] === '--observed-limit') limit = Number(argv[++i]);
    else if (argv[i] === '--release') release = true;
    else if (argv[i] === '--confirmed-account-change') confirmed = true;
    else if (argv[i] === '--commit') commit = true;
    else if (argv[i] === '--expected-host') host = argv[++i] ?? '';
    else throw Error('UNKNOWN_CAPACITY_ARGUMENT');
  }
  if (
    month !== new Date().toISOString().slice(0, 7) ||
    !Number.isSafeInteger(used) ||
    used < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    (release ? !confirmed || used >= limit : confirmed || used < limit)
  )
    throw Error('INVALID_CAPACITY_OBSERVATION');
  if (commit) {
    if (!env.DATABASE_URL || !env.LEGISCAN_API_KEY) throw Error('CAPACITY_CONFIGURATION_REQUIRED');
    const db = new URL(env.DATABASE_URL);
    if (
      host !== HOST ||
      db.hostname !== HOST ||
      db.pathname !== '/capiro' ||
      !['postgres:', 'postgresql:'].includes(db.protocol)
    )
      throw Error('CAPACITY_DATABASE_MISMATCH');
  }
  return { month, reportedUsed: used, reportedLimit: limit, release, commit };
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
  const options = parseCapacityArgs(argv, process.env);
  if (options.commit) {
    const db = new PrismaClient();
    try {
      if (options.release) await releaseLegiscanCapacityHold(db, process.env.LEGISCAN_API_KEY!);
      else await recordLegiscanCapacityHold(db, process.env.LEGISCAN_API_KEY!, options);
    } finally {
      await db.$disconnect();
    }
  }
  console.log(
    'LEGISCAN_CAPACITY_STATUS ' +
      JSON.stringify({
        month: options.month,
        held: !options.release,
        committed: options.commit,
        providerCalls: 0,
        restartRequired: options.release,
      }),
  );
}
if (require.main === module)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'CAPACITY_OPERATION_FAILED');
    process.exitCode = 1;
  });
