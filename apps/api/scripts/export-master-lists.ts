/**
 * export-master-lists.ts — regenerate the master program/people lists FROM PROD
 * (the old pe_lists_export CSVs were generated from stale local artifacts).
 * Read-only. Emits three CSVs to stdout between BEGIN/END markers (retrievable
 * from CloudWatch when run as a one-off ECS task) plus a JSON summary:
 *   - program_elements.csv   appropriationType RDTE (7-digit PE codes)
 *   - procurement_lines.csv  appropriationType PROC (BLIN / namespaced keys)
 *   - om_lines.csv           appropriationType OM  (<account><line> keys)
 * Split keyspaces per the data-completion plan — PE codes and BLINs never mix.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        pe_code: string;
        title: string | null;
        appropriation_type: string | null;
        service: string | null;
        budget_activity: string | null;
        source: string | null;
        fy27_request: number | null;
        fy27_hasc: number | null;
        fy27_sasc: number | null;
        fy27_hacd: number | null;
      }>
    >(`
      SELECT pe.pe_code, pe.title, pe.appropriation_type, pe.service, pe.budget_activity,
             pe.source,
             y.request::float8 AS fy27_request, y.hasc_mark::float8 AS fy27_hasc,
             y.sasc_mark::float8 AS fy27_sasc, y.hac_d_mark::float8 AS fy27_hacd
      FROM program_element pe
      LEFT JOIN program_element_year y ON y.pe_code = pe.pe_code AND y.fy = 2027
      WHERE pe.retired_at IS NULL
      ORDER BY pe.pe_code
    `);

    const buckets: Record<string, typeof rows> = { RDTE: [], PROC: [], OM: [], OTHER: [] };
    for (const r of rows) {
      const t = (r.appropriation_type ?? '').toUpperCase();
      const bucket =
        t === 'PROC' ? 'PROC' : t === 'OM' ? 'OM' : /^[0-9]{7}[A-Z]/.test(r.pe_code) ? 'RDTE' : 'OTHER';
      buckets[bucket].push(r);
    }

    const header =
      'peCode,title,service,budgetActivity,source,fy2027Request,fy2027HascMark,fy2027SascMark,fy2027HacDMark';
    const emit = (name: string, data: typeof rows) => {
      console.log(`===== BEGIN ${name} (${data.length} rows) =====`);
      console.log(header);
      for (const r of data) {
        console.log(
          [
            r.pe_code, r.title, r.service, r.budget_activity, r.source,
            r.fy27_request, r.fy27_hasc, r.fy27_sasc, r.fy27_hacd,
          ]
            .map(csvCell)
            .join(','),
        );
      }
      console.log(`===== END ${name} =====`);
    };
    emit('program_elements.csv', buckets.RDTE);
    emit('procurement_lines.csv', buckets.PROC);
    emit('om_lines.csv', buckets.OM);

    console.log(
      JSON.stringify(
        {
          totals: {
            rdte: buckets.RDTE.length,
            procurement: buckets.PROC.length,
            om: buckets.OM.length,
            other: buckets.OTHER.length,
            otherSamples: buckets.OTHER.slice(0, 10).map((r) => r.pe_code),
          },
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
  console.error(err);
  process.exit(1);
});
