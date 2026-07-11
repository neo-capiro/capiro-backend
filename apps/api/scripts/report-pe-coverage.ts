/**
 * Read-only PE mark-coverage report (the "did we extract everything?" answer).
 *
 *   pnpm --filter @capiro/api report:pe-coverage [-- --fy 2027] [--json]
 *   (ECS verb: report-pe-coverage)
 *
 * For every PE/FY, partitions each congressional mark (HASC/SASC/HAC-D/SAC-D/
 * conference/enacted) into mark_present / expected_blank / candidate_gap using the
 * pure classifier in src/program-element/coverage/pe-coverage.ts. candidate_gap =
 * an in-request, unclassified RDT&E PE in Armed-Services jurisdiction that LACKS
 * the mark — i.e. a row we plausibly should have extracted but didn't. Those are
 * the rows worth chasing; everything else is a legitimately-expected blank.
 *
 * SELECT-only. No writes. Tenant-agnostic reference data (global tables).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  MARK_FIELDS,
  classifyMissingMark,
  type CoverageMark,
  type PeYearFacts,
} from '../src/program-element/coverage/pe-coverage.js';

dotenvConfig();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface YearRow {
  pe_code: string;
  fy: number;
  request: number | null;
  hasc_mark: number | null;
  sasc_mark: number | null;
  hac_d_mark: number | null;
  sac_d_mark: number | null;
  ndaa_conference: number | null;
  enacted: number | null;
  appropriation_type: string | null;
  status: string | null;
  retired_at: Date | null;
}

const CHAMBER_MARKS: CoverageMark[] = [
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'ndaaConference',
  'enacted',
];

function buildDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  const enc = encodeURIComponent(process.env.DB_PASSWORD ?? '');
  process.env.DATABASE_URL = `postgresql://${process.env.DB_USER}:${enc}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}?schema=public&sslmode=require`;
}

async function main(): Promise<void> {
  buildDatabaseUrl();
  const fyFilter = arg('fy') ? Number(arg('fy')) : null;
  const asJson = process.argv.includes('--json');
  const prisma = new PrismaClient();

  try {
    const where = fyFilter ? `WHERE y.fy = ${Number(fyFilter)}` : '';
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT y.pe_code, y.fy,
              y.request, y.hasc_mark, y.sasc_mark, y.hac_d_mark, y.sac_d_mark, y.ndaa_conference, y.enacted,
              p.appropriation_type, p.status, p.retired_at
       FROM program_element_year y
       JOIN program_element p ON p.pe_code = y.pe_code
       ${where}`,
    )) as YearRow[];

    // per (fy, mark) -> counts
    type Bucket = { mark_present: number; expected_blank: number; candidate_gap: number };
    const byFy = new Map<number, Map<CoverageMark, Bucket>>();
    const gapSamples: Record<string, string[]> = {};

    const numOrNull = (v: unknown): boolean => v !== null && v !== undefined;

    for (const r of rows) {
      const facts: PeYearFacts = {
        peCode: r.pe_code,
        fy: r.fy,
        appropriationType: r.appropriation_type,
        status: r.status,
        retired: r.retired_at != null,
        present: {
          request: numOrNull(r.request),
          hascMark: numOrNull(r.hasc_mark),
          sascMark: numOrNull(r.sasc_mark),
          hacDMark: numOrNull(r.hac_d_mark),
          sacDMark: numOrNull(r.sac_d_mark),
          ndaaConference: numOrNull(r.ndaa_conference),
          enacted: numOrNull(r.enacted),
        },
      };
      if (!byFy.has(r.fy)) byFy.set(r.fy, new Map());
      const fyMap = byFy.get(r.fy)!;
      for (const mark of CHAMBER_MARKS) {
        if (!fyMap.has(mark))
          fyMap.set(mark, { mark_present: 0, expected_blank: 0, candidate_gap: 0 });
        const c = classifyMissingMark(facts, mark);
        fyMap.get(mark)![c.verdict] += 1;
        if (c.verdict === 'candidate_gap') {
          const key = `FY${r.fy}/${mark}`;
          gapSamples[key] ??= [];
          if (gapSamples[key]!.length < 15) gapSamples[key]!.push(r.pe_code);
        }
      }
    }

    const report: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      fyFilter,
      totalYearRows: rows.length,
      byFiscalYear: {},
      candidateGapSamples: gapSamples,
    };

    const fys = Array.from(byFy.keys()).sort((a, b) => a - b);
    for (const fy of fys) {
      const fyObj: Record<string, Bucket> = {};
      for (const mark of CHAMBER_MARKS) {
        fyObj[mark] = byFy.get(fy)!.get(mark) ?? {
          mark_present: 0,
          expected_blank: 0,
          candidate_gap: 0,
        };
      }
      (report.byFiscalYear as Record<string, unknown>)[fy] = fyObj;
    }

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `PE MARK COVERAGE REPORT  (${rows.length} PE/FY rows${fyFilter ? `, FY${fyFilter}` : ''})`,
      );
      console.log('verdicts: present / expected_blank / CANDIDATE_GAP\n');
      for (const fy of fys) {
        console.log(`FY${fy}`);
        for (const mark of CHAMBER_MARKS) {
          const b = byFy.get(fy)!.get(mark)!;
          const flag = b.candidate_gap > 0 ? '  <-- GAP' : '';
          console.log(
            `  ${mark.padEnd(12)} present=${String(b.mark_present).padStart(5)}  ` +
              `expected_blank=${String(b.expected_blank).padStart(5)}  ` +
              `candidate_gap=${String(b.candidate_gap).padStart(5)}${flag}`,
          );
        }
        console.log('');
      }
      const totalGap = fys.reduce(
        (s, fy) => s + CHAMBER_MARKS.reduce((t, m) => t + byFy.get(fy)!.get(m)!.candidate_gap, 0),
        0,
      );
      console.log(`TOTAL candidate_gap across all FYs/marks: ${totalGap}`);
      console.log(
        '(candidate_gap = in-request, unclassified RDT&E, in-jurisdiction PE lacking this mark)',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
