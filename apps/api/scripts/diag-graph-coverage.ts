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
      const first = r[0];
      return r.length === 1 && first && 'n' in first ? Number(first.n) : r.map((x) => ({ ...x }));
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
        // Batch-9 driver: which lines still lack a narrative, by appropriation+service.
        undescribedByType: await q(
          `SELECT COALESCE(appropriation_type,'(null)') t, COALESCE(service,'(null)') s, count(*)::int n
           FROM program_element
           WHERE retired_at IS NULL AND (description IS NULL OR length(description) <= 40)
           GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12`,
        ),
        undescribedRdteSamples: await q(
          `SELECT pe_code || ' ' || COALESCE(left(title, 40), '') AS x, 0::int AS n
           FROM program_element
           WHERE retired_at IS NULL AND appropriation_type = 'RDT&E'
             AND (description IS NULL OR length(description) <= 40)
           ORDER BY pe_code LIMIT 20`,
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
        // Full-email capture (admin-gated on read). emailDomain is the domain-only field.
        withEmail: await q(`SELECT count(*)::int n FROM acquisition_personnel WHERE email IS NOT NULL`),
        withEmailDomain: await q(
          `SELECT count(*)::int n FROM acquisition_personnel WHERE email_domain IS NOT NULL`,
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
      // Coverage the People & office tab actually surfaces. pePrimary = the legacy
      // direct link; chain = the role->program->PE selection added 2026-07-04
      // (accepted PeProgramMatch, +accepted ProgramOfficeProgramLink for office roles).
      roleChainReach: {
        pesViaPePrimary: await q(
          `SELECT count(DISTINCT pe_primary)::int n FROM acquisition_personnel WHERE pe_primary IS NOT NULL AND superseded_at IS NULL`,
        ),
        peopleViaChain: await q(
          `SELECT count(DISTINCT ap.id)::int n
             FROM acquisition_personnel ap
             JOIN person_role pr ON pr.person_id = ap.id AND pr.review_status <> 'quarantined'
            WHERE ap.superseded_at IS NULL AND (
              EXISTS (SELECT 1 FROM pe_program_match m WHERE m.program_id = pr.program_id AND m.status = 'accepted')
              OR EXISTS (
                SELECT 1 FROM program_office_program_link l
                  JOIN pe_program_match m2 ON m2.program_id = l.program_id AND m2.status = 'accepted'
                 WHERE l.office_id = pr.office_id AND l.review_status = 'accepted'))`,
        ),
        pesWithChainPeople: await q(
          `SELECT count(DISTINCT pe)::int n FROM (
             SELECT m.pe_code AS pe
               FROM person_role pr
               JOIN acquisition_personnel ap ON ap.id = pr.person_id AND ap.superseded_at IS NULL
               JOIN pe_program_match m ON m.program_id = pr.program_id AND m.status = 'accepted'
              WHERE pr.review_status <> 'quarantined'
             UNION
             SELECT m2.pe_code AS pe
               FROM person_role pr
               JOIN acquisition_personnel ap ON ap.id = pr.person_id AND ap.superseded_at IS NULL
               JOIN program_office_program_link l ON l.office_id = pr.office_id AND l.review_status = 'accepted'
               JOIN pe_program_match m2 ON m2.program_id = l.program_id AND m2.status = 'accepted'
              WHERE pr.review_status <> 'quarantined') t`,
        ),
      },
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
