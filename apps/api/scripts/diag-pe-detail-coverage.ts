/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Read-only PE-detail data-coverage report. For one or more peCodes, counts the
 * rows behind every PE-detail panel so we can see — before building/wiring UI —
 * which panels have real data vs. are structurally empty vs. data-pending.
 *
 *   diag-pe-detail-coverage 8205G14510 0602785A ...
 *
 * No tenant scope needed: these tables are tenant-agnostic reference data.
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const usage = 'Usage: apps/api/scripts/diag-pe-detail-coverage.ts [pe-code ...] requires DATABASE_URL (database configuration is required)';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (args.some((arg) => arg.startsWith('--'))) {
    console.error(usage);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(usage);
    process.exit(2);
  }
  const codes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const targets = codes.length ? codes : ['8205G14510', '0602785A'];
  const prisma = new PrismaClient();
  try {
    const out: Record<string, unknown> = {};
    for (const pe of targets) {
      const q = async (sql: string): Promise<unknown> => {
        try {
          const r = (await prisma.$queryRawUnsafe(sql, pe)) as Array<Record<string, unknown>>;
          return r?.[0]?.n ?? null;
        } catch (e) {
          return 'ERR:' + (e instanceof Error ? e.message.slice(0, 60) : String(e));
        }
      };
      // PE base + type
      const base = (await prisma.$queryRawUnsafe(
        `SELECT pe_code, title, appropriation_type, service FROM program_element WHERE pe_code = $1`,
        pe,
      )) as Array<Record<string, unknown>>;
      out[pe] = {
        exists: base.length > 0,
        title: base[0]?.title ?? null,
        appropriationType: base[0]?.appropriation_type ?? null,
        service: base[0]?.service ?? null,
        years: await q(`SELECT count(*)::int n FROM program_element_year WHERE pe_code = $1`),
        procurementLines: await q(
          `SELECT count(*)::int n FROM program_element_procurement_line WHERE pe_code = $1`,
        ),
        procLinesWithQty: await q(
          `SELECT count(*)::int n FROM program_element_procurement_line WHERE pe_code = $1 AND quantity IS NOT NULL`,
        ),
        procLinesWithDollars: await q(
          `SELECT count(*)::int n FROM program_element_procurement_line WHERE pe_code = $1 AND dollars IS NOT NULL`,
        ),
        projects: await q(`SELECT count(*)::int n FROM program_element_project WHERE pe_code = $1`),
        deltas: await q(`SELECT count(*)::int n FROM program_element_delta WHERE pe_code = $1`),
        deltasByType: await (async () => {
          try {
            const r = (await prisma.$queryRawUnsafe(
              `SELECT delta_type, count(*)::int n FROM program_element_delta WHERE pe_code = $1 GROUP BY delta_type ORDER BY 2 DESC`,
              pe,
            )) as Array<Record<string, unknown>>;
            return r.map((x) => `${x.delta_type}:${x.n}`);
          } catch (e) {
            return 'ERR:' + (e instanceof Error ? e.message.slice(0, 60) : String(e));
          }
        })(),
        federalAwards: await q(`SELECT count(*)::int n FROM federal_award WHERE pe_code = $1`),
        provisionLinks: await q(`SELECT count(*)::int n FROM provision_pe_link WHERE pe_code = $1`),
        samOppMatches: await q(`SELECT count(*)::int n FROM sam_opportunity_match WHERE pe_code = $1`),
      };
    }
    // Global table totals for context.
    const tot = async (t: string): Promise<unknown> => {
      try {
        const r = (await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM ${t}`)) as Array<
          Record<string, unknown>
        >;
        return r?.[0]?.n ?? null;
      } catch (e) {
        return 'ERR:' + (e instanceof Error ? e.message.slice(0, 40) : String(e));
      }
    };
    out['_globals'] = {
      procurementLines: await tot('program_element_procurement_line'),
      procLinesWithQty: await (async () => tot(
        'program_element_procurement_line WHERE quantity IS NOT NULL',
      ))(),
      projects: await tot('program_element_project'),
      deltas: await tot('program_element_delta'),
      federalAwards: await tot('federal_award'),
      provisionLinks: await tot('provision_pe_link'),
      committeeProvisions: await tot('committee_report_provision'),
      samOppMatches: await tot('sam_opportunity_match'),
      procPEs: await tot(`program_element WHERE appropriation_type = 'PROC'`),
      rdtePEs: await tot(`program_element WHERE appropriation_type = 'RDTE'`),
    };
    console.log('PE_DETAIL_COVERAGE ' + JSON.stringify(out, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((e) => {
  console.error('PE_DETAIL_COVERAGE_ERR ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
}
