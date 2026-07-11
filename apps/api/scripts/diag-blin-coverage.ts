/**
 * diag-blin-coverage.ts — read-only coverage matrix for program-line network links,
 * broken down by appropriation type (RDT&E / PROC / OM). Answers "how many lines of
 * each type are reachable from bills, committee-report provisions, SAM opportunities,
 * and USAspending awards" — the before/after yield measurement for the procurement-BLIN
 * matching remediation (plan §5 success metrics). SAFE: COUNT/DISTINCT reads only.
 *
 *   diag-blin-coverage            (verb: diag-blin-coverage)
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();
  const rows = async (sql: string): Promise<Array<Record<string, unknown>>> => {
    try {
      return (await prisma.$queryRawUnsafe(sql)) as Array<Record<string, unknown>>;
    } catch (e) {
      return [{ ERR: e instanceof Error ? e.message.slice(0, 120) : String(e) }];
    }
  };
  const scalar = async (sql: string): Promise<number | string> => {
    const r = await rows(sql);
    const first = r[0];
    if (first && 'ERR' in first) return String(first.ERR);
    return Number((first as { n?: unknown } | undefined)?.n ?? 0);
  };

  // Distinct-PE coverage per appropriation type for a given link table, as a map
  // { 'RDT&E': n, 'PROC': n, 'OM': n }. Non-retired program elements only.
  const coverageByType = (
    linkTable: string,
    joinCol = 'pe_code',
  ): Promise<Array<Record<string, unknown>>> =>
    rows(
      `SELECT COALESCE(p.appropriation_type,'(null)') AS appro,
              count(DISTINCT p.pe_code)::int AS covered
       FROM program_element p
       JOIN ${linkTable} l ON upper(l.${joinCol}) = upper(p.pe_code)
       WHERE p.retired_at IS NULL
       GROUP BY 1 ORDER BY 1`,
    );

  const out = {
    generatedAt: new Date().toISOString(),
    // Denominator: non-retired lines by appropriation type.
    linesByType: await rows(
      `SELECT COALESCE(appropriation_type,'(null)') AS appro, count(*)::int AS total
       FROM program_element WHERE retired_at IS NULL GROUP BY 1 ORDER BY 1`,
    ),
    // Distinct lines of each type reachable from each network source.
    billLinkedPesByType: await coverageByType('bill_budget_line_link'),
    provisionLinkedPesByType: await coverageByType('provision_pe_link'),
    samMatchedPesByType: await coverageByType('sam_opportunity_match'),
    awardLinkedPesByType: await coverageByType('federal_award'),
    // Raw link-row totals (measures backfill WRITES, not distinct-PE coverage).
    totalLinkRows: {
      billBudgetLineLink: await scalar(`SELECT count(*)::int n FROM bill_budget_line_link`),
      provisionPeLink: await scalar(`SELECT count(*)::int n FROM provision_pe_link`),
      samOpportunityMatch: await scalar(`SELECT count(*)::int n FROM sam_opportunity_match`),
      federalAwardWithPe: await scalar(
        `SELECT count(*)::int n FROM federal_award WHERE pe_code IS NOT NULL`,
      ),
    },
    // BLIN-specific: how many PROC lines are cited verbatim in any bill / provision
    // (the exact thing the procurement-BLIN matcher fix unlocked).
    procLinesWithBillLink: await scalar(
      `SELECT count(DISTINCT p.pe_code)::int n
       FROM program_element p
       JOIN bill_budget_line_link l ON upper(l.pe_code) = upper(p.pe_code)
       WHERE p.retired_at IS NULL AND p.appropriation_type = 'PROC'`,
    ),
    procLinesWithProvisionLink: await scalar(
      `SELECT count(DISTINCT p.pe_code)::int n
       FROM program_element p
       JOIN provision_pe_link l ON upper(l.pe_code) = upper(p.pe_code)
       WHERE p.retired_at IS NULL AND p.appropriation_type = 'PROC'`,
    ),
    procLinesWithSamMatch: await scalar(
      `SELECT count(DISTINCT p.pe_code)::int n
       FROM program_element p
       JOIN sam_opportunity_match l ON upper(l.pe_code) = upper(p.pe_code)
       WHERE p.retired_at IS NULL AND p.appropriation_type = 'PROC'`,
    ),
  };

  console.log('BLIN_COVERAGE ' + JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('BLIN_COVERAGE_ERR', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
