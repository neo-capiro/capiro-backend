/**
 * Sync Congress.gov legislative data (bills from 118th and 119th Congress).
 *
 *   pnpm --filter @capiro/api sync:congress
 *
 * Source: https://api.congress.gov/v3/, Congress.gov API.
 * Fetches bills and complete action histories; richer subject, committee, and
 * cosponsor data remains scoped to lobbying-relevant/tracked/rule bills.
 *
 * Steps:
 *   1. Paginate through the configured Congress bill lists (117th-119th by default)
 *   2. For each bill, fetch detail (policyArea, sponsor, etc.)
 *   3. Fetch every bill's paginated actions
 *   4. Fetch subjects and committees for relevant bills
 *   5. Upsert canonical bill and normalized sub-resource rows
 *
 * Rate limit: ~5000 req/hour with API key. Retry-After handling self-paces
 * full backfills; scheduled incremental windows are substantially smaller.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { buildBillText, embedAndUpsert } from '../src/embeddings/embedder.js';
import {
  isRuleResolutionTitle,
  parseRuleTargets,
  parseRuleFromBillAction,
} from '../src/ingestion/rule-link.util.js';
import {
  syncCongressBillActions,
  type CongressActionsResponse,
  type NormalizedCongressAction,
} from './lib/congress-actions.js';
import {
  authoritativeCongressClassifications,
  fetchCongressCommittees,
  fetchCongressSubjects,
  replaceCongressBillClassificationsAtomically,
  type CongressClassificationFetchResult,
  type CongressCommitteesResponse,
  type CongressSubjectsResponse,
  type NormalizedCongressCommittee,
} from './lib/congress-classifications.js';
import { fetchCongressJson as fetchJson } from './lib/congress-http.js';

dotenvConfig();

// Toggle for the per-row embed call. Defaults to enabled in prod (the API
// container has bedrock:InvokeModel via the task role) but you can flip it
// off via env when smoke-testing the sync logic without burning Bedrock.
const EMBED_ON_SYNC = process.env.EMBED_ON_SYNC !== '0';

// Toggle for the per-bill cosponsors fetch (Bucket-#3 C6.P6.1). Defaults on;
// set CONGRESS_COSPONSORS=0 for FULL multi-congress backfills where the extra
// request per lobbying-relevant bill (~+20% volume) matters on the shared key.
const COSPONSORS_ON_SYNC = process.env.CONGRESS_COSPONSORS !== '0';

const CONGRESS_BASE = 'https://api.congress.gov/v3';
const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY ?? '';
const LIMIT = 100;

// Congress.gov's fromDateTime/toDateTime params require the strict format
// %Y-%m-%dT%H:%M:%SZ (NO milliseconds). Date.toISOString() emits ".000Z",
// which the API rejects with a 400 UserInputException. Strip the millis.
function toCongressDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
// Page through the FULL congress: the loop runs until the API reports no
// `next` page. MAX_PAGES_PER_CONGRESS is only a runaway-loop safety bound
// (50,000 bills) and is logged loudly if ever hit. The old hard cap of 50
// (5,000 bills) SILENTLY truncated coverage — Congress.gov sorts the bill list
// by most-recently-updated, so each congress kept only its 5,000 freshest bills
// and the dormant long tail (e.g. 119 s.1932) was never ingested. Override the
// bound with CONGRESS_MAX_PAGES for an exhaustive backfill of a very large congress.
const MAX_PAGES_PER_CONGRESS = Number(process.env.CONGRESS_MAX_PAGES) || 500;
// Default to the three congresses we track. Override with CONGRESS_TARGETS
// (comma-separated, e.g. "119") to scope a one-off full backfill to a single
// congress instead of re-walking all of them.
const TARGET_CONGRESSES = process.env.CONGRESS_TARGETS
  ? process.env.CONGRESS_TARGETS.split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n))
  : [117, 118, 119];

// Incremental mode: pass `--incremental` (or set CONGRESS_SYNC_INCREMENTAL=1)
// to limit the upstream fetch to bills updated since the most recent
// congress_bill.update_date in the DB. Congress.gov's /bill endpoint accepts
// `fromDateTime` (ISO Z format). The hard MAX_PAGES_PER_CONGRESS cap stays
// in place as a safety bound.
const INCREMENTAL =
  process.argv.includes('--incremental') || process.env.CONGRESS_SYNC_INCREMENTAL === '1';
// Lookback when there's no DB row yet, or when --since is explicit.
const SINCE_OVERRIDE = (() => {
  const i = process.argv.indexOf('--since');
  return i >= 0 ? process.argv[i + 1] : process.env.CONGRESS_SYNC_SINCE;
})();

// Policy areas relevant to lobbying. Used to filter bills for subject/committee detail fetching.
const LOBBYING_POLICY_AREAS = new Set([
  'Health',
  'Taxation',
  'Armed Forces and National Security',
  'Energy',
  'Finance and Financial Sector',
  'Environmental Protection',
  'Transportation and Public Works',
  'Science, Technology, Communications',
  'International Affairs',
  'Government Operations and Politics',
  'Labor and Employment',
  'Agriculture and Food',
  'Housing and Community Development',
  'Commerce',
  'Economics and Public Finance',
  'Education',
  'Immigration',
  'Law',
  'Social Welfare',
  'Public Lands and Natural Resources',
]);

// ─── Congress.gov API types ───────────────────────────────────────────────────

interface CongressBillSummary {
  congress: number;
  latestAction?: { actionDate: string | null; text: string | null } | null;
  number: string;
  originChamber?: string | null;
  originChamberCode?: string | null;
  title: string;
  type: string;
  updateDate?: string | null;
  updateDateIncludingText?: string | null;
  url?: string | null;
  introducedDate?: string | null;
  sponsor?: {
    bioguideId?: string | null;
    district?: number | null;
    firstName?: string | null;
    fullName?: string | null;
    isByRequest?: string | null;
    lastName?: string | null;
    middleName?: string | null;
    party?: string | null;
    state?: string | null;
  } | null;
  // Congress.gov returns the PRIMARY sponsor inside a `sponsors` ARRAY ([0] is
  // primary); the old code read a singular `sponsor` the API never sends, so
  // sponsor_name was always null. Read the array (singular kept as a fallback).
  sponsors?: Array<{
    bioguideId?: string | null;
    fullName?: string | null;
    party?: string | null;
    state?: string | null;
  }> | null;
  policyArea?: { name: string } | null;
  cosponsors?: { count?: number } | null;
}

interface CongressBillDetail {
  bill: {
    congress: number;
    number: string;
    type: string;
    title: string;
    introducedDate?: string | null;
    sponsor?: CongressBillSummary['sponsor'];
    sponsors?: CongressBillSummary['sponsors'];
    latestAction?: CongressBillSummary['latestAction'];
    policyArea?: { name: string } | null;
    subjects?: {
      legislativeSubjects?: { name: string }[];
      policyArea?: { name: string } | null;
    } | null;
    committees?: {
      count?: number;
      url?: string;
    } | null;
    cosponsors?: { count?: number } | null;
    cboCostEstimates?: Array<{
      pubDate?: string | null;
      title?: string | null;
      url?: string | null;
      description?: string | null;
    }> | null;
    originChamber?: string | null;
    updateDate?: string | null;
    updateDateIncludingText?: string | null;
    url?: string | null;
  };
}

// /bill/{c}/{t}/{n}/cosponsors (Bucket-#3 C6.P6.1 / C1.V4). Live-verified
// shape 2026-07-06: district is a number, isOriginalCosponsor a boolean,
// sponsorshipWithdrawnDate present only when withdrawn. pagination.count
// EXCLUDES withdrawn cosponsors; countIncludingWithdrawnCosponsors has all.
interface CongressCosponsorsResponse {
  cosponsors?: {
    bioguideId?: string | null;
    fullName?: string | null;
    party?: string | null;
    state?: string | null;
    district?: number | null;
    sponsorshipDate?: string | null;
    isOriginalCosponsor?: boolean | null;
    sponsorshipWithdrawnDate?: string | null;
  }[];
  pagination?: {
    count?: number;
    countIncludingWithdrawnCosponsors?: number;
    next?: string | null;
  };
}

interface CongressBillListResponse {
  bills: CongressBillSummary[];
  pagination: {
    count: number;
    next?: string | null;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function congressUrl(path: string, params: Record<string, string | number> = {}): string {
  const url = new URL(`${CONGRESS_BASE}${path}`);
  url.searchParams.set('api_key', CONGRESS_API_KEY);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

function congressContinuationUrl(nextPageUrl: string, initialUrl: string): string {
  const url = new URL(nextPageUrl, initialUrl);
  const base = new URL(CONGRESS_BASE);
  if (
    url.origin !== base.origin ||
    (url.pathname !== base.pathname && !url.pathname.startsWith(`${base.pathname}/`))
  ) {
    throw new Error('Congress API returned an unexpected pagination URL');
  }
  url.searchParams.set('api_key', CONGRESS_API_KEY);
  url.searchParams.set('format', 'json');
  return url.toString();
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function billId(congress: number, type: string, number: string): string {
  return `${congress}-${type.toLowerCase()}-${number}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[congress-sync] starting');

  try {
    if (!CONGRESS_API_KEY) {
      throw new Error('CONGRESS_API_KEY env var is required');
    }

    await runWithSyncRun(
      prisma as any,
      'sync-congress',
      async (ctx) => {
        let totalBills = 0;
        let actionErrors = 0;
        let syncErrors = 0;
        let complete = true;
        const incompleteReasons = new Set<string>();

        // LegiWatch A3: fetch rich classification sub-resources for TRACKED
        // bills regardless of policy area. Actions are now fetched for every
        // bill below and no longer depend on this set.
        // intel_tracked_bill is RLS-protected and not in apps/api's Prisma
        // schema, so read it cross-tenant via withSystem raw (bypass GUC);
        // UNION the legacy tracked_bill. Best-effort — on any failure we simply
        // fall back to the lobbying gate.
        const trackedBillIds = new Set<string>();
        try {
          // Raw PrismaClient (not the Nest wrapper) → replicate withSystem: set
          // the tx-local bypass GUC the intel_* RLS policies honor, then read.
          const rows = await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
            const a = await tx.$queryRawUnsafe<{ bill_id: string }[]>(
              'select distinct bill_id from intel_tracked_bill',
            );
            let b: { bill_id: string }[] = [];
            try {
              b = await tx.$queryRawUnsafe<{ bill_id: string }[]>(
                'select distinct bill_id from tracked_bill',
              );
            } catch {
              /* legacy table may be absent in some envs */
            }
            return [...a, ...b];
          });
          for (const r of rows) if (r.bill_id) trackedBillIds.add(r.bill_id);
          console.log(`[sync-congress] tracked-bill set: ${trackedBillIds.size} ids`);
        } catch (err) {
          console.warn(
            '[sync-congress] tracked-bill preload failed (using lobbying gate only):',
            err,
          );
        }

        for (const congress of TARGET_CONGRESSES) {
          // Resolve fromDateTime for this congress. Incremental runs normally
          // use the last fully successful SyncRun; pre-SyncRun installations
          // bootstrap from their newest stored bill update date.
          let fromDateTime: string | undefined;
          if (SINCE_OVERRIDE) {
            fromDateTime = toCongressDateTime(new Date(SINCE_OVERRIDE));
          } else if (INCREMENTAL) {
            // Use the last fully successful run as the durable watermark. A
            // sub-resource failure records success_with_errors, so keeping the
            // prior successful floor makes the next run retry every affected
            // bill even though its parent congress_bill row was already
            // upserted. The overlap covers updates that land on the boundary
            // while the prior run is in flight.
            if (ctx.since) {
              const overlapMs = 15 * 60 * 1000;
              fromDateTime = toCongressDateTime(new Date(ctx.since.getTime() - overlapMs));
            } else {
              // Bootstrap compatibility for databases populated before
              // SyncRun tracking existed: avoid unexpectedly turning their
              // first incremental invocation into a multi-congress full sync.
              const latest = await prisma.congressBill.findFirst({
                where: { congress },
                orderBy: { updateDate: 'desc' },
                select: { updateDate: true },
              });
              if (latest?.updateDate) {
                fromDateTime = toCongressDateTime(latest.updateDate);
              }
            }
          }
          console.log(
            `[congress-sync] fetching ${congress}th Congress bills` +
              (fromDateTime ? ` since ${fromDateTime}` : ' (full window)'),
          );
          let offset = 0;
          let congressBills = 0;
          let reachedEnd = false;
          let stoppedByListFailure = false;

          for (let pageNum = 0; pageNum < MAX_PAGES_PER_CONGRESS; pageNum++) {
            let listResp: CongressBillListResponse | null;
            try {
              listResp = await fetchJson<CongressBillListResponse>(
                congressUrl(`/bill/${congress}`, {
                  limit: LIMIT,
                  offset,
                  ...(fromDateTime ? { fromDateTime } : {}),
                }),
              );
            } catch (err) {
              syncErrors += 1;
              complete = false;
              stoppedByListFailure = true;
              incompleteReasons.add(`bill list failed for ${congress}th Congress`);
              console.warn(
                `[congress-sync] failed to fetch bill list congress=${congress} offset=${offset}:`,
                err instanceof Error ? err.message : err,
              );
              break;
            }

            if (!listResp?.bills?.length) {
              reachedEnd = true;
              break;
            }

            for (const bill of listResp.bills) {
              try {
                const type = bill.type?.toLowerCase() ?? '';
                const id = billId(congress, type, bill.number);

                // Fetch bill detail (includes policyArea and sponsor).
                let detail: CongressBillDetail | null = null;
                try {
                  detail = await fetchJson<CongressBillDetail>(
                    congressUrl(`/bill/${congress}/${type}/${bill.number}`),
                  );
                } catch (err) {
                  // Proceed without detail, will use list data
                }

                const billData = detail?.bill ?? (bill as unknown as CongressBillDetail['bill']);
                const policyAreaName = billData.policyArea?.name ?? bill.policyArea?.name ?? null;
                const isLobbyingRelevant = policyAreaName
                  ? LOBBYING_POLICY_AREAS.has(policyAreaName)
                  : false;
                // LegiWatch A3: also fetch classification sub-resources for
                // TRACKED bills (any policy area) and RULE resolutions (null
                // policyArea). Action history is handled independently below.
                const isRuleHres =
                  type === 'hres' && isRuleResolutionTitle(billData.title ?? bill.title);
                const fetchSubResources =
                  isLobbyingRelevant || trackedBillIds.has(id) || isRuleHres;

                // Fetch subjects, committees, and cosponsors for relevant/tracked/rule bills.
                let subjects: string[] = [];
                let committees: NormalizedCongressCommittee[] = [];
                let subjectsResult: CongressClassificationFetchResult<string[]> | null = null;
                let committeesResult: CongressClassificationFetchResult<
                  NormalizedCongressCommittee[]
                > | null = null;
                let actionsData: NormalizedCongressAction[] = [];
                let cosponsorsData: {
                  bioguideId: string;
                  fullName: string;
                  party: string | null;
                  state: string | null;
                  district: number | null;
                  sponsorshipDate: Date | null;
                  isOriginal: boolean;
                  withdrawnDate: Date | null;
                }[] = [];
                let cosponsorsFetchFailed = false;

                if (fetchSubResources) {
                  await new Promise((r) => setTimeout(r, 200));

                  subjectsResult = await fetchCongressSubjects(() =>
                    fetchJson<CongressSubjectsResponse>(
                      congressUrl(`/bill/${congress}/${type}/${bill.number}/subjects`),
                    ),
                  );
                  if (subjectsResult.ok) {
                    subjects = subjectsResult.data;
                  } else {
                    syncErrors += 1;
                    complete = false;
                    incompleteReasons.add('one or more bill subject histories failed');
                    console.warn(
                      `[congress-sync] subjects fetch failed for ${id}; existing subject data preserved:`,
                      subjectsResult.error.message,
                    );
                  }

                  await new Promise((r) => setTimeout(r, 200));

                  committeesResult = await fetchCongressCommittees(() =>
                    fetchJson<CongressCommitteesResponse>(
                      congressUrl(`/bill/${congress}/${type}/${bill.number}/committees`),
                    ),
                  );
                  if (committeesResult.ok) {
                    committees = committeesResult.data;
                  } else {
                    syncErrors += 1;
                    complete = false;
                    incompleteReasons.add('one or more bill committee histories failed');
                    console.warn(
                      `[congress-sync] committees fetch failed for ${id}; existing committee data preserved:`,
                      committeesResult.error.message,
                    );
                  }

                  // Cosponsor rows (Bucket-#3 C6.P6.1 / C1.V4): one extra
                  // request per lobbying-relevant bill (paginated at 250),
                  // skipped entirely when the detail says there are none.
                  // COSPONSORS_ON_SYNC=0 skips the fetch — use it on FULL
                  // 117-119 backfills, where the extra ~30k requests deepen
                  // the 429-exhaustion window on the shared key.
                  const cosponsorTotal = billData.cosponsors?.count ?? bill.cosponsors?.count ?? 0;
                  if (COSPONSORS_ON_SYNC && cosponsorTotal > 0) {
                    await new Promise((r) => setTimeout(r, 200));
                    try {
                      let cosponsorOffset = 0;
                      for (;;) {
                        const cosponsorsResp = await fetchJson<CongressCosponsorsResponse>(
                          congressUrl(`/bill/${congress}/${type}/${bill.number}/cosponsors`, {
                            limit: 250,
                            offset: cosponsorOffset,
                          }),
                        );
                        const page = cosponsorsResp?.cosponsors ?? [];
                        if (!page.length) break;
                        for (const c of page) {
                          if (!c.bioguideId) continue;
                          cosponsorsData.push({
                            bioguideId: c.bioguideId.toUpperCase(),
                            fullName: c.fullName ?? '',
                            party: c.party ?? null,
                            state: c.state ?? null,
                            district: typeof c.district === 'number' ? c.district : null,
                            sponsorshipDate: safeDate(c.sponsorshipDate),
                            isOriginal: c.isOriginalCosponsor === true,
                            withdrawnDate: safeDate(c.sponsorshipWithdrawnDate),
                          });
                        }
                        cosponsorOffset += page.length;
                        const total =
                          cosponsorsResp?.pagination?.countIncludingWithdrawnCosponsors ??
                          cosponsorsResp?.pagination?.count;
                        if (total !== undefined && cosponsorOffset >= total) break;
                        if (!cosponsorsResp?.pagination?.next) break;
                        await new Promise((r) => setTimeout(r, 200));
                      }
                    } catch {
                      // A mid-pagination failure leaves cosponsorsData PARTIAL
                      // (earlier pages already pushed). Mark it so persistence
                      // below skips the replace — a truncated roster must not
                      // overwrite a complete one (the bill's updateDate has
                      // already advanced, so incremental runs would never heal it).
                      cosponsorsFetchFailed = true;
                    }
                  }
                }

                const authoritativeClassifications = authoritativeCongressClassifications(
                  subjectsResult,
                  committeesResult,
                );
                const sponsor =
                  billData.sponsors?.[0] ??
                  bill.sponsors?.[0] ??
                  billData.sponsor ??
                  bill.sponsor ??
                  null;
                const latestAction = billData.latestAction ?? bill.latestAction ?? null;

                await prisma.congressBill.upsert({
                  where: { id },
                  update: {
                    title: billData.title ?? bill.title,
                    introducedDate: safeDate(billData.introducedDate ?? bill.introducedDate),
                    sponsorName: sponsor?.fullName ?? null,
                    sponsorState: sponsor?.state ?? null,
                    sponsorParty: sponsor?.party ?? null,
                    sponsorBioguideId: sponsor?.bioguideId?.toUpperCase() ?? null,
                    latestActionText: latestAction?.text ?? null,
                    latestActionDate: safeDate(latestAction?.actionDate),
                    policyArea: policyAreaName,
                    ...(authoritativeClassifications.subjects !== undefined
                      ? { subjects: authoritativeClassifications.subjects }
                      : {}),
                    ...(authoritativeClassifications.committees !== undefined
                      ? { committees: authoritativeClassifications.committees as object }
                      : {}),
                    cosponsorsCount: billData.cosponsors?.count ?? bill.cosponsors?.count ?? 0,
                    originChamber: billData.originChamber ?? bill.originChamber ?? null,
                    updateDate: safeDate(billData.updateDate ?? bill.updateDate),
                    updateDateIncludingText: safeDate(
                      billData.updateDateIncludingText ?? bill.updateDateIncludingText,
                    ),
                    url: bill.url ?? null,
                    lastSyncedAt: new Date(),
                  },
                  create: {
                    id,
                    congress,
                    billType: type,
                    billNumber: bill.number,
                    title: billData.title ?? bill.title,
                    introducedDate: safeDate(billData.introducedDate ?? bill.introducedDate),
                    sponsorName: sponsor?.fullName ?? null,
                    sponsorState: sponsor?.state ?? null,
                    sponsorParty: sponsor?.party ?? null,
                    sponsorBioguideId: sponsor?.bioguideId?.toUpperCase() ?? null,
                    latestActionText: latestAction?.text ?? null,
                    latestActionDate: safeDate(latestAction?.actionDate),
                    policyArea: policyAreaName,
                    ...(authoritativeClassifications.subjects !== undefined
                      ? { subjects: authoritativeClassifications.subjects }
                      : {}),
                    ...(authoritativeClassifications.committees !== undefined
                      ? { committees: authoritativeClassifications.committees as object }
                      : {}),
                    cosponsorsCount: billData.cosponsors?.count ?? bill.cosponsors?.count ?? 0,
                    originChamber: billData.originChamber ?? bill.originChamber ?? null,
                    updateDate: safeDate(billData.updateDate ?? bill.updateDate),
                    updateDateIncludingText: safeDate(
                      billData.updateDateIncludingText ?? bill.updateDateIncludingText,
                    ),
                    url: bill.url ?? null,
                  },
                });

                // Actions are required for every bill, independent of the
                // lobbying gate used by subjects/committees/cosponsors. Fetch
                // every page before replacing anything; a failed or partial
                // fetch preserves the existing normalized history.
                const initialActionsUrl = congressUrl(
                  `/bill/${congress}/${type}/${bill.number}/actions`,
                  { limit: 250 },
                );
                const actionSync = await syncCongressBillActions({
                  prisma,
                  billId: id,
                  fetchPage: async (nextPageUrl) => {
                    await new Promise((r) => setTimeout(r, 200));
                    return fetchJson<CongressActionsResponse>(
                      nextPageUrl
                        ? congressContinuationUrl(nextPageUrl, initialActionsUrl)
                        : initialActionsUrl,
                    );
                  },
                });
                if (actionSync.ok === true) {
                  actionsData = actionSync.actions;
                } else {
                  actionErrors += 1;
                  complete = false;
                  incompleteReasons.add('one or more bill action histories failed');
                  console.warn(
                    `[congress-sync] actions ${actionSync.stage} failed for ${id}; existing action rows preserved:`,
                    actionSync.error.message,
                  );
                }

                // Rule -> target bill linkage (LegiWatch A2). A rule hres
                // enumerates its targets in its title; a target bill's action
                // names its rule. Populate BOTH directions (idempotent) — runs
                // for EVERY bill regardless of the lobbying gate, because a rule
                // hres (e.g. H.Res. 1398) has a null policyArea and would
                // otherwise be skipped. This is what lets a rule's outcome reach
                // the target bill even though Congress.gov never appends it there.
                try {
                  const billTitle = billData.title ?? bill.title;
                  if (type === 'hres' && isRuleResolutionTitle(billTitle)) {
                    for (const targetId of parseRuleTargets(billTitle, congress)) {
                      if (targetId === id) continue;
                      await prisma.billRuleLink.upsert({
                        where: {
                          ruleBillId_targetBillId: { ruleBillId: id, targetBillId: targetId },
                        },
                        update: { source: 'title-parse', lastSyncedAt: new Date() },
                        create: { ruleBillId: id, targetBillId: targetId, source: 'title-parse' },
                      });
                    }
                  }
                  const actionTexts = [
                    latestAction?.text,
                    ...actionsData.map((a) => a.text),
                  ].filter((x): x is string => !!x);
                  const seenRules = new Set<string>();
                  for (const txt of actionTexts) {
                    const ruleId = parseRuleFromBillAction(txt, congress);
                    if (ruleId && ruleId !== id && !seenRules.has(ruleId)) {
                      seenRules.add(ruleId);
                      await prisma.billRuleLink.upsert({
                        where: {
                          ruleBillId_targetBillId: { ruleBillId: ruleId, targetBillId: id },
                        },
                        update: { source: 'action-parse', lastSyncedAt: new Date() },
                        create: { ruleBillId: ruleId, targetBillId: id, source: 'action-parse' },
                      });
                    }
                  }
                } catch (err) {
                  console.warn(`[sync-congress] rule-link upsert failed for ${id}:`, err);
                }

                // CBO cost estimates (Bucket-#3 C4.F1, SC2.4): the detail response
                // already carries cboCostEstimates[] — persist at zero extra API
                // cost. Publication id parsed from the URL is the stable key.
                for (const est of billData.cboCostEstimates ?? []) {
                  if (!est?.url || !est.pubDate) continue;
                  const pubIdMatch = est.url.match(/publication\/(\d+)/);
                  const estId = pubIdMatch?.[1] ?? `url:${est.url.slice(-80)}`;
                  const pub = safeDate(est.pubDate);
                  if (!pub) continue;
                  try {
                    await prisma.cboCostEstimate.upsert({
                      where: { id: estId },
                      update: {
                        billId: id,
                        title: est.title ?? 'CBO cost estimate',
                        description: est.description ?? null,
                        pubDate: pub,
                        lastSyncedAt: new Date(),
                      },
                      create: {
                        id: estId,
                        billId: id,
                        congress,
                        billType: type,
                        billNumber: bill.number,
                        title: est.title ?? 'CBO cost estimate',
                        description: est.description ?? null,
                        pubDate: pub,
                        cboUrl: est.url,
                        source: 'congress-api',
                      },
                    });
                  } catch (err) {
                    console.warn(`[sync-congress] cbo estimate upsert failed for ${id}:`, err);
                  }
                }

                // Upsert normalized committees and subjects for relevant/tracked/rule bills.
                // Actions are synced for every bill above, in their own atomic replacement.
                if (fetchSubResources) {
                  await replaceCongressBillClassificationsAtomically(
                    prisma,
                    id,
                    authoritativeClassifications,
                  );

                  // Cosponsor rows: replace only when the fetch FULLY
                  // succeeded — a failed or mid-pagination-truncated fetch
                  // must NOT overwrite rows from a previous run. Atomic swap
                  // so readers never observe the between-state.
                  if (cosponsorsData.length > 0 && !cosponsorsFetchFailed) {
                    await prisma.$transaction([
                      prisma.congressBillCosponsor.deleteMany({ where: { billId: id } }),
                      prisma.congressBillCosponsor.createMany({
                        data: cosponsorsData.map((c) => ({ billId: id, ...c })),
                        skipDuplicates: true,
                      }),
                    ]);
                  }
                }

                // Embed the bill inline. content_hash in embedAndUpsert means a
                // re-sync of unchanged bills is free. Caught here so a Bedrock
                // hiccup doesn't kill the whole sync run.
                if (EMBED_ON_SYNC && subjectsResult?.ok !== false) {
                  try {
                    await embedAndUpsert(prisma, {
                      tenantId: null,
                      sourceType: 'bill',
                      sourceId: id,
                      text: buildBillText({
                        billNumber: bill.number,
                        billType: type,
                        congress,
                        title: billData.title ?? bill.title,
                        policyArea: policyAreaName,
                        subjects,
                        latestActionText: latestAction?.text ?? null,
                        sponsorName: sponsor?.fullName ?? null,
                      }),
                      bypassRls: true,
                    });
                  } catch (e) {
                    console.error(`[congress-sync] embed ${id} failed:`, (e as Error).message);
                  }
                }

                congressBills++;
                totalBills++;
                if (totalBills % 500 === 0) {
                  console.log(`[congress-sync]   ${totalBills} bills processed...`);
                }
              } catch (err) {
                syncErrors += 1;
                complete = false;
                incompleteReasons.add('one or more bills failed during processing');
                console.warn(
                  `[congress-sync] skip bill:`,
                  err instanceof Error ? err.message : err,
                );
              }
            }

            offset += LIMIT;
            if (!listResp.pagination?.next) {
              reachedEnd = true;
              break;
            }
          }

          if (!reachedEnd && !stoppedByListFailure) {
            complete = false;
            incompleteReasons.add(`${congress}th Congress hit the page safety cap`);
            console.warn(
              `[congress-sync] ${congress}th Congress: STOPPED at the MAX_PAGES_PER_CONGRESS=${MAX_PAGES_PER_CONGRESS} ` +
                `safety cap (${congressBills} bills) but the API still had more pages — coverage is INCOMPLETE. ` +
                `Re-run a full (non-incremental) sync with a higher CONGRESS_MAX_PAGES.`,
            );
          }
          console.log(`[congress-sync] ${congress}th Congress: ${congressBills} bills`);
        }

        console.log(`[congress-sync] total bills: ${totalBills}`);
        const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
        console.log(`[congress-sync] DONE in ${elapsed}m`);
        return {
          inserted: 0,
          updated: totalBills,
          skipped: 0,
          errors: actionErrors + syncErrors,
          complete,
          incompleteReason: complete ? undefined : [...incompleteReasons].join('; '),
        };
      },
      { overrideSince: SINCE_OVERRIDE ?? null },
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[congress-sync] FAILED', err);
  process.exit(1);
});
