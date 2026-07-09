/**
 * Sync Congress.gov legislative data (bills from 118th and 119th Congress).
 *
 *   pnpm --filter @capiro/api sync:congress
 *
 * Source: https://api.congress.gov/v3/, Congress.gov API.
 * Fetches bills, filters to lobbying-relevant policy areas.
 *
 * Steps:
 *   1. Paginate through 118th + 119th Congress bill lists
 *   2. For each bill, fetch detail (policyArea, sponsor, etc.)
 *   3. Fetch subjects and committees for relevant bills
 *   4. Upsert into congress_bill table
 *
 * Rate limit: ~5000 req/hour with API key. Script stays well under that.
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

interface CongressSubjectsResponse {
  subjects?: {
    legislativeSubjects?: { name: string }[];
    policyArea?: { name: string } | null;
  };
}

interface CongressCommitteesResponse {
  committees?: {
    activities?: { date?: string; name?: string }[];
    chamber?: string;
    name?: string;
    systemCode?: string;
    type?: string;
    url?: string;
  }[];
}

interface CongressActionsResponse {
  actions?: {
    actionDate?: string | null;
    text?: string | null;
    type?: string | null;
    actionCode?: string | null;
    sourceSystem?: { code?: number; name?: string } | null;
    chamber?: string | null;
  }[];
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

function redactKey(url: string): string {
  return url.replace(/(api_key=)[^&]+/i, '$1[REDACTED]');
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (err) {
      // Transient network error: back off and retry, then give up.
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }
      throw new Error(`GET ${redactKey(url)}: ${err instanceof Error ? err.message : err}`);
    }

    if (resp.status === 404) return null;

    // Congress.gov throttles at ~5k req/hour, so a full (uncapped) backfill WILL
    // hit 429. Honor Retry-After when present, else exponential backoff, so a long
    // run self-paces and recovers instead of aborting the page loop.
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(resp.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** (attempt - 1);
      console.warn(
        `[congress-sync] ${resp.status} on ${redactKey(url)} — retry ${attempt}/${MAX_RETRIES} in ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!resp.ok) throw new Error(`GET ${redactKey(url)}: ${resp.status} ${resp.statusText}`);
    return (await resp.json()) as T;
  }
  throw new Error(`GET ${redactKey(url)}: exhausted ${MAX_RETRIES} retries`);
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
      async (_ctx) => {
        let totalBills = 0;

        // LegiWatch A3: fetch the full sub-resource set (incl. /actions) for
        // TRACKED bills regardless of policy area — a tracked bill with a null
        // or non-lobbying policyArea would otherwise miss its action history.
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
          // Resolve fromDateTime for this congress. In incremental mode we read
          // the max(updateDate) for this congress's bills out of Postgres. If
          // nothing has ever been synced for this congress, fall back to a wide
          // window (Jan 1 2021), Congress.gov rejects requests with no scope.
          let fromDateTime: string | undefined;
          if (SINCE_OVERRIDE) {
            fromDateTime = toCongressDateTime(new Date(SINCE_OVERRIDE));
          } else if (INCREMENTAL) {
            const latest = await prisma.congressBill.findFirst({
              where: { congress },
              orderBy: { updateDate: 'desc' },
              select: { updateDate: true },
            });
            if (latest?.updateDate) {
              fromDateTime = toCongressDateTime(latest.updateDate);
            }
          }
          console.log(
            `[congress-sync] fetching ${congress}th Congress bills` +
              (fromDateTime ? ` since ${fromDateTime}` : ' (full window)'),
          );
          let offset = 0;
          let congressBills = 0;
          let reachedEnd = false;

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
                // LegiWatch A3: also fetch the sub-resource set (esp. /actions)
                // for TRACKED bills (any policy area) and for RULE resolutions
                // (null policyArea) so procedural/floor outcomes aren't dropped
                // by the lobbying gate — the exact H.Res. 1398 miss.
                const isRuleHres =
                  type === 'hres' && isRuleResolutionTitle(billData.title ?? bill.title);
                const fetchSubResources =
                  isLobbyingRelevant || trackedBillIds.has(id) || isRuleHres;

                // Fetch subjects, committees, and actions for relevant/tracked/rule bills.
                let subjects: string[] = [];
                let committees: object[] = [];
                let actionsData: {
                  date: Date;
                  text: string;
                  type: string | null;
                  chamber: string | null;
                }[] = [];
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

                  try {
                    const subjectsResp = await fetchJson<CongressSubjectsResponse>(
                      congressUrl(`/bill/${congress}/${type}/${bill.number}/subjects`),
                    );
                    if (subjectsResp?.subjects?.legislativeSubjects) {
                      subjects = subjectsResp.subjects.legislativeSubjects
                        .map((s) => s.name)
                        .filter((s): s is string => typeof s === 'string' && s.length > 0);
                    }
                  } catch {
                    // subjects stay empty
                  }

                  await new Promise((r) => setTimeout(r, 200));

                  try {
                    const committeesResp = await fetchJson<CongressCommitteesResponse>(
                      congressUrl(`/bill/${congress}/${type}/${bill.number}/committees`),
                    );
                    if (committeesResp?.committees) {
                      committees = committeesResp.committees.map((c) => ({
                        name: c.name ?? null,
                        chamber: c.chamber ?? null,
                        type: c.type ?? null,
                        systemCode: c.systemCode ?? null,
                      }));
                    }
                  } catch {
                    // committees stay empty
                  }

                  await new Promise((r) => setTimeout(r, 200));

                  try {
                    const actionsResp = await fetchJson<CongressActionsResponse>(
                      congressUrl(`/bill/${congress}/${type}/${bill.number}/actions`, {
                        limit: 250,
                      }),
                    );
                    if (actionsResp?.actions) {
                      for (const a of actionsResp.actions) {
                        const d = safeDate(a.actionDate);
                        if (!d || !a.text) continue;
                        actionsData.push({
                          date: d,
                          text: a.text,
                          type: a.type ?? null,
                          chamber: a.chamber ?? null,
                        });
                      }
                    }
                  } catch {
                    // actions stay empty
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
                    subjects,
                    committees: committees as object,
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
                    subjects,
                    committees: committees as object,
                    cosponsorsCount: billData.cosponsors?.count ?? bill.cosponsors?.count ?? 0,
                    originChamber: billData.originChamber ?? bill.originChamber ?? null,
                    updateDate: safeDate(billData.updateDate ?? bill.updateDate),
                    updateDateIncludingText: safeDate(
                      billData.updateDateIncludingText ?? bill.updateDateIncludingText,
                    ),
                    url: bill.url ?? null,
                  },
                });

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

                // Upsert normalized actions, committees, subjects for relevant/tracked/rule bills.
                if (fetchSubResources) {
                  // Delete existing rows and re-insert (simpler than diffing).
                  await prisma.congressBillAction.deleteMany({ where: { billId: id } });
                  if (actionsData.length > 0) {
                    await prisma.congressBillAction.createMany({
                      data: actionsData.map((a) => ({
                        billId: id,
                        date: a.date,
                        text: a.text,
                        type: a.type,
                        chamber: a.chamber,
                      })),
                    });
                  }

                  await prisma.congressBillCommittee.deleteMany({ where: { billId: id } });
                  const committeeObjects = committees as {
                    name?: string | null;
                    chamber?: string | null;
                    systemCode?: string | null;
                  }[];
                  if (committeeObjects.length > 0) {
                    await prisma.congressBillCommittee.createMany({
                      data: committeeObjects
                        .filter((c) => c.name)
                        .map((c) => ({
                          billId: id,
                          committeeName: c.name!,
                          committeeCode: c.systemCode ?? null,
                          chamber: c.chamber ?? null,
                        })),
                    });
                  }

                  await prisma.congressBillSubject.deleteMany({ where: { billId: id } });
                  if (subjects.length > 0) {
                    await prisma.congressBillSubject.createMany({
                      data: subjects.map((name) => ({ billId: id, name })),
                    });
                  }

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
                if (EMBED_ON_SYNC) {
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

          if (!reachedEnd) {
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
        return { inserted: 0, updated: totalBills, skipped: 0, errors: 0 };
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
