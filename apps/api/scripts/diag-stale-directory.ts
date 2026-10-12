/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * diag-stale-directory.ts — READ-ONLY diagnostic. Writes nothing.
 *
 *   tsx scripts/diag-stale-directory.ts
 *
 * Counts the old-DoW-directory data still live in the system so we can state the
 * cleanup's blast radius HONESTLY before running any --commit reconcile (the API
 * container rejects ad-hoc SQL, so this verb is the supported way to query prod).
 *
 * The counts here use the SAME predicates as the reconcile/repair classifiers, so
 * "wouldSupersede" / "wouldRetire" / "linksToRepair" equal what those jobs will do.
 *
 *   personnel  — people whose ENTIRE provenance is the old DoW spreadsheet
 *                (stanford_dow_directory_jan2026 / stanford_dow_tier1) and who are
 *                absent from the updated directory (dow_directory_rev6_2026_06).
 *   PEs        — program_element rows still tagged stanford_pe_directory_jan2026
 *                (the J-book never re-asserted them), split by "has live signal"
 *                (keep) vs none (retire).
 *   links      — non-superseded people whose pe_primary points at a missing/retired
 *                PE (the link-repair set), and how many of those are human-trusted.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';

dotenvConfig();

async function section<T>(label: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: `${label}: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}` };
  }
}

async function main(): Promise<void> {
  const usage = 'Usage: apps/api/scripts/diag-stale-directory.ts requires DATABASE_URL (database configuration is required)';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (args.length > 0) {
    console.error(usage);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(usage);
    process.exit(2);
  }
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const personnel = await section('personnel', async () => {
      const rows = await prisma.$queryRaw<
        Array<{
          total: number;
          alreadySuperseded: number;
          wouldSupersede: number;
          wouldSupersedeTier1: number;
          wouldSupersedeLinkedToPe: number;
          inCurrentDirectory: number;
          inBothDirectories: number;
        }>
      >(Prisma.sql`
        WITH person_src AS (
          SELECT
            ap.id,
            ap.pe_primary,
            ap.pe_secondary,
            ap.superseded_at,
            COUNT(aps.id) AS n_src,
            COUNT(aps.id) FILTER (
              WHERE aps.source IN ('stanford_dow_directory_jan2026', 'stanford_dow_tier1')
            ) AS n_deprecated,
            BOOL_OR(aps.source = 'stanford_dow_tier1') AS has_tier1,
            BOOL_OR(aps.source = 'dow_directory_rev6_2026_06') AS has_rev6,
            BOOL_OR(aps.source IN ('stanford_dow_directory_jan2026', 'stanford_dow_tier1')) AS has_deprecated
          FROM acquisition_personnel ap
          LEFT JOIN acquisition_personnel_source aps ON aps.person_id = ap.id
          GROUP BY ap.id
        )
        SELECT
          COUNT(*)::int AS "total",
          COUNT(*) FILTER (WHERE superseded_at IS NOT NULL)::int AS "alreadySuperseded",
          COUNT(*) FILTER (WHERE superseded_at IS NULL AND n_src > 0 AND n_deprecated = n_src)::int AS "wouldSupersede",
          COUNT(*) FILTER (WHERE superseded_at IS NULL AND n_src > 0 AND n_deprecated = n_src AND has_tier1)::int AS "wouldSupersedeTier1",
          COUNT(*) FILTER (
            WHERE superseded_at IS NULL AND n_src > 0 AND n_deprecated = n_src
              AND (pe_primary IS NOT NULL OR COALESCE(array_length(pe_secondary, 1), 0) > 0)
          )::int AS "wouldSupersedeLinkedToPe",
          COUNT(*) FILTER (WHERE has_rev6)::int AS "inCurrentDirectory",
          COUNT(*) FILTER (WHERE has_rev6 AND has_deprecated)::int AS "inBothDirectories"
        FROM person_src
      `);
      return rows[0];
    });

    const programElements = await section('programElements', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ oldActive: number; keepRealButUncovered: number; wouldRetire: number }>
      >(Prisma.sql`
        WITH old_pes AS (
          SELECT pe_code
          FROM program_element
          WHERE source = 'stanford_pe_directory_jan2026' AND retired_at IS NULL
        ),
        scored AS (
          SELECT
            p.pe_code,
            (
              EXISTS (SELECT 1 FROM program_element_year y WHERE y.pe_code = p.pe_code)
              OR EXISTS (SELECT 1 FROM federal_award fa WHERE fa.pe_code = p.pe_code)
              OR EXISTS (SELECT 1 FROM congress_bill b WHERE p.pe_code = ANY(b.pe_codes))
              OR EXISTS (SELECT 1 FROM program_element_watch w WHERE w.pe_code = p.pe_code)
              OR EXISTS (SELECT 1 FROM client_capabilities cc WHERE cc.pe_number = p.pe_code)
              OR EXISTS (SELECT 1 FROM program_element_source s WHERE s.pe_code = p.pe_code)
              OR EXISTS (SELECT 1 FROM program_element_project pr WHERE pr.pe_code = p.pe_code)
              OR EXISTS (
                SELECT 1 FROM acquisition_personnel ap
                WHERE ap.superseded_at IS NULL
                  AND (ap.pe_primary = p.pe_code OR p.pe_code = ANY(ap.pe_secondary))
              )
            ) AS has_signal
          FROM old_pes p
        )
        SELECT
          COUNT(*)::int AS "oldActive",
          COUNT(*) FILTER (WHERE has_signal)::int AS "keepRealButUncovered",
          COUNT(*) FILTER (WHERE NOT has_signal)::int AS "wouldRetire"
        FROM scored
      `);
      const totals = await prisma.$queryRaw<
        Array<{ total: number; alreadyRetired: number }>
      >(Prisma.sql`
        SELECT COUNT(*)::int AS "total",
               COUNT(*) FILTER (WHERE retired_at IS NOT NULL)::int AS "alreadyRetired"
        FROM program_element
      `);
      return { ...totals[0], ...rows[0] };
    });

    const links = await section('links', async () => {
      const rows = await prisma.$queryRaw<
        Array<{
          withPrimary: number;
          primaryNonAuthoritative: number;
          primaryNonAuthoritativeTrusted: number;
        }>
      >(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE ap.pe_primary IS NOT NULL)::int AS "withPrimary",
          COUNT(*) FILTER (
            WHERE ap.pe_primary IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM program_element pe
                WHERE pe.pe_code = ap.pe_primary AND pe.retired_at IS NULL
              )
          )::int AS "primaryNonAuthoritative",
          COUNT(*) FILTER (
            WHERE ap.pe_primary IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM program_element pe
                WHERE pe.pe_code = ap.pe_primary AND pe.retired_at IS NULL
              )
              AND EXISTS (
                SELECT 1 FROM acquisition_personnel_source s
                WHERE s.person_id = ap.id AND s.source = 'pe_match_confirmed'
              )
          )::int AS "primaryNonAuthoritativeTrusted"
        FROM acquisition_personnel ap
        WHERE ap.superseded_at IS NULL
      `);
      return rows[0];
    });

    console.log(
      'STALE_REPORT ' +
        JSON.stringify(
          { generatedAt: new Date().toISOString(), personnel, programElements, links },
          null,
          2,
        ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((err) => {
  console.error('[diag-stale-directory] FAILED', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
}
