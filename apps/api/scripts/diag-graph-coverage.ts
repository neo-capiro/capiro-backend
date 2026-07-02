/**
 * diag-graph-coverage.ts — read-only baseline for the programs/people data-completion
 * plan: how much of the org/program/person graph is populated, by table + status.
 * Run as a one-off ECS task; prints one JSON document.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();
  const q = async (sql: string): Promise<unknown> => {
    try {
      const r = (await prisma.$queryRawUnsafe(sql)) as Array<Record<string, unknown>>;
      return r.length === 1 && 'n' in (r[0] ?? {}) ? Number(r[0].n) : r.map((x) => ({ ...x }));
    } catch (e) {
      return 'ERR:' + (e instanceof Error ? e.message.slice(0, 80) : String(e));
    }
  };
  try {
    const out = {
      programElements: {
        byAppropriationType: await q(
          `SELECT COALESCE(appropriation_type,'(null)') t, count(*)::int n FROM program_element WHERE retired_at IS NULL GROUP BY 1 ORDER BY 2 DESC`,
        ),
        withDescription: await q(
          `SELECT count(*)::int n FROM program_element WHERE description IS NOT NULL AND length(description) > 40`,
        ),
      },
      personnel: {
        total: await q(`SELECT count(*)::int n FROM acquisition_personnel`),
        active: await q(
          `SELECT count(*)::int n FROM acquisition_personnel WHERE superseded_at IS NULL AND status = 'active'`,
        ),
        superseded: await q(
          `SELECT count(*)::int n FROM acquisition_personnel WHERE superseded_at IS NOT NULL`,
        ),
        withPePrimary: await q(
          `SELECT count(*)::int n FROM acquisition_personnel WHERE pe_primary IS NOT NULL`,
        ),
      },
      orgGraph: {
        programOffices: await q(`SELECT count(*)::int n FROM program_office`),
        officesWithParent: await q(
          `SELECT count(*)::int n FROM program_office WHERE parent_office_id IS NOT NULL`,
        ),
        personRolesByStatus: await q(
          `SELECT review_status, count(*)::int n FROM person_role GROUP BY 1 ORDER BY 2 DESC`,
        ),
        officeProgramLinks: await q(`SELECT count(*)::int n FROM program_office_program_link`),
      },
      programs: {
        programs: await q(`SELECT count(*)::int n FROM program`),
        aliases: await q(`SELECT count(*)::int n FROM program_alias`),
        peMatchesByStatus: await q(
          `SELECT status, count(*)::int n FROM pe_program_match GROUP BY 1 ORDER BY 2 DESC`,
        ),
        mdapMapEntries: await q(
          `SELECT count(*)::int n FROM program_element_acquisition_program`,
        ),
      },
      personPeCandidates: await q(
        `SELECT status, count(*)::int n FROM program_element_person_candidate GROUP BY 1 ORDER BY 2 DESC`,
      ),
      awards: {
        withPeCode: await q(`SELECT count(*)::int n FROM federal_award WHERE pe_code IS NOT NULL`),
        total: await q(`SELECT count(*)::int n FROM federal_award`),
      },
    };
    console.log('GRAPH_COVERAGE ' + JSON.stringify(out, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((e) => {
  console.error('GRAPH_COVERAGE_ERR ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
