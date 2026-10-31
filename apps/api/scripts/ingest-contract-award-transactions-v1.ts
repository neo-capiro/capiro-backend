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
 * The award family key is NOT re-derived: it is read from the award revision the projector already wrote,
 * matched on the award's piid, so a transaction attaches to the family that exists rather than to a key this
 * script invents.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
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
function intArg(name: string, fallback: number, max: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`--${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

export interface ContractAwardTransaction {
  sourceTransactionId: string;
  piid: string | null;
  modificationNumber: string | null;
  actionDate: Date | null;
  signedObligationDelta: number | null;
  awardIdentityKey: string | null;
}

interface SamRecord {
  contractId?: { piid?: string; modificationNumber?: string };
  awardDetails?: {
    dollars?: { actionObligation?: number | string | null };
    dates?: { dateSigned?: string | null };
  };
  [key: string]: unknown;
}

/** Map one SAM contract-awards record to a ledger transaction, or null when it cannot be one. */
export function mapContractAwardRecord(
  record: SamRecord,
  awardIdentityByPiid: ReadonlyMap<string, string>,
): ContractAwardTransaction | null {
  // The API returns modificationNumber as a NUMBER on some records, so coerce before trimming:
  // a bare `.trim()` here aborted a whole run with "value.trim is not a function".
  const asText = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  };
  const piid = asText(record.contractId?.piid);
  if (!piid) return null;
  const modificationNumber = asText(record.contractId?.modificationNumber);
  const rawDelta = record.awardDetails?.dollars?.actionObligation;
  const delta = rawDelta === null || rawDelta === undefined || rawDelta === '' ? null : Number(rawDelta);
  if (delta !== null && !Number.isFinite(delta)) return null;
  const signed = asText(record.awardDetails?.dates?.dateSigned);
  const actionDate = signed ? new Date(signed.replace(' ', 'T') + (signed.includes('Z') ? '' : 'Z')) : null;
  return {
    sourceTransactionId: modificationNumber ? `${piid}-${modificationNumber}` : piid,
    piid,
    modificationNumber,
    actionDate: actionDate && !Number.isNaN(actionDate.getTime()) ? actionDate : null,
    signedObligationDelta: delta,
    awardIdentityKey: awardIdentityByPiid.get(piid) ?? null,
  };
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
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (response.ok) {
      const body = (await response.json()) as { awardSummary?: SamRecord[]; totalRecords?: number };
      return { records: body.awardSummary ?? [], totalRecords: body.totalRecords ?? null };
    }
    lastError = `SAM contract-awards HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
    if (!TRANSIENT_STATUS.has(response.status)) break;
  }
  throw new Error(lastError);
}

async function main(): Promise<void> {
  const apiKey = process.env.SAM_GOV_API_KEY?.trim();
  if (!apiKey) throw new Error('SAM_GOV_API_KEY is required');

  const commit = flag('commit');
  const enabled = commit && process.env.PROGRAM_ACQUISITION_CONTINUITY_ENABLED === 'true';
  const pages = intArg('pages', 1, 200);
  const offsetStart = intArg('offset', 0, 400000);
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
    noAwardFamily: 0,
    noDelta: 0,
    transactionsInserted: 0,
    transactionsExisting: 0,
    piidsTargeted: 0,
    piidsTruncatedAtPageLimit: 0,
    piidsSkippedCovered: 0,
    piidsRecheckedAmbiguous: 0,
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
  // INDEX, not a record offset — verified live: for an award with totalRecords=212, offset=0 returns
  // 100, offset=1 returns 100 different ones, offset=2 returns the remaining 12, offset=3 returns 0.
  // Stepping by PAGE_LIMIT (0, 100, 200...) therefore jumped to page 100 and silently skipped pages
  // 1-99. Large awards exceed a single page, so a full page re-queues the SAME piid at the NEXT PAGE
  // INDEX rather than presenting a truncated history as complete. The cap exists only so a pathological
  // award cannot loop forever; hitting it is reported, never hidden.
  const MAX_PAGE_INDEX_PER_PIID = 40;
  // Resumption across days: the ledger itself is the progress record, so a piid that already has
  // transactions is not re-fetched. Reported, not silent. (An award whose fetch aborted mid-way would
  // be skipped on the next run, which is why aborts are retried above and verified afterwards.)
  const skipCovered = flag('skip-covered');
  let coveredPiids = new Set<string>();
  const resumeOffsets = new Map<string, number>();
  if (skipCovered && piidTargets && piidTargets.length > 0) {
    // A piid is skipped only when it is PROVABLY complete: its last fetched page returned fewer than
    // PAGE_LIMIT records, so its count is not a multiple of PAGE_LIMIT. A count that IS an exact
    // multiple cannot distinguish "complete" from "aborted after a full page", and the first run left
    // 104 of 506 covered piids in exactly that ambiguous state -- e.g. N0001917C0001 held 200 of the
    // 212 actions the source reports. Those are re-checked rather than assumed complete.
    const rows = await prisma.$queryRaw<{ piid: string; n: number }[]>`
      SELECT piid, count(*)::int AS n
      FROM acquisition_award_transaction_revision
      WHERE piid = ANY(${piidTargets})
      GROUP BY piid
    `;
    for (const row of rows) {
      if (row.n % PAGE_LIMIT !== 0) {
        coveredPiids.add(row.piid);
      } else {
        // Ambiguous: resume where the stored pages stop rather than re-fetching from page 0. Pages
        // were walked upward, so what we hold is a contiguous prefix and page n/PAGE_LIMIT is the
        // first page never stored -- one extra call to confirm a complete award, where re-fetching a
        // 3,700-row award from page 0 would cost 38.
        resumeOffsets.set(row.piid, row.n / PAGE_LIMIT);
      }
    }
    summary.piidsSkippedCovered = coveredPiids.size;
    summary.piidsRecheckedAmbiguous = resumeOffsets.size;
  }
  const remainingTargets = piidTargets ? piidTargets.filter((piid) => !coveredPiids.has(piid)) : null;
  const workQueue: Array<{ piid: string; offset: number }> | null = remainingTargets
    ? remainingTargets.map((piid) => ({ piid, offset: resumeOffsets.get(piid) ?? 0 }))
    : null;

  try {
    for (let page = 0; page < (workQueue ? workQueue.length : pages); page += 1) {
      const params: Record<string, string> = workQueue
        ? { offset: String(workQueue[page].offset), piid: workQueue[page].piid }
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
        const nextOffset = workQueue[page].offset + 1;
        if (nextOffset <= MAX_PAGE_INDEX_PER_PIID) {
          // Insert immediately after the current entry, not at the end: this makes pagination
          // depth-first, so a run that dies mid-award leaves at most ONE award partially fetched
          // instead of leaving every award one page short.
          workQueue.splice(page + 1, 0, { piid: workQueue[page].piid, offset: nextOffset });
        } else {
          summary.piidsTruncatedAtPageLimit += 1;
        }
      }
      summary.recordsExamined += records.length;

      // Resolve award family keys through the award table, not through the revision's raw payload:
      // only a minority of revisions carry a piid inside raw_jsonb, whereas federal_award.piid is
      // populated and its award_unique_id is exactly the revision's source_record_id.
      const piids = [...new Set(records.map((r) => r.contractId?.piid?.trim()).filter((p): p is string => !!p))];
      const awardIdentityByPiid = new Map<string, string>();
      if (piids.length > 0) {
        const rows = await prisma.$queryRaw<{ piid: string; identity_key: string }[]>`
          SELECT a.piid AS piid, r.identity_key AS identity_key
          FROM federal_award a
          JOIN acquisition_record_revision r
            ON r.source_record_id = a.award_unique_id
           AND r.record_kind = 'award'
           AND r.source_system = 'usaspending'
          WHERE a.piid = ANY(${piids})
        `;
        for (const row of rows) if (row.piid && !awardIdentityByPiid.has(row.piid)) {
          awardIdentityByPiid.set(row.piid, row.identity_key);
        }
      }

      for (const record of records) {
        const mapped = mapContractAwardRecord(record, awardIdentityByPiid);
        if (!mapped) continue;
        if (!mapped.awardIdentityKey) { summary.noAwardFamily += 1; continue; }
        if (mapped.signedObligationDelta === null) { summary.noDelta += 1; continue; }
        summary.mapped += 1;
        if (!enabled) continue;
        // The store's interface is string-typed on purpose: dates are ISO strings (its `date()` helper
        // trims) and the delta is a DECIMAL(20,2), so it is passed as a fixed-2 string rather than a JS
        // number that could lose precision on a large obligation.
        const result = await store.appendTransaction({
          source: 'sam_gov',
          sourceTransactionId: mapped.sourceTransactionId,
          awardIdentityKey: mapped.awardIdentityKey,
          piid: mapped.piid,
          modificationNumber: mapped.modificationNumber,
          actionDate: mapped.actionDate ? mapped.actionDate.toISOString() : null,
          signedObligationDelta:
            mapped.signedObligationDelta === null ? null : mapped.signedObligationDelta.toFixed(2),
          sourceUrl: `${SEARCH_URL}?piid=${encodeURIComponent(mapped.piid ?? '')}`,
          sourceObservedAt: new Date().toISOString(),
          raw: record as Record<string, unknown>,
        });
        if (result.inserted) summary.transactionsInserted += 1;
        else summary.transactionsExisting += 1;
      }
      console.log(
        workQueue
          ? `call ${page + 1}/${workQueue.length} piid=${workQueue[page].piid} offset=${params.offset} examined=${summary.recordsExamined} inserted=${summary.transactionsInserted}`
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
