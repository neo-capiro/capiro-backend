/**
 * diag-pe.ts — read-only per-Program-Element data-presence report. Answers
 * "why is PE X thin on the 360 view?" by counting what exists in each backing
 * table for one PE. Run as a one-off ECS task; prints one JSON document.
 *
 *   tsx scripts/diag-pe.ts --pe=0604115A
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  // PE codes are alphanumeric; sanitize hard since we interpolate into raw SQL.
  const pe = (arg('pe') ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (!pe) throw new Error('usage: diag-pe --pe=0604115A');

  const prisma = new PrismaClient();
  await prisma.$connect();
  const q = async (sql: string): Promise<unknown> => {
    try {
      const r = (await prisma.$queryRawUnsafe(sql)) as Array<Record<string, unknown>>;
      const first = r[0];
      return r.length === 1 && first && 'n' in first ? Number(first.n) : r.map((x) => ({ ...x }));
    } catch (e) {
      return 'ERR:' + (e instanceof Error ? e.message.slice(0, 100) : String(e));
    }
  };
  const P = `'${pe}'`;
  try {
    const out = {
      pe,
      base: await q(
        `SELECT title, service, appropriation_type AS appro, budget_activity AS ba, status,
                retired_at IS NOT NULL AS retired, length(coalesce(description,'')) AS desc_len,
                last_synced_at
         FROM program_element WHERE upper(pe_code) = ${P}`,
      ),
      // The funding chart reads these; flat "+0.0M delta" means enacted≈request or one side null.
      // ndaa_conf = NDAA (authorization) conference; `conf` is the reserved appropriations
      // rung (currently unpopulated) — the NDAA value lives in ndaa_conference post-split.
      years: await q(
        `SELECT fy, request, enacted, hasc_mark AS hasc, sasc_mark AS sasc, hac_d_mark AS hacd,
                sac_d_mark AS sacd, ndaa_conference AS ndaa_conf, conference AS conf
         FROM program_element_year WHERE upper(pe_code) = ${P} ORDER BY fy`,
      ),
      budgetActions: await q(
        `SELECT count(*)::int n FROM budget_action WHERE upper(pe_code) = ${P}`,
      ),
      deltasLive: await q(
        `SELECT count(*)::int n FROM program_element_delta WHERE upper(pe_code) = ${P} AND superseded_at IS NULL`,
      ),
      billLinks: await q(
        `SELECT status, count(*)::int n FROM bill_budget_line_link WHERE upper(pe_code) = ${P} GROUP BY 1`,
      ),
      awards: await q(`SELECT count(*)::int n FROM federal_award WHERE upper(pe_code) = ${P}`),
      performers: await q(
        `SELECT is_named_company AS named, count(*)::int n FROM program_element_performer WHERE upper(pe_code) = ${P} GROUP BY 1`,
      ),
      peoplePrimary: await q(
        `SELECT count(*)::int n FROM acquisition_personnel WHERE upper(pe_primary) = ${P} AND superseded_at IS NULL`,
      ),
      peopleSecondary: await q(
        `SELECT count(*)::int n FROM acquisition_personnel WHERE ${P} = ANY(SELECT upper(x) FROM unnest(pe_secondary) x) AND superseded_at IS NULL`,
      ),
      personCandidates: await q(
        `SELECT status, count(*)::int n FROM program_element_person_candidate WHERE upper(pe_code) = ${P} GROUP BY 1`,
      ),
      relationships: await q(
        `SELECT count(*)::int n FROM budget_line_relationship WHERE upper(from_pe_code) = ${P} OR upper(to_pe_code) = ${P}`,
      ),
      programMatches: await q(
        `SELECT status, count(*)::int n FROM pe_program_match WHERE upper(pe_code) = ${P} GROUP BY 1`,
      ),
      intelCache: await q(
        `SELECT count(*)::int n FROM program_element_intelligence_cache WHERE upper(pe_code) = ${P}`,
      ),
      provisionLinks: await q(
        `SELECT count(*)::int n FROM provision_pe_link WHERE upper(pe_code) = ${P}`,
      ),
      samMatches: await q(
        `SELECT count(*)::int n FROM sam_opportunity_match WHERE upper(pe_code) = ${P}`,
      ),
      sources: await q(
        `SELECT count(*)::int n FROM program_element_source WHERE upper(pe_code) = ${P}`,
      ),
      projects: await q(
        `SELECT count(*)::int n FROM program_element_project WHERE upper(pe_code) = ${P}`,
      ),
    };
    console.log('DIAG_PE ' + JSON.stringify(out, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = /diag-pe(\.[cm]?[tj]s)?$/.test((process.argv[1] ?? '').replace(/\\/g, '/'));
if (isDirectRun) {
  void main().catch((err) => {
    console.error('[diag-pe] FAILED', err);
    process.exit(1);
  });
}

export { main };
