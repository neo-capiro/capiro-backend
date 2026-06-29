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

dotenvConfig();

// Toggle for the per-row embed call. Defaults to enabled in prod (the API
// container has bedrock:InvokeModel via the task role) but you can flip it
// off via env when smoke-testing the sync logic without burning Bedrock.
const EMBED_ON_SYNC = process.env.EMBED_ON_SYNC !== '0';

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
const TARGET_CONGRESSES = (process.env.CONGRESS_TARGETS
  ? process.env.CONGRESS_TARGETS.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
  : [117, 118, 119]);

// Incremental mode: pass `--incremental` (or set CONGRESS_SYNC_INCREMENTAL=1)
// to limit the upstream fetch to bills updated since the most recent
// congress_bill.update_date in the DB. Congress.gov's /bill endpoint accepts
// `fromDateTime` (ISO Z format). The hard MAX_PAGES_PER_CONGRESS cap stays
// in place as a safety bound.
const INCREMENTAL =
  process.argv.includes('--incremental') ||
  process.env.CONGRESS_SYNC_INCREMENTAL === '1';
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
  sponsors?: Array<{ fullName?: string | null; party?: string | null; state?: string | null }> | null;
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
    originChamber?: string | null;
    updateDate?: string | null;
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
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
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
          console.warn(`[congress-sync] failed to fetch bill list congress=${congress} offset=${offset}:`, err instanceof Error ? err.message : err);
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

            const billData = detail?.bill ?? bill as unknown as CongressBillDetail['bill'];
            const policyAreaName = billData.policyArea?.name ?? bill.policyArea?.name ?? null;
            const isLobbyingRelevant = policyAreaName ? LOBBYING_POLICY_AREAS.has(policyAreaName) : false;

            // Fetch subjects, committees, and actions only for lobbying-relevant bills.
            let subjects: string[] = [];
            let committees: object[] = [];
            let actionsData: { date: Date; text: string; type: string | null; chamber: string | null }[] = [];

            if (isLobbyingRelevant) {
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
                  congressUrl(`/bill/${congress}/${type}/${bill.number}/actions`, { limit: 250 }),
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
            }

            const sponsor =
              billData.sponsors?.[0] ?? bill.sponsors?.[0] ?? billData.sponsor ?? bill.sponsor ?? null;
            const latestAction = billData.latestAction ?? bill.latestAction ?? null;

            await prisma.congressBill.upsert({
              where: { id },
              update: {
                title: billData.title ?? bill.title,
                introducedDate: safeDate(billData.introducedDate ?? bill.introducedDate),
                sponsorName: sponsor?.fullName ?? null,
                sponsorState: sponsor?.state ?? null,
                sponsorParty: sponsor?.party ?? null,
                latestActionText: latestAction?.text ?? null,
                latestActionDate: safeDate(latestAction?.actionDate),
                policyArea: policyAreaName,
                subjects,
                committees: committees as object,
                cosponsorsCount: billData.cosponsors?.count ?? bill.cosponsors?.count ?? 0,
                originChamber: billData.originChamber ?? bill.originChamber ?? null,
                updateDate: safeDate(billData.updateDate ?? bill.updateDate),
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
                latestActionText: latestAction?.text ?? null,
                latestActionDate: safeDate(latestAction?.actionDate),
                policyArea: policyAreaName,
                subjects,
                committees: committees as object,
                cosponsorsCount: billData.cosponsors?.count ?? bill.cosponsors?.count ?? 0,
                originChamber: billData.originChamber ?? bill.originChamber ?? null,
                updateDate: safeDate(billData.updateDate ?? bill.updateDate),
                url: bill.url ?? null,
              },
            });

            // Upsert normalized actions, committees, subjects for lobbying-relevant bills.
            if (isLobbyingRelevant) {
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
              const committeeObjects = committees as { name?: string | null; chamber?: string | null; systemCode?: string | null }[];
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
            console.warn(`[congress-sync] skip bill:`, err instanceof Error ? err.message : err);
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
