/** Canonical public funding ingestion. Dry-run by default; no Meri/client writes. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { fundingLockClient } from '../src/external/tango/funding-catalog.db.js';
import { FundingCatalogClient, CatalogQuotaPause, GRANT_SHAPE, OPPORTUNITY_SHAPE } from '../src/external/tango/funding-catalog.client.js';
import { FundingCatalogStore } from '../src/external/tango/funding-catalog.store.js';
import { reconcileCatalog } from '../src/external/tango/funding-catalog.reconcile.js';
import { importGrantExtract } from '../src/external/tango/funding-grant-extract.js';
import { fillGrantDocumentGaps } from '../src/external/tango/funding-grant-documents.js';
import { computeFilterFingerprint } from '../src/external/tango/tango-store.service.js';
import { runWithSyncRun, emptyCounts } from '../src/ingestion/sync-run.helper.js';
import { object, type RecordData } from '../src/external/tango/funding-catalog.mapper.js';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';

export type Lane = 'grants' | 'active-notices' | 'recent-notices' | 'recent-documents' | 'documents' | 'reconcile-notices' | 'reconcile-grants' | 'grant-documents';
// Refresh current catalogs and their documents before the reconciliation
// lanes, which can resume historical local records under the same quota.
const LANES: Lane[] = ['grants', 'recent-notices', 'recent-documents', 'active-notices', 'documents', 'grant-documents', 'reconcile-notices', 'reconcile-grants'];
export interface WalkDeps {
  read(): Promise<{ cursor: string | null; windowStart: Date | null; windowEnd: Date | null } | null>;
  page(page: number, start: Date, end: Date): Promise<RecordData>;
  write(row: RecordData): Promise<void>;
  checkpoint(page: number | null, start: Date, end: Date, rows: number): Promise<void>;
}
/** Resume the old 20-row document cursor with 100-row pages. Round backward
 * so at most 80 already-stored rows replay and no unprocessed row is skipped. */
export function resumeLargerDocumentPages(checkpoint: Awaited<ReturnType<WalkDeps['read']>>) {
  if (!checkpoint?.cursor) return checkpoint;
  const page = Number(checkpoint.cursor);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid legacy document cursor');
  return { ...checkpoint, cursor: String(Math.floor((page - 1) / 5) + 1) };
}
export async function walk(deps: WalkDeps, options: { commit: boolean; maxPages: number; incremental: boolean; now?: Date; initialLookbackDays?: number }) {
  const checkpoint = await deps.read(), now = options.now ?? new Date();
  const resuming = checkpoint?.cursor != null;
  const start = resuming && checkpoint?.windowStart ? checkpoint.windowStart
    : new Date((checkpoint?.windowEnd ?? now).getTime() - (checkpoint ? 3 : options.initialLookbackDays ?? 14) * 86400_000);
  const end = resuming && checkpoint?.windowEnd ? checkpoint.windowEnd : now;
  let page = resuming ? Number(checkpoint!.cursor) : 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid durable catalog cursor');
  let processed = 0;
  for (let n = 0; n < options.maxPages; n++) {
    let response: RecordData;
    try { response = await deps.page(page, start, end); }
    catch (error) { if (error instanceof CatalogQuotaPause) return { processed, complete: false }; throw error; }
    if (!Array.isArray(response.results) || typeof response.count !== 'number' || !('next' in response)) throw new Error('Invalid Tango page envelope');
    if (response.next && response.results.length === 0) throw new Error('Empty page with continuation');
    // A failed row leaves the cursor on THIS page. Successful writes replay idempotently.
    for (let i = 0; i < response.results.length; i += 5) {
      const writes = await Promise.allSettled(response.results.slice(i, i + 5).map((row: unknown) => deps.write(object(row))));
      // Keep the catalog lock until every in-flight row finishes, even if one
      // fails. Otherwise the next worker could overlap a surviving write.
      const failed = writes.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    processed += response.results.length;
    const next = response.next ? page + 1 : null;
    if (response.next) {
      const url = new URL(response.next, 'https://tango.dev');
      if (Number(url.searchParams.get('page')) !== next) throw new Error('Unexpected provider page progression');
    }
    if (options.commit) await deps.checkpoint(next, start, end, response.results.length);
    console.log(JSON.stringify({ event: 'FUNDING_PAGE', page, rows: response.results.length, complete: next === null }));
    if (next === null) return { processed, complete: true };
    page = next;
  }
  return { processed, complete: false };
}
function numberArg(argv: string[], name: string, fallback: number, max: number): number {
  const raw = argv.find(x => x.startsWith(`--${name}=`))?.split('=')[1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid --${name}`);
  return value;
}
export const FUNDING_USAGE = 'Usage: sync-tango-funding [--commit] [--lane=all|grants|active-notices|recent-notices|recent-documents|documents|reconcile-notices|reconcile-grants|grant-documents] [--max-requests=N] [--max-pages=N] [--reserve-requests=N] [--grant-extract=s3://BUCKET/KEY] [--extract-limit=N] [--original-grant-limit=N]. Requires DATABASE_URL and TANGO_API_KEY; commits require FUNDING_ALLOWED_DB_HOST. Exit 0: bounded pass; 1: failure.';
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(FUNDING_USAGE); return; }
  if (argv.some(arg => !/^--(?:commit|(?:lane|max-requests|max-pages|reserve-requests|grant-extract|extract-limit|original-grant-limit)=.+)$/.test(arg))) throw new Error(FUNDING_USAGE);
  const commit = argv.includes('--commit');
  const selected = argv.find(x => x.startsWith('--lane='))?.slice(7) ?? 'all';
  if (selected !== 'all' && !LANES.includes(selected as Lane)) throw new Error('Invalid funding lane');
  const maxRequests = numberArg(argv, 'max-requests', commit ? 1100 : 4, 1300);
  const maxPages = numberArg(argv, 'max-pages', commit ? 700 : 1, 1000);
  const reserve = numberArg(argv, 'reserve-requests', 150, 1500);
  numberArg(argv, 'extract-limit', 100000, 100000);
  numberArg(argv, 'original-grant-limit', 1000, 5000);
  if (!process.env.TANGO_API_KEY) throw new Error('TANGO_API_KEY is required');
  const lock = fundingLockClient(commit);
  const prisma = new PrismaClient(), store = new FundingCatalogStore(prisma);
  // Dedicated session guarantees lock lifetime. A disconnect releases the lock;
  // overlapping schedules cannot both pass a check-then-create SyncRun guard.
  try {
    await lock.connect();
    const result = await lock.query("SELECT pg_try_advisory_lock(hashtext('capiro:tango-funding')) AS locked");
    if (!result.rows[0].locked) { console.log('FUNDING_SYNC_ALREADY_RUNNING'); return; }
    const grantExtract = argv.find(x => x.startsWith('--grant-extract='))?.slice(16);
    if (grantExtract) {
      const run = async () => {
        const result = await importGrantExtract(store, grantExtract, commit, numberArg(argv, 'extract-limit', commit ? 100000 : 1000, 100000));
        return { ...emptyCounts(), updated: result.enriched, skipped: result.unmatched + result.unchanged, complete: result.complete,
          incompleteReason: result.complete ? undefined : 'Extract cap reached; replay skips unchanged records' };
      };
      if (commit) await runWithSyncRun(prisma, 'sync-tango-funding:grant-extract', run, { metricFormat: 'json' }); else await run();
      return;
    }
    const client = new FundingCatalogClient(store.observations, { maxRequests, reserve, commit, apiKey: process.env.TANGO_API_KEY });
    for (const lane of selected === 'all' ? LANES : [selected as Lane]) {
      if (lane === 'grant-documents') {
        const run = async () => {
          const summary = await fillGrantDocumentGaps(store, { commit, limit: numberArg(argv, 'original-grant-limit', commit ? 1000 : 1, 5000) });
          console.log(JSON.stringify({ event: 'GRANT_DOCUMENT_GAPS', ...summary }));
          return { ...emptyCounts(), updated: summary.processed, skipped: summary.unavailable, complete: summary.complete,
            incompleteReason: summary.complete ? undefined : 'Original grant document checkpoint retained' };
        };
        if (commit) await runWithSyncRun(prisma, 'sync-tango-funding:grant-documents', run, { metricFormat: 'json' }); else await run();
        continue;
      }
      if (lane === 'reconcile-notices' || lane === 'reconcile-grants') {
        const run = async () => {
          const summary = await reconcileCatalog(store, client, lane === 'reconcile-grants' ? 'grant' : 'notice',
            { commit, maxBatches: maxPages, maxRequests: lane === 'reconcile-grants' ? Math.min(maxRequests, 30) : maxRequests });
          console.log(JSON.stringify({ event: 'FUNDING_RECONCILIATION', lane, ...summary }));
          return { ...emptyCounts(), updated: summary.processed, skipped: summary.unavailable, complete: summary.complete,
            incompleteReason: summary.complete ? undefined : 'Reconciliation checkpoint retained; bounded work remains' };
        };
        if (commit) await runWithSyncRun(prisma, `sync-tango-funding:${lane}`, run, { metricFormat: 'json' });
        else await run();
        continue;
      }
      const documents = lane === 'documents' || lane === 'recent-documents';
      const resource = lane === 'grants' ? 'grants' : documents ? 'opportunities' : 'notices';
      const resourceType = lane === 'grants' ? 'grant' : documents ? 'opportunity' : 'notice';
      const batchSize = 100;
      const fingerprint = computeFilterFingerprint({ version: 1, lane, batchSize });
      const source = `sync-tango-funding:${lane}`;
      const run = async () => {
        const summary = await walk({
          // Refresh newest documents on every run. The separate durable
          // documents lane owns older-page coverage, so a capped refresh must
          // not postpone tomorrow's new documents behind today's older pages.
          read: async () => {
            if (lane === 'recent-documents') return null;
            const saved = await store.observations.readCheckpoint(source, resourceType, fingerprint);
            if (saved || lane !== 'documents') return saved;
            return resumeLargerDocumentPages(await store.observations.readCheckpoint(source, resourceType,
              computeFilterFingerprint({ version: 1, lane, batchSize: 20 })));
          },
          page: (page, start, end) => client.get(resource, {
            page, limit: batchSize,
            ...(lane === 'grants' ? { shape: GRANT_SHAPE } : {}),
            ...(lane === 'active-notices' ? { active: true } : {}),
            ...(lane === 'recent-notices' ? { posted_date_after: start.toISOString().slice(0,10), posted_date_before: end.toISOString().slice(0,10) } : {}),
            ...(documents ? { active: true, ordering: '-last_notice_date', shape: OPPORTUNITY_SHAPE } : {}),
            ...(lane === 'recent-documents' ? { last_notice_date_after: start.toISOString().slice(0,10), last_notice_date_before: end.toISOString().slice(0,10) } : {}),
          }),
          write: row => lane === 'grants' ? store.grant(row, commit) : documents ? store.opportunity(row, commit) : store.notice(row, commit).then(() => undefined),
          checkpoint: (page, start, end, rows) => store.observations.writeCheckpoint({ syncVerb: source, resourceType,
            filterFingerprint: fingerprint, cursor: page === null ? null : String(page), windowStart: start.toISOString(),
            windowEnd: end.toISOString(), rowsProcessed: rows, completeness: page === null ? 'complete' : 'in_progress' }).then(() => undefined),
        }, { commit, maxPages: Math.min(maxPages, lane === 'recent-documents' ? 100 : lane === 'documents' ? 120 : lane === 'recent-notices' ? 150 : 700), incremental: lane === 'recent-notices' || lane === 'recent-documents', initialLookbackDays: lane === 'recent-documents' ? 3 : 14 });
        console.log(JSON.stringify({ event: 'FUNDING_LANE', lane, commit, ...summary }));
        return { ...emptyCounts(), updated: summary.processed, complete: summary.complete, incompleteReason: summary.complete ? undefined
          : lane === 'recent-documents' ? 'Recent refresh capped; rolling document lane retains older-page coverage' : 'Budget reached; saved page resumes next run' };
      };
      if (commit) await runWithSyncRun(prisma, source, run, { metricFormat: 'json' });
      else await run();
    }
  } finally { await lock.end(); await prisma.$disconnect(); }
}
if (/sync-tango-funding\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  void main().catch(error => { console.error('FUNDING_SYNC_FAILED', redactWithKnownSecret(redact(error instanceof Error ? error.message : 'Unknown failure'), process.env.TANGO_API_KEY ?? '').slice(0, 500)); process.exitCode = 1; });
}
