/**
 * Sync Senate roll-call votes (LegiWatch A1 / Bucket-#3 C1.V3). GLOBAL.
 *
 * Source: senate.gov LIS XML — the ONLY machine-readable Senate vote source
 * (no API exists). Live-verified shape 2026-07-09:
 *   - menu  `roll_call_lists/vote_menu_{c}_{s}.xml` → vote_summary.votes.vote[]
 *     { vote_number "00192", issue "S.J.Res. 185"|"PN938-2", result, vote_tally }
 *   - vote  `roll_call_votes/vote{c}{s}/vote_{c}_{s}_{NNNNN}.xml` → roll_call_vote
 *     { vote_date "June 24, 2026, 10:30 PM", vote_question_text, document.document_name,
 *       count{yeas,nays,present,absent}, members.member[]{ lis_member_id "S428",
 *       vote_cast, party, state } }
 * Members are keyed by lis_member_id → bioguide via congress_member.lisId (the
 * crosswalk shipped in Wave 1). Unresolved lis ids are KEPT (memberKey
 * "lis:{id}", bioguideId null) so the tally stays complete and lag is visible.
 * Senate rows carry NO updateDate, so we re-pull the most recent
 * SENATE_VOTES_REPULL (default 25) numbers each run to catch late corrections.
 * NEVER fetch the House Clerk EVS XML (403s automation) — House uses the API.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-senate-votes.ts
 * Env: VOTE_CONGRESSES (default "119"), VOTE_SESSIONS (default "1,2"),
 *      SENATE_VOTES_REPULL (default 25), SENATE_VOTES_FULL=1.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { XMLParser } from 'fast-xml-parser';
import { parseBillDesignation, formatBillId } from '@capiro/shared';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { tallyFrom } from '../src/ingestion/vote-tally.util.js';
dotenvConfig();

const prisma = new PrismaClient();
const SENATE_BASE = 'https://www.senate.gov/legislative/LIS';
const UA = 'Mozilla/5.0 (compatible; CapiroLegiWatch/1.0)';
const VOTE_CONGRESSES = (process.env.VOTE_CONGRESSES ?? '119')
  .split(',')
  .map((c) => parseInt(c.trim(), 10))
  .filter((c) => Number.isInteger(c) && c > 0);
const VOTE_SESSIONS = (process.env.VOTE_SESSIONS ?? '1,2')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((s) => s === 1 || s === 2);
const REPULL = parseInt(process.env.SENATE_VOTES_REPULL ?? '25', 10);
const FULL = process.env.SENATE_VOTES_FULL === '1';

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === 'vote' || name === 'member',
  parseTagValue: false, // keep everything a string; we coerce deliberately
});

export function senateRollId(congress: number, session: number, roll: number): string {
  return `senate-${congress}-${session}-${roll}`;
}

/**
 * Senate vote → canonical billId. The document_name / issue is a bill
 * designation ("S.J.Res. 185") for legislation, or a nomination ("PN938-2") /
 * treaty which is NOT a bill → null.
 */
export function resolveSenateBillId(
  documentName: string | null | undefined,
  issue: string | null | undefined,
  congress: number,
): string | null {
  for (const raw of [documentName, issue]) {
    const s = (raw ?? '').trim();
    if (!s || /^PN/i.test(s) || /^Treaty/i.test(s)) continue;
    const parsed = parseBillDesignation(s, congress);
    if (parsed) return formatBillId(parsed.congress, parsed.type, parsed.number);
  }
  return null;
}

/**
 * Parse the LIS vote_date ("June 24, 2026,  10:30 PM") → Date at UTC midnight,
 * fallback Jan 1 of the congress year. Parsed as UTC (append " UTC") so a
 * non-UTC backfill host can't push the day off-by-one — the House sync's ISO
 * date parse is already TZ-stable, and this keeps both chambers consistent.
 */
export function parseSenateVoteDate(raw: string | null | undefined, fallbackYear: number): Date {
  const m = (raw ?? '').match(/([A-Za-z]+ \d{1,2}, \d{4})/);
  if (m?.[1]) {
    const d = new Date(`${m[1]} UTC`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(Date.UTC(fallbackYear, 0, 1));
}

async function fetchText(url: string, attempt = 1): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/xml, text/xml' } });
  } catch (err) {
    if (attempt <= 3) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      return fetchText(url, attempt + 1);
    }
    throw err;
  }
  if (res.status >= 500 && attempt <= 3) {
    await new Promise((r) => setTimeout(r, attempt * 5000));
    return fetchText(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

interface MenuVote {
  vote_number?: string;
  issue?: string;
  question?: string;
  result?: string;
  title?: string;
  vote_tally?: { yeas?: string; nays?: string };
}
interface PerVoteMember {
  lis_member_id?: string;
  vote_cast?: string;
  party?: string;
  state?: string;
}

async function main() {
  await runWithSyncRun(prisma as never, 'sync-senate-votes', async () => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // lis_member_id -> bioguide (Wave-1 crosswalk).
    const members = await prisma.congressMember.findMany({
      where: { lisId: { not: null } },
      select: { lisId: true, bioguideId: true },
    });
    const lisToBioguide = new Map(members.map((m) => [m.lisId as string, m.bioguideId]));

    for (const congress of VOTE_CONGRESSES) {
      for (const session of VOTE_SESSIONS) {
        const menuXml = await fetchText(
          `${SENATE_BASE}/roll_call_lists/vote_menu_${congress}_${session}.xml`,
        ).catch((e) => {
          console.error(`[sync-senate-votes] menu ${congress}/${session}:`, e);
          return null;
        });
        if (!menuXml) continue;
        const menu = parser.parse(menuXml) as {
          vote_summary?: { congress_year?: string; votes?: { vote?: MenuVote[] } };
        };
        const congressYear =
          parseInt(menu.vote_summary?.congress_year ?? '0', 10) || congress * 2 + 1787;
        const menuVotes = menu.vote_summary?.votes?.vote ?? [];
        if (!menuVotes.length) continue;

        // Which numbers to (re)fetch: new ones + the most recent REPULL window.
        const existing = await prisma.rollCallVote.findMany({
          where: { chamber: 'senate', congress, session },
          select: { rollNumber: true },
        });
        const known = new Set(existing.map((e) => e.rollNumber));
        // Map each menu entry to its parsed roll number (skip malformed).
        const numByPadded = new Map<number, string>();
        const menuByNum = new Map<number, MenuVote>();
        for (const v of menuVotes) {
          const raw = (v.vote_number ?? '').trim();
          const n = parseInt(raw, 10);
          if (!Number.isInteger(n) || n <= 0) continue;
          numByPadded.set(n, raw);
          menuByNum.set(n, v);
        }
        const allNums = [...menuByNum.keys()];
        const maxNum = allNums.length ? Math.max(...allNums) : 0;

        for (const num of allNums.sort((a, b) => a - b)) {
          const isKnown = known.has(num);
          const inRepull = num > maxNum - REPULL;
          if (!FULL && isKnown && !inRepull) {
            skipped++;
            continue;
          }
          const padded = numByPadded.get(num) ?? String(num).padStart(5, '0');
          const menuVote = menuByNum.get(num);
          const id = senateRollId(congress, session, num);
          try {
            const voteXml = await fetchText(
              `${SENATE_BASE}/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`,
            );
            const doc = parser.parse(voteXml) as { roll_call_vote?: Record<string, unknown> };
            const rc = (doc.roll_call_vote ?? {}) as {
              vote_date?: string;
              vote_question_text?: string;
              question?: string;
              vote_title?: string;
              vote_result?: string;
              majority_requirement?: string;
              document?: { document_name?: string };
              count?: { yeas?: string; nays?: string; present?: string; absent?: string };
              members?: { member?: PerVoteMember[] };
            };
            const memberList = rc.members?.member ?? [];
            const documentName = rc.document?.document_name ?? null;
            const billId = resolveSenateBillId(documentName, menuVote?.issue, congress);
            const voteDate = parseSenateVoteDate(rc.vote_date, congressYear);
            const tally = tallyFrom(memberList.map((m) => ({ cast: m.vote_cast, party: m.party })));
            // Prefer the authoritative <count> block for overall totals.
            const yeas = parseInt(rc.count?.yeas ?? '', 10);
            const nays = parseInt(rc.count?.nays ?? '', 10);
            const present = parseInt(rc.count?.present ?? '', 10);
            const absent = parseInt(rc.count?.absent ?? '', 10);

            const memberRows = memberList
              .filter((m) => m.lis_member_id)
              .map((m) => {
                const lisId = m.lis_member_id!.trim();
                const bioguide = lisToBioguide.get(lisId) ?? null;
                return {
                  memberKey: bioguide ?? `lis:${lisId}`,
                  bioguideId: bioguide,
                  lisId,
                  voteCast: m.vote_cast ?? '',
                  party: m.party ?? null,
                  state: m.state ?? null,
                };
              });

            const data = {
              chamber: 'senate',
              congress,
              session,
              rollNumber: num,
              billId,
              question: rc.vote_question_text ?? rc.question ?? menuVote?.question ?? null,
              result: rc.vote_result ?? menuVote?.result ?? null,
              voteType: rc.majority_requirement ?? null,
              voteDate,
              yeas: Number.isInteger(yeas) ? yeas : tally.yeas,
              nays: Number.isInteger(nays) ? nays : tally.nays,
              present: Number.isInteger(present) ? present : tally.present,
              notVoting: Number.isInteger(absent) ? absent : tally.notVoting,
              partyTotals: tally.partyTotals as object,
              title: rc.vote_title ?? menuVote?.title ?? null,
              sourceUrl: `${SENATE_BASE}/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`,
              source: 'senate-lis',
              lastSyncedAt: new Date(),
            };
            await prisma.$transaction([
              prisma.rollCallVote.upsert({ where: { id }, create: { id, ...data }, update: data }),
              prisma.memberVote.deleteMany({ where: { voteId: id } }),
              prisma.memberVote.createMany({
                data: memberRows.map((r) => ({ voteId: id, ...r })),
                skipDuplicates: true,
              }),
            ]);
            if (isKnown) updated++;
            else inserted++;
            await new Promise((r) => setTimeout(r, 200));
          } catch (err) {
            errors++;
            console.error(`[sync-senate-votes] vote ${id} failed:`, err);
          }
        }
        const unresolved = await prisma.memberVote.count({
          where: { vote: { chamber: 'senate', congress, session }, bioguideId: null },
        });
        if (unresolved > 0) {
          console.warn(
            `[sync-senate-votes] ${congress}/${session}: ${unresolved} member positions with an unresolved lis id (crosswalk lag)`,
          );
        }
        console.log(
          `[sync-senate-votes] congress ${congress} session ${session}: ${allNums.length} votes in menu`,
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
