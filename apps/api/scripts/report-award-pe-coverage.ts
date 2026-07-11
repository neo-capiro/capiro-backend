/**
 * report-award-pe-coverage.ts — READ-ONLY diagnostic.
 *
 *   tsx scripts/report-award-pe-coverage.ts
 *
 * Prints federal_award PE/acquisition-program coverage as JSON so we can state
 * the contractor-panel coverage HONESTLY without direct Aurora access (the API
 * container entrypoint rejects ad-hoc SQL, so this verb is the supported way to
 * query live). Writes nothing.
 *
 * Output: total awards, how many carry a DoD acquisition program code, how many
 * have a resolved pe_code (broken down by pe_code_source), how many distinct PEs
 * are reachable through the curated acq-program map, and the top program codes by
 * award count among awards still lacking a PE (so we know which programs to add
 * to the map next for the biggest coverage win).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';

dotenvConfig();

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const [total, withAcqCode, withPe] = await Promise.all([
      prisma.federalAward.count(),
      prisma.federalAward.count({ where: { dodAcqProgramCode: { not: null } } }),
      prisma.federalAward.count({ where: { peCode: { not: null } } }),
    ]);

    const bySource = await prisma.$queryRaw<Array<{ source: string | null; n: number }>>(Prisma.sql`
      SELECT pe_code_source AS source, COUNT(*)::int AS n
      FROM federal_award
      WHERE pe_code IS NOT NULL
      GROUP BY pe_code_source
      ORDER BY n DESC
    `);

    const mapEntries = await prisma.programElementAcquisitionProgram.count();
    const distinctMappedPes = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT pe_code)::int AS n FROM program_element_acquisition_program
    `);

    // Top program codes among awards that have an acq code but NO resolved PE —
    // these are the highest-leverage additions to the curated map.
    const unmappedTopPrograms = await prisma.$queryRaw<
      Array<{ code: string; name: string | null; awards: number }>
    >(Prisma.sql`
      SELECT
        fa.dod_acq_program_code AS code,
        MAX(fa.dod_acq_program_name) AS name,
        COUNT(*)::int AS awards
      FROM federal_award fa
      LEFT JOIN program_element_acquisition_program m
        ON m.acq_program_code = fa.dod_acq_program_code
      WHERE fa.dod_acq_program_code IS NOT NULL
        AND fa.dod_acq_program_code NOT IN ('000', 'NONE', '')
        AND m.acq_program_code IS NULL
      GROUP BY fa.dod_acq_program_code
      ORDER BY awards DESC
      LIMIT 20
    `);

    // Per mapped PE: how many contractors getContractors() would return, both in
    // the live 24-month window (what the panel actually shows) AND all-time. If
    // windowed=0 but allTime>0, the awards are simply older than 24 months — the
    // panel is empty for a real (data-age) reason, not a linkage bug. Mirrors the
    // getContractors query: match by direct pe_code OR linked acq program code.
    const perPe = await prisma.$queryRaw<
      Array<{
        peCode: string;
        contractors24mo: number;
        contractorsAllTime: number;
        latestAward: Date | null;
      }>
    >(Prisma.sql`
      WITH mapped AS (
        SELECT DISTINCT pe_code, acq_program_code FROM program_element_acquisition_program
      ),
      awards AS (
        SELECT DISTINCT ON (fa.id) fa.id, m.pe_code, fa.contractor_name, fa.action_date, fa.awarded_at
        FROM mapped m
        JOIN federal_award fa
          ON (fa.pe_code = m.pe_code OR fa.dod_acq_program_code = m.acq_program_code)
        WHERE fa.contractor_name IS NOT NULL
      )
      SELECT
        pe_code AS "peCode",
        COUNT(DISTINCT CASE
          WHEN COALESCE(action_date, awarded_at::date) >= (NOW() - INTERVAL '24 months')::date
          THEN contractor_name END)::int AS "contractors24mo",
        COUNT(DISTINCT contractor_name)::int AS "contractorsAllTime",
        MAX(COALESCE(action_date, awarded_at::date)) AS "latestAward"
      FROM awards
      GROUP BY pe_code
      ORDER BY "contractors24mo" DESC, "contractorsAllTime" DESC
    `);

    const working = perPe.filter((p) => p.contractors24mo > 0);
    const emptyButHasOlder = perPe.filter(
      (p) => p.contractors24mo === 0 && p.contractorsAllTime > 0,
    );

    // FY-history depth: how many program_element_year rows each PE has. Tells us
    // whether the "timeline shows only 1 year" is a data-ingestion reality (only
    // one FY row exists) vs a render bug (read path always returns all years).
    const yearDepth = await prisma.$queryRaw<
      Array<{ yearsPerPe: number; peCount: number }>
    >(Prisma.sql`
      SELECT yc AS "yearsPerPe", COUNT(*)::int AS "peCount"
      FROM (
        SELECT pe_code, COUNT(*)::int AS yc
        FROM program_element_year
        GROUP BY pe_code
      ) t
      GROUP BY yc
      ORDER BY yc
    `);
    const distinctFys = await prisma.$queryRaw<Array<{ fy: number; rows: number }>>(Prisma.sql`
      SELECT fy, COUNT(*)::int AS rows FROM program_element_year GROUP BY fy ORDER BY fy
    `);
    const pesWithAnyYear = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT pe_code)::int AS n FROM program_element_year
    `);

    // Team (acquisition-personnel) presence: how many PEs have at least one linked
    // person (pe_primary or in pe_secondary).
    const pesWithTeam = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT pe)::int AS n FROM (
        SELECT pe_primary AS pe FROM acquisition_personnel WHERE pe_primary IS NOT NULL
        UNION
        SELECT UNNEST(pe_secondary) AS pe FROM acquisition_personnel
      ) t
    `);

    // Per-FY request/enacted VALUES for a few marquee PEs — to see whether the
    // timeline's "non-budget" years are zero/null (data reality: only the budget
    // year carries dollars) vs genuinely populated. Answers the "graph only shows
    // one year" question with the actual numbers the chart receives.
    const sampleYearValues = await prisma.$queryRaw<
      Array<{
        peCode: string;
        fy: number;
        request: number | null;
        enacted: number | null;
        conference: number | null;
      }>
    >(Prisma.sql`
      SELECT pe_code AS "peCode", fy,
             request::float8 AS request,
             enacted::float8 AS enacted,
             ndaa_conference::float8 AS conference
      FROM program_element_year
      WHERE pe_code IN ('0204202N','0401132F','0207138F','0101224N')
      ORDER BY pe_code, fy
    `);
    const singleValueDespiteMultiYear = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM (
        SELECT pe_code,
               COUNT(*) AS year_rows,
               COUNT(*) FILTER (WHERE request IS NOT NULL AND request <> 0) AS nonzero_request_years
        FROM program_element_year
        GROUP BY pe_code
      ) t
      WHERE year_rows > 1 AND nonzero_request_years <= 1
    `);

    console.log(
      JSON.stringify(
        {
          total,
          withAcqProgramCode: withAcqCode,
          withResolvedPeCode: withPe,
          peCodeBySource: bySource,
          curatedMapEntries: mapEntries,
          distinctMappedPeCodes: distinctMappedPes[0]?.n ?? 0,
          // PANEL DIAGNOSTIC:
          panelWorkingPeCount: working.length,
          panelWorkingPes: working.slice(0, 15),
          panelEmptyDueToAgePeCount: emptyButHasOlder.length,
          panelEmptyDueToAgeSample: emptyButHasOlder.slice(0, 10),
          // FY-HISTORY DIAGNOSTIC:
          totalProgramElements: await prisma.programElement.count(),
          pesWithAnyYearRow: pesWithAnyYear[0]?.n ?? 0,
          fyRowsPerPeDistribution: yearDepth,
          distinctFiscalYears: distinctFys,
          // TIMELINE VALUE DIAGNOSTIC:
          sampleYearValues,
          pesMultiYearButSingleValue: singleValueDespiteMultiYear[0]?.n ?? 0,
          // COVERAGE DIAGNOSTIC:
          pesWithTeam: pesWithTeam[0]?.n ?? 0,
          topUnmappedProgramsByAwardCount: unmappedTopPrograms,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error('[report-award-pe-coverage] FAILED', err);
  process.exit(1);
});
