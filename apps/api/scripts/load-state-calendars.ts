/**
 * Load committed state-session procedural calendars (Phase 1 M2.1, PD5).
 * `sineDie` alone is LegiScan-automated (S1); crossover/committee-cutoff/convene
 * dates are NOT published as structured data by most states, so they're NCSL/
 * primary-source manual curation, committed as seed files under
 * `__data__/state-session-calendars.<state>-<yearStart>.json` (one per
 * priority state — see `PRIORITY_STATE_CODES`). Each file is sourced from the
 * state legislature's own official calendar (or NCSL as corroboration), with
 * `sourceUrls`/`notes` carrying provenance — grep this directory before trusting
 * a date instead of re-deriving it.
 *
 * Idempotent: matches the target `state_session` row by (state, yearStart)
 * rather than a guessed LegiScan `sessionKey` string, and only writes when a
 * field's resolved value actually differs. A state/year with no matching
 * `state_session` row (not yet ingested) is logged and skipped — never
 * fabricates a session row.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/load-state-calendars.ts
 * Env: STATE_CALENDAR_FILES (optional CSV of filenames under __data__/ to load;
 *      default = every state-session-calendars.*.json file present).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();
const DATA_DIR = join(__dirname, '__data__');

interface StateCalendarSeed {
  state: string;
  yearStart: number;
  convene: string | null;
  crossoverDate: string | null;
  committeeCutoffDate: string | null;
  secondCommitteeCutoffDate: string | null;
  sineDie: string | null;
  calendarSource: 'legiscan' | 'ncsl' | 'manual';
  calendarConfidence: 'high' | 'curated' | 'estimated';
  sourceUrls: string[];
  notes?: string;
}

function parseDateOnly(s: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: "${s}"`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

async function main() {
  await runWithSyncRun(prisma as never, 'load-state-calendars', async () => {
    const wanted = (process.env.STATE_CALENDAR_FILES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const files = (
      wanted.length
        ? wanted
        : readdirSync(DATA_DIR).filter((f) => /^state-session-calendars\..*\.json$/.test(f))
    ).sort();

    let updated = 0;
    let unchanged = 0;
    let skippedNoSession = 0;
    let errors = 0;

    for (const file of files) {
      try {
        const seed = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as StateCalendarSeed;
        const session = await prisma.stateSession.findFirst({
          where: { state: seed.state, yearStart: seed.yearStart },
          orderBy: { prior: 'asc' }, // prefer the non-prior row if both exist
        });
        if (!session) {
          skippedNoSession++;
          console.log(
            `[load-state-calendars] ${file}: no state_session row for (${seed.state}, yearStart=${seed.yearStart}) — skipped, not fabricated`,
          );
          continue;
        }

        const next = {
          convene: parseDateOnly(seed.convene),
          crossoverDate: parseDateOnly(seed.crossoverDate),
          committeeCutoffDate: parseDateOnly(seed.committeeCutoffDate),
          secondCommitteeCutoffDate: parseDateOnly(seed.secondCommitteeCutoffDate),
        };
        const changed =
          !sameDate(next.convene, session.convene) ||
          !sameDate(next.crossoverDate, session.crossoverDate) ||
          !sameDate(next.committeeCutoffDate, session.committeeCutoffDate) ||
          !sameDate(next.secondCommitteeCutoffDate, session.secondCommitteeCutoffDate) ||
          session.calendarSource !== seed.calendarSource ||
          session.calendarConfidence !== seed.calendarConfidence;

        if (!changed) {
          unchanged++;
          continue;
        }

        await prisma.stateSession.update({
          where: { id: session.id },
          data: {
            ...next,
            calendarSource: seed.calendarSource,
            calendarConfidence: seed.calendarConfidence,
          },
        });
        updated++;
        console.log(`[load-state-calendars] ${file}: updated ${seed.state} session ${session.id}`);
      } catch (err) {
        errors++;
        console.error(`[load-state-calendars] ${file} failed:`, err);
      }
    }

    console.log(
      `[load-state-calendars] ${files.length} seed file(s): ${updated} updated, ${unchanged} unchanged, ${skippedNoSession} skipped (no matching session), ${errors} errors`,
    );
    return { updated, unchanged, skippedNoSession, errors };
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
