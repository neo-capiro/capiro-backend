/**
 * Read-only diagnostic: per-state crosswalk coverage for the State Legislators
 * directory. Reports, per state, how many `state_legislator` rows exist (the
 * roster) vs how many carry a `legiscan_people_id` (linked — the ONLY key the
 * legislator→bill read joins on, explorer `stateLegislatorDetail`). A high
 * `unlinked` count is the direct measure of "legislators showing no bills."
 *
 * No RLS/bypass needed — state_legislator is global reference data (same as
 * congress_member), like diag-state-legislator-detail. Writes nothing.
 *
 *   diag-state-crosswalk-coverage                       # all states
 *   diag-state-crosswalk-coverage --states FL,CA,TX     # only these
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface CoverageRow {
  state: string;
  total: number;
  linked: number;
  unlinked: number;
  linked_pct: number;
}

async function main() {
  const statesCsv = arg('states');
  const states = (statesCsv ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const where = states.length ? Prisma.sql`WHERE state = ANY(${states})` : Prisma.empty;

  const rows = await prisma.$queryRaw<CoverageRow[]>`
    SELECT
      state,
      COUNT(*)::int AS total,
      COUNT(legiscan_people_id)::int AS linked,
      (COUNT(*) - COUNT(legiscan_people_id))::int AS unlinked,
      ROUND(100.0 * COUNT(legiscan_people_id) / NULLIF(COUNT(*), 0), 1)::float8 AS linked_pct
    FROM state_legislator
    ${where}
    GROUP BY state
    ORDER BY state
  `;

  const totals = rows.reduce(
    (acc, r) => {
      acc.total += r.total;
      acc.linked += r.linked;
      acc.unlinked += r.unlinked;
      return acc;
    },
    { total: 0, linked: 0, unlinked: 0 },
  );

  console.log(
    JSON.stringify(
      {
        perState: rows,
        totals: {
          ...totals,
          linked_pct: totals.total > 0 ? Math.round((1000 * totals.linked) / totals.total) / 10 : 0,
        },
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
