/**
 * Sync House roll-call votes (LegiWatch A1 / Bucket-#3 C1.V2). GLOBAL.
 *
 * Source: Congress.gov `/v3/house-vote/{congress}/{session}` (GA since Dec
 * 2025, shared CONGRESS_API_KEY). Live-verified shape 2026-07-09:
 *   - list item: legislationType ("HR"|"HRES"|...), legislationNumber, result,
 *     rollCallNumber, voteType, startDate, sourceDataURL, updateDate, url.
 *   - `/{roll}/members`: container carries voteQuestion + results[] where each
 *     member is { bioguideID, voteCast, voteParty, voteState }.
 * We enumerate via the list, then ONE `/members` call per vote gives the
 * question AND the member positions — tallies + party totals are computed from
 * the members (no separate detail call). Bill linkage is direct from
 * legislationType+Number (a RULE vote is legislationType "HRES" → its hres id;
 * bill_rule_link propagates that outcome to the target bills in A2).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-house-votes.ts
 * Env: CONGRESS_API_KEY (required), VOTE_CONGRESSES (default "119"),
 *      VOTE_SESSIONS (default "1,2"), HOUSE_VOTES_FULL=1 (re-fetch every vote).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { formatBillId } from '@capiro/shared';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { tallyFrom } from '../src/ingestion/vote-tally.util.js';
dotenvConfig();

const prisma = new PrismaClient();
const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY ?? '';
const API_BASE = 'https://api.congress.gov/v3';
const VOTE_CONGRESSES = (process.env.VOTE_CONGRESSES ?? '119')
  .split(',')
  .map((c) => parseInt(c.trim(), 10))
  .filter((c) => Number.isInteger(c) && c > 0);
const VOTE_SESSIONS = (process.env.VOTE_SESSIONS ?? '1,2')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((s) => s === 1 || s === 2);
const FULL = process.env.HOUSE_VOTES_FULL === '1';

interface HouseVoteListItem {
  legislationType?: string | null;
  legislationNumber?: string | null;
  result?: string | null;
  rollCallNumber?: number;
  sessionNumber?: number;
  voteType?: string | null;
  startDate?: string | null;
  updateDate?: string | null;
  sourceDataURL?: string | null;
  url?: string | null;
}
interface HouseMemberVote {
  bioguideID?: string | null;
  voteCast?: string | null;
  voteParty?: string | null;
  voteState?: string | null;
}

export function houseRollId(congress: number, session: number, roll: number): string {
  return `house-${congress}-${session}-${roll}`;
}

/** legislationType+Number -> canonical billId, or null for non-bill measures. */
export function resolveHouseBillId(
  congress: number,
  legislationType: string | null | undefined,
  legislationNumber: string | null | undefined,
): string | null {
  if (!legislationType || !legislationNumber) return null;
  const n = parseInt(String(legislationNumber).trim(), 10);
  if (!Number.isInteger(n)) return null;
  return formatBillId(congress, legislationType.toLowerCase(), n);
}

async function fetchJson<T>(url: string, attempt = 1): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    if (attempt <= 3) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      return fetchJson<T>(url, attempt + 1);
    }
    throw err;
  }
  if ((res.status === 429 || res.status >= 500) && attempt <= 3) {
    const wait = Number(res.headers.get('retry-after') ?? String(attempt * 15)) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return fetchJson<T>(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function main() {
  if (!CONGRESS_API_KEY) throw new Error('CONGRESS_API_KEY env var is required');

  await runWithSyncRun(prisma as never, 'sync-house-votes', async () => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const congress of VOTE_CONGRESSES) {
      for (const session of VOTE_SESSIONS) {
        // 1. Enumerate the session's roll-call list (paginated 250).
        const listItems: HouseVoteListItem[] = [];
        let offset = 0;
        for (;;) {
          const page = await fetchJson<{
            houseRollCallVotes?: HouseVoteListItem[];
            pagination?: { count?: number };
          }>(
            `${API_BASE}/house-vote/${congress}/${session}?format=json&limit=250&offset=${offset}&api_key=${CONGRESS_API_KEY}`,
          ).catch((e) => {
            console.error(`[sync-house-votes] list ${congress}/${session} offset ${offset}:`, e);
            return null;
          });
          const items = page?.houseRollCallVotes ?? [];
          if (!items.length) break;
          listItems.push(...items);
          offset += items.length;
          if (page?.pagination?.count !== undefined && offset >= page.pagination.count) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        if (!listItems.length) continue;

        // 2. Decide which need a members fetch (incremental: new or updated).
        const existing = await prisma.rollCallVote.findMany({
          where: { chamber: 'house', congress, session },
          select: { id: true, lastSyncedAt: true },
        });
        const seen = new Map(existing.map((e) => [e.id, e.lastSyncedAt]));

        for (const item of listItems) {
          const roll = item.rollCallNumber;
          if (typeof roll !== 'number') {
            skipped++;
            continue;
          }
          const id = houseRollId(congress, session, roll);
          const priorSync = seen.get(id);
          const listUpdate = item.updateDate ? new Date(item.updateDate) : null;
          if (!FULL && priorSync && listUpdate && listUpdate <= priorSync) {
            skipped++;
            continue; // unchanged since last sync
          }

          try {
            const mres = await fetchJson<{
              houseRollCallVoteMemberVotes?: {
                voteQuestion?: string | null;
                results?: HouseMemberVote[];
              };
            }>(
              `${API_BASE}/house-vote/${congress}/${session}/${roll}/members?format=json&api_key=${CONGRESS_API_KEY}`,
            );
            const container = mres.houseRollCallVoteMemberVotes ?? {};
            const members = container.results ?? [];
            const tally = tallyFrom(members.map((m) => ({ cast: m.voteCast, party: m.voteParty })));
            const billId = resolveHouseBillId(
              congress,
              item.legislationType,
              item.legislationNumber,
            );
            const voteDate = item.startDate ? new Date(item.startDate) : new Date();

            const memberRows = members
              .filter((m) => m.bioguideID)
              .map((m) => ({
                memberKey: m.bioguideID!.toUpperCase(),
                bioguideId: m.bioguideID!.toUpperCase(),
                lisId: null as string | null,
                voteCast: m.voteCast ?? '',
                party: m.voteParty ?? null,
                state: m.voteState ?? null,
              }));

            const data = {
              chamber: 'house',
              congress,
              session,
              rollNumber: roll,
              billId,
              question: container.voteQuestion ?? null,
              result: item.result ?? null,
              voteType: item.voteType ?? null,
              voteDate,
              yeas: tally.yeas,
              nays: tally.nays,
              present: tally.present,
              notVoting: tally.notVoting,
              partyTotals: tally.partyTotals as object,
              title: null,
              sourceUrl: item.sourceDataURL ?? item.url ?? null,
              source: 'house-api',
              lastSyncedAt: new Date(),
            };
            const isNew = !seen.has(id);
            await prisma.$transaction([
              prisma.rollCallVote.upsert({ where: { id }, create: { id, ...data }, update: data }),
              prisma.memberVote.deleteMany({ where: { voteId: id } }),
              prisma.memberVote.createMany({
                data: memberRows.map((r) => ({ voteId: id, ...r })),
                skipDuplicates: true,
              }),
            ]);
            if (isNew) inserted++;
            else updated++;
            await new Promise((r) => setTimeout(r, 150));
          } catch (err) {
            errors++;
            console.error(`[sync-house-votes] vote ${id} failed:`, err);
          }
        }
        console.log(
          `[sync-house-votes] congress ${congress} session ${session}: ${listItems.length} rolls, +${inserted}/~${updated}`,
        );
      }
    }
    return { inserted, updated, skipped, errors };
  });
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
