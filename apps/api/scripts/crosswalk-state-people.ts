/**
 * Ongoing OpenStates↔LegiScan people crosswalk (State Legislation Platform S2).
 *
 * WHY THIS EXISTS: `state_legislator.legiscan_people_id` is the ONLY key the
 * legislator→bill/vote reads join on (explorer `stateLegislatorDetail`), and it
 * is populated ONLY by `crosswalkLegiscanPerson`. Before this verb, that
 * function ran exclusively inside the one-time `backfill-legiscan-datasets`, so
 * coverage was frozen at whatever the backfill matched — the ongoing
 * `sync-legiscan-bills` drain writes new sponsor rows but never (re)attempts a
 * crosswalk. Any legislator added later (or missed on the first pass because
 * `sync-openstates` had not yet ingested them, or the name match failed) stayed
 * unlinked forever and read "no sponsored bills".
 *
 * This verb re-runs the crosswalk on a schedule using `getSessionPeople` — ONE
 * LegiScan query per active session (quota-cheap, ~8-16 queries/run for the
 * priority states), returning full person records (district, role, party,
 * first/last name) so the conservative matcher has its strongest signals. It is
 * fully idempotent: an already-linked legislator re-resolves to itself (no-op),
 * and an unresolved person is simply retried next run as `sync-openstates`
 * fills in the roster.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/crosswalk-state-people.ts
 * Env: LEGISCAN_API_KEY (required); LEGISCAN_STATES (CSV, default the 8
 *      priority states, same convention as sync-legiscan-masterlist).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { getSessionPeople } from '../src/external/legiscan/legiscan.client.js';
import { PRIORITY_STATE_CODES } from '../src/external/legiscan/us-states.js';
import { crosswalkLegiscanPerson } from '../src/ingestion/legiscan-normalize.js';
import {
  currentQuotaMonth,
  monthToDateQueries,
  quotaExhausted,
  LEGISCAN_HARD_CAP,
} from '../src/ingestion/legiscan-quota.util.js';
dotenvConfig();

const prisma = new PrismaClient();
const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY ?? '';
const STATES = (process.env.LEGISCAN_STATES ?? PRIORITY_STATE_CODES.join(','))
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

export const SYNC_RUN_SOURCE = 'crosswalk-state-people';

async function main() {
  if (!LEGISCAN_API_KEY) throw new Error('LEGISCAN_API_KEY env var is required');

  await runWithSyncRun(prisma as never, SYNC_RUN_SOURCE, async () => {
    // getSessionPeople is 1 query/session — cheap, like the masterlist diff — so
    // gate on the true monthly hard cap rather than the drain's soft budget.
    const month = currentQuotaMonth();
    const allCursors = await prisma.stateSyncCursor.findMany({
      select: { queriesUsed: true, quotaMonth: true },
    });
    if (quotaExhausted(monthToDateQueries(allCursors, month), LEGISCAN_HARD_CAP)) {
      console.log(
        `INGESTION_SKIP ${JSON.stringify({ source: SYNC_RUN_SOURCE, reason: 'quota', budget: LEGISCAN_HARD_CAP })}`,
      );
      return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
    }

    let matched = 0;
    let people = 0;
    let unresolved = 0;
    let errors = 0;
    let totalQueries = 0;

    for (const state of STATES) {
      try {
        // Only current sessions — sponsors/votes were backfilled for these, and
        // state_legislator holds the current roster to match against. Read the
        // rows sync-legiscan-masterlist already maintains (no getSessionList
        // call needed here); a state with no synced sessions is simply skipped.
        const sessions = await prisma.stateSession.findMany({
          where: { state, prior: false },
        });

        for (const session of sessions) {
          const sessionPeople = await getSessionPeople(LEGISCAN_API_KEY, session.legiscanSessionId);
          totalQueries += 1;
          if (!sessionPeople.length) continue;

          for (const person of sessionPeople) {
            people++;
            try {
              if (await crosswalkLegiscanPerson(prisma, state, person, SYNC_RUN_SOURCE)) {
                matched++;
              } else {
                unresolved++;
              }
            } catch (err) {
              errors++;
              console.error(
                `[crosswalk-state-people] ${state} person ${person.people_id} failed:`,
                err,
              );
            }
          }

          // Attribute the getSessionPeople query to this session's cursor so the
          // monthly quota governor stays accurate (mirrors sync-legiscan-masterlist).
          const cursorId = `${state}-${session.legiscanSessionId}`;
          const cursor = await prisma.stateSyncCursor.findUnique({
            where: { id: cursorId },
            select: { quotaMonth: true },
          });
          const sameMonth = cursor?.quotaMonth === month;
          await prisma.stateSyncCursor.upsert({
            where: { id: cursorId },
            create: {
              id: cursorId,
              state,
              sessionId: session.legiscanSessionId,
              sessionKey: session.sessionKey,
              queriesUsed: 1,
              quotaMonth: month,
              lastListAt: new Date(),
            },
            update: {
              queriesUsed: sameMonth ? { increment: 1 } : 1,
              quotaMonth: month,
            },
          });
        }
      } catch (err) {
        errors++;
        console.error(`[crosswalk-state-people] ${state} failed:`, err);
      }
    }

    console.log(
      `[crosswalk-state-people] crosswalked ${matched}/${people} people ` +
        `(${unresolved} unresolved) across ${STATES.length} states ` +
        `(${totalQueries} queries), ${errors} errors`,
    );
    // `updated` = newly-or-re-confirmed crosswalk links; `skipped` = unresolved
    // (honest, retried next run); errors surface via INGESTION_METRIC.
    return { inserted: 0, updated: matched, skipped: unresolved, errors };
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
