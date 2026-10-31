/**
 * SAM.gov Contract Awards -> acquisition ledger transactions.
 *
 * The ledger's signed action deltas (`acquisition_award_transaction_revision`) have no local source:
 * `federal_award` is award-level only, so the projector records a coverage gap instead. This script
 * supplies the missing qualified transaction source.
 *
 * Reads `GET https://api.sam.gov/contract-awards/v1/search`. Writes require BOTH `--commit` and
 * PROGRAM_ACQUISITION_CONTINUITY_ENABLED=true, matching the projector's two-key gate; otherwise it is a
 * read-only dry run that still calls the API and reports what it would write.
 *
 * Field mapping (verified against live responses):
 *   contractId.piid                                   -> piid
 *   contractId.modificationNumber                     -> modificationNumber
 *   awardDetails.dollars.actionObligation             -> signedObligationDelta  (negative = deobligation)
 *   awardDetails.dollars.baseAndAllOptionsValue       -> kept in raw only; NEVER an obligation
 *   awardDetails.dates.dateSigned                     -> actionDate
 *   coreData.awardOrIDV                               -> "AWARD" | "IDV" (kept in raw)
 *
 * Corrected adapter contract: docs/lane6/sam-action-contract-v2.md.
 * Resolve the full source award tuple; PIID only bounds candidate retrieval.
 * Historical keys, hashes and observation chains remain untouched.
 */
import { assertLosslessSamJsonSupport, parseSamResponseJson } from './lib/sam-response-json.js';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { appendSamRecords, sourceText, validProducerRun, SAM_ACTION_CONTRACT, type AwardCandidate, type ProducerRun, type SamRecord } from './lib/sam-contract-action.js';
import { AcquisitionContinuityStore } from '../src/program-element/acquisition-continuity/acquisition-continuity.store.js';

const SEARCH_URL = 'https://api.sam.gov/contract-awards/v1/search';
const PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 100;

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}
function intArg(name: string, fallback: number, max: number, min = 1): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

interface PageResult {
  records: SamRecord[];
  totalRecords: number | null;
}

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * One search call, retrying transient gateway/rate responses instead of losing a whole batch to them.
 * A 504 from api.sam.gov aborted a run after 16,090 transactions had been written. A 4xx (bad key, bad
 * parameter) is never retried: it will not fix itself and must fail loudly.
 */
async function fetchPage(apiKey: string, params: Record<string, string>): Promise<PageResult> {
  const query = new URLSearchParams({ api_key: apiKey, limit: String(PAGE_LIMIT), ...params });
  const url = `${SEARCH_URL}?${query.toString()}`;
  let lastError = 'SAM contract-awards request failed';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'capiro-dev-contract-awards/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = 'SAM contract-awards transport failure';
      continue;
    }
    if (response.status === 204) return { records: [], totalRecords: 0 };
    if (response.ok) {
      const body = parseSamResponseJson(await response.text()) as { awardSummary?: SamRecord[]; totalRecords?: number };
      if (!Array.isArray(body.awardSummary) || body.awardSummary.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
        throw new Error('SAM contract-awards response violates the record contract');
      }
      return { records: body.awardSummary, totalRecords: body.totalRecords ?? null };
    }
    lastError = `SAM contract-awards HTTP ${response.status}`;
    if (!TRANSIENT_STATUS.has(response.status)) break;
  }
  throw new Error(lastError);
}

async function main(): Promise<void> {
  assertLosslessSamJsonSupport(); // Capability gate before source calls, credentials or database connections.
  const apiKey = process.env.SAM_GOV_API_KEY?.trim();
  if (!apiKey) throw new Error('SAM_GOV_API_KEY is required');

  if (flag('skip-covered')) throw new Error('--skip-covered is unsafe: observation counts are not source pagination checkpoints');
  const run: ProducerRun = { contract: SAM_ACTION_CONTRACT, producerCommit: arg('producer-commit') ?? '',
    imageDigest: arg('image-digest') ?? '', runId: arg('run-id') ?? '', targetId: arg('target-id') ?? '' };
  if (!validProducerRun(run)) throw new Error('explicit --producer-commit, --image-digest, --run-id and --target-id are required');
  const commit = flag('commit');
  const enabled = commit && process.env.PROGRAM_ACQUISITION_CONTINUITY_ENABLED === 'true';
  const pages = intArg('pages', 1, 200);
  const offsetStart = intArg('offset', 0, 400000, 0);
  const from = arg('from');
  const to = arg('to');
  const department = arg('department') ?? '9700';
  const dateField = arg('date-field') ?? 'dateSigned';
  const piidsFile = arg('piids-file');
  if (!piidsFile && (!from || !to)) throw new Error('--from and --to are required unless --piids-file is given');

  const prisma = new PrismaClient();
  const store = new AcquisitionContinuityStore(prisma as never);
  const summary = {
    mode: enabled ? 'COMMIT' : 'DRY_RUN',
    window: `${from}..${to}`,
    department,
    pagesRequested: pages,
    pagesFetched: 0,
    totalRecordsReported: null as number | null,
    recordsExamined: 0,
    mapped: 0,
    transactionsInserted: 0,
    transactionsExisting: 0,
    piidsTargeted: 0,
    piidsTruncatedAtPageLimit: 0,
    sourceCoverage: 'bounded_observation_only',
    provenance: run,
    rejected: {} as Record<string, number>,
    aborted: false,
    stoppedReason: null as string | null,
  };

  // PIID-targeted mode: the API accepts only ONE piid per call (a ~ or , list returns zero records),
  // so this is one call per award. Used to cover the awards that actually appear in the program graph
  // rather than paging a national corpus where ~0.5% of rows are relevant.
  const piidTargets = piidsFile
    ? readFileSync(piidsFile, 'utf8')
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, intArg('max-piids', 100000, 200000))
    : null;
  if (piidTargets) summary.piidsTargeted = piidTargets.length;

  // One API call returns at most PAGE_LIMIT actions for a piid, and the API's `offset` is a PAGE
  // INDEX, not a record offset - verified live: for an award with totalRecords=212, offset=0 returns
  // 100, offset=1 returns 100 different ones, offset=2 returns the remaining 12, offset=3 returns 0.
  // Stepping by PAGE_LIMIT (0, 100, 200...) therefore jumped to page 100 and silently skipped pages
  // 1-99. Large awards exceed a single page, so a full page re-queues the SAME piid at the NEXT PAGE
  // INDEX rather than presenting a truncated history as complete. The cap exists only so a pathological
  // award cannot loop forever; hitting it is reported, never hidden.
  const MAX_PAGE_INDEX_PER_PIID = 40;
  // Re-fetch from source page zero; physical observation count cannot prove source coverage.
  // A failed run is not an approved population. Retry with a new run ID and qualify its receipt.
  const workQueue: Array<{ piid: string; offset: number }> | null = piidTargets
    ? [...new Set(piidTargets)].map((piid) => ({ piid, offset: 0 })) : null;

  try {
    for (let page = 0; page < (workQueue ? workQueue.length : pages); page += 1) {
      const params: Record<string, string> = workQueue
        ? { offset: String(workQueue[page]!.offset), piid: workQueue[page]!.piid }
        : {
            // offset is a page index in every mode (see the note above), so it advances by ONE per page.
            offset: String(offsetStart + page),
            [dateField]: `[${from},${to}]`,
            ...(department ? { contractingDepartmentCode: department } : {}),
          };
      const { records, totalRecords } = await fetchPage(apiKey, params);
      summary.pagesFetched += 1;
      summary.totalRecordsReported = totalRecords;
      if (records.length === 0) {
        summary.stoppedReason = piidTargets ? null : 'source returned no further records';
        continue;
      }
      if (workQueue && records.length >= PAGE_LIMIT) {
        const nextOffset = workQueue[page]!.offset + 1;
        if (nextOffset <= MAX_PAGE_INDEX_PER_PIID) {
          // Insert immediately after the current entry, not at the end: this makes pagination
          // depth-first, so a run that dies mid-award leaves at most ONE award partially fetched
          // instead of leaving every award one page short.
          workQueue.splice(page + 1, 0, { piid: workQueue[page]!.piid, offset: nextOffset });
        } else {
          summary.piidsTruncatedAtPageLimit += 1;
        }
      }
      summary.recordsExamined += records.length;

      const piids = [...new Set(records.map((r) => sourceText(r.contractId?.piid)).filter((p): p is string => !!p))];
      const candidates = piids.length ? await prisma.$queryRaw<AwardCandidate[]>`
        SELECT DISTINCT a.piid AS piid, a.award_unique_id AS "awardUniqueId", r.identity_key AS "identityKey"
        FROM federal_award a
        JOIN acquisition_record_revision r
          ON r.source_record_id = a.award_unique_id AND r.record_kind = 'award' AND r.source_system = 'usaspending'
        WHERE a.piid = ANY(${piids})
      ` : [];
      await appendSamRecords(records, candidates, run, summary, enabled ? (input) => store.appendTransaction(input) : undefined);
      console.log(
        workQueue
          ? `call ${page + 1}/${workQueue.length} piid=${workQueue[page]!.piid} offset=${params.offset} examined=${summary.recordsExamined} inserted=${summary.transactionsInserted}`
          : `page ${page + 1}/${pages} offset=${params.offset} examined=${summary.recordsExamined} inserted=${summary.transactionsInserted}`,
      );
    }
  } catch (error) {
    // Never lose the evidence: report what was written before the abort, then exit non-zero.
    summary.aborted = true;
    summary.stoppedReason = error instanceof Error ? error.message : String(error);
  } finally {
    await prisma.$disconnect();
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.aborted) process.exitCode = 1;
}

const direct = typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
if (direct) {
  void main().catch((error) => {
    console.error('[ingest-contract-award-transactions] FAILED', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
export { MAX_PAGE_LIMIT };
