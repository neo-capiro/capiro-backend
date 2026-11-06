/** Bounded account mode for the existing enrichment runner; no import-time effects. */
import { PrismaClient } from '@prisma/client';
import { openSync, readSync, closeSync } from 'node:fs';
import { runPrismaTransaction } from '../../src/prisma/prisma-transaction-deadline.js';
import { fetchAccountCohort, parseAccountModeArgs, type CohortFetchResult } from './procurement-account-reports.js';
import { parseAwardEnrichmentFile, MAX_ENRICHMENT_FILE_BYTES, continuityWritesEnabled } from './procurement-award-enrichment.js';
import { awardKey } from './sam-contract-action.js';
export { parseAccountModeArgs };
export type AccountRunnerOptions = { committed?: boolean; acknowledgements?: Ack[] };
type Ack = { awardUniqueId: string; snapshotId: string; inserted: boolean };
export interface AccountRunnerReceipt {
  contract: 'procurement-account-report/1'; mode: 'DRY_RUN' | 'COMMIT';
  status: 'VALIDATED' | 'COMMITTED' | 'TRANSACTION_OUTCOME_UNRESOLVED' | 'FETCH_FAILURE';
  requested: number; inserted: number | null; existing: number | null;
  awards: Array<{ awardUniqueId: string; sha256: string; sourceObservedAt: string; rowCount: number; snapshotId?: string; inserted?: boolean }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function mainGateFails(args: readonly string[]) {
  return args.some(token => token.startsWith('--account') && token !== '--account-award-ids-file');
}
export function parseAccountGate(args: readonly string[]) {
  if (mainGateFails(args)) throw new Error('ACCOUNT_ARGUMENT_ERROR');
  return parseAccountModeArgs(args);
}
export function buildAccountRunnerReceipt(cohort: readonly CohortFetchResult[], opts?: AccountRunnerOptions): AccountRunnerReceipt {
  const mode = opts ? 'COMMIT' : 'DRY_RUN';
  const acks = opts?.acknowledgements ?? [];
  const complete = opts?.committed === true && acks.length === cohort.length &&
    new Set(acks.map(a => a.awardUniqueId)).size === cohort.length &&
    acks.every(a => uuid.test(a.snapshotId) && typeof a.inserted === 'boolean' && cohort.some(c => c.awardUniqueId === a.awardUniqueId));
  const failed = cohort.some(c => !c.outcome.ok);
  const committed = complete && !failed;
  const awards = cohort.flatMap(c => {
    if (!c.outcome.ok) return []; // Only successful source observations have a receipt.
    const ack = committed ? acks.find(a => a.awardUniqueId === c.awardUniqueId) : undefined;
    return [{ awardUniqueId: c.awardUniqueId, sha256: c.outcome.page.sha256,
      sourceObservedAt: c.outcome.page.sourceObservedAt, rowCount: c.outcome.page.rowCount,
      ...(ack ? { snapshotId: ack.snapshotId, inserted: ack.inserted } : {}) }];
  });
  return { contract: 'procurement-account-report/1', mode,
    status: failed ? 'FETCH_FAILURE' : mode === 'DRY_RUN' ? 'VALIDATED' : committed ? 'COMMITTED' : 'TRANSACTION_OUTCOME_UNRESOLVED',
    requested: cohort.length, awards,
    inserted: committed ? acks.filter(a => a.inserted).length : null,
    existing: committed ? acks.filter(a => !a.inserted).length : null };
}
function readIds(file: string) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(MAX_ENRICHMENT_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length);
      if (!n) break; length += n;
    }
    return parseAwardEnrichmentFile(new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { closeSync(fd); }
}
const emit = (receipt: AccountRunnerReceipt) => console.log(JSON.stringify(receipt, null, 2));
/** Returns an exit code; always releases its own DB client, including failures. */
export async function runAccountMode(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let options: NonNullable<ReturnType<typeof parseAccountGate>>;
  try { const parsed = parseAccountGate(args); if (!parsed) throw new Error(); options = parsed; }
  catch { console.error('ACCOUNT_ARGUMENT_ERROR: use --account-award-ids-file <file> and optional --commit'); return 2; }
  let ids: string[];
  try { ids = readIds(options.accountAwardIdsFile); }
  catch { console.error('ACCOUNT_FILE_ERROR: bounded award-ID file is unreadable or invalid'); return 2; }
  const write = continuityWritesEnabled(options.commit, env);
  let connection: URL | undefined;
  if (write) {
    try {
      if (!env.ACCOUNT_EXPECTED_HOST || !env.ACCOUNT_EXPECTED_DATABASE || !env.ACCOUNT_EXPECTED_USER || !env.DATABASE_URL) throw new Error();
      connection = new URL(env.DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(connection.protocol) ||
        connection.hostname !== env.ACCOUNT_EXPECTED_HOST ||
        decodeURIComponent(connection.pathname.slice(1)) !== env.ACCOUNT_EXPECTED_DATABASE ||
        decodeURIComponent(connection.username) !== env.ACCOUNT_EXPECTED_USER ||
        (connection.port || '5432') !== (env.ACCOUNT_EXPECTED_PORT || '5432')) throw new Error();
      const oldTimeout = Number(connection.searchParams.get('connect_timeout'));
      connection.searchParams.set('connect_timeout', String(oldTimeout > 0 ? Math.min(oldTimeout, 10) : 10));
    } catch { console.error('ACCOUNT_WRONG_TARGET: require matching DATABASE_URL and ACCOUNT_EXPECTED_HOST/DATABASE/USER/PORT'); return 2; }
  }
  let cohort: CohortFetchResult[];
  try { cohort = await fetchAccountCohort(ids); }
  catch { console.error('ACCOUNT_FETCH_FAILURE: source collection refused'); return 1; }
  if (cohort.some(c => !c.outcome.ok)) { emit(buildAccountRunnerReceipt(cohort, write ? { committed: false } : undefined)); return 1; }
  if (!write) { emit(buildAccountRunnerReceipt(cohort)); return 0; }
  const prisma = new PrismaClient({ datasourceUrl: connection!.toString() });
  let writing = false, mismatch = false;
  try {
    await prisma.$connect();
    const acknowledgements = await runPrismaTransaction<Ack[]>(
      (work, engine) => prisma.$transaction(work, engine),
      async tx => {
        const identity = await tx.$queryRaw<Array<{ db: string; role: string }>>`SELECT current_database() AS db,current_user AS role`;
        if (identity.length !== 1 || identity[0]!.db !== env.ACCOUNT_EXPECTED_DATABASE || identity[0]!.role !== env.ACCOUNT_EXPECTED_USER) {
          mismatch = true; throw new Error('ACCOUNT_TARGET_MISMATCH');
        }
        await tx.$executeRaw`SET LOCAL lock_timeout='1s'`;
      },
      async tx => {
        const result: Ack[] = [];
        for (const entry of cohort) {
          if (!entry.outcome.ok) throw new Error('UNVALIDATED_COHORT');
          const page = entry.outcome.page;
          writing = true;
          const rows = await tx.$queryRaw<Array<{ result: { snapshotId: string; inserted: boolean } }>>`
            SELECT public.defproc_append_account_report_v1(${awardKey(entry.awardUniqueId)}::text,
              ${page.sourceObservedAt}::text,${page.rawText}::text,${page.sha256}::text) AS result`;
          const ack = rows[0]?.result;
          if (rows.length !== 1 || !ack || !uuid.test(ack.snapshotId) || typeof ack.inserted !== 'boolean') throw new Error('INVALID_ACKNOWLEDGEMENT');
          result.push({ awardUniqueId: entry.awardUniqueId, ...ack });
        }
        return result;
      }, { timeoutMs: 15000, deadline: { at: Date.now() + 15000 } },
    );
    const receipt = buildAccountRunnerReceipt(cohort, { committed: true, acknowledgements });
    emit(receipt); return receipt.status === 'COMMITTED' ? 0 : 1;
  } catch {
    // Never print arbitrary server error text or infer rollback from a lost commit acknowledgement.
    if (writing) emit(buildAccountRunnerReceipt(cohort, { committed: false }));
    console.error(mismatch ? 'ACCOUNT_WRONG_TARGET: effective database/user mismatch' : 'ACCOUNT_DATABASE_FAILURE: no automatic retry');
    return mismatch ? 2 : 1;
  } finally { await prisma.$disconnect(); }
}
