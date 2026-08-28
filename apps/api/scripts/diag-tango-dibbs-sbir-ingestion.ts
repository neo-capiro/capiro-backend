/**
 * Read-only ingestion-completeness report for the DIBBS and SBIR/STTR rails
 * (P40/P42).
 *
 *   tsx scripts/diag-tango-dibbs-sbir-ingestion.ts
 *   tsx scripts/diag-tango-dibbs-sbir-ingestion.ts --json
 *
 * ── SELECT-ONLY. No writes, no provider call, no key required ────────────────
 *
 * Neither sync keeps a `tango_sync_checkpoint` row (deliberate, not a gap):
 * that table's `resource_type` CHECK was never widened to admit a DIBBS or
 * SBIR value (decision-log D-63/D-68), and both endpoints publish no
 * `modified_after` filter anyway, so a checkpoint would be the wrong
 * abstraction even if it were storable. The only honest completeness signal
 * is therefore the row counts and date bounds actually on disk — this script
 * reports exactly those, and nothing it cannot support with a query.
 *
 * This does NOT know the true size of either provider catalog (that would
 * require calling Tango, which this script deliberately never does) — read
 * the counts alongside whatever the most recent live probe/full-sync run
 * reported as the catalog size, not as a percentage this script invents.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

export interface ParsedArgs {
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  return { json: argv.includes('--json') };
}

export type Measured = number | string | null | { failed: string };

export interface Measurement {
  section: string;
  label: string;
  value: Measured;
  note?: string;
}

export interface IngestionReport {
  generatedAt: string;
  measurements: Measurement[];
}

export function failure(e: unknown): { failed: string } {
  const raw = e instanceof Error ? e.message : String(e);
  return { failed: raw.replace(/\s+/g, ' ').trim().slice(0, 120) };
}

async function safeCount(prisma: PrismaClient, sql: string): Promise<Measured> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(sql);
    const n = rows[0]?.n;
    return n === undefined ? failure('count returned no row') : Number(n);
  } catch (e) {
    return failure(e);
  }
}

async function safeValue(prisma: PrismaClient, sql: string): Promise<Measured> {
  try {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql);
    const first = rows[0];
    if (!first) return null;
    const v = Object.values(first)[0];
    return v === null || v === undefined ? null : String(v);
  } catch (e) {
    return failure(e);
  }
}

export async function buildReport(prisma: PrismaClient): Promise<IngestionReport> {
  const m: Measurement[] = [];

  m.push({
    section: 'DIBBS (P40) — row counts',
    label: 'RFQ solicitations',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_dibbs_solicitation" WHERE "document_type" = 'rfq'`,
    ),
  });
  m.push({
    section: 'DIBBS (P40) — row counts',
    label: 'RFP solicitations',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_dibbs_solicitation" WHERE "document_type" = 'rfp'`,
    ),
  });
  m.push({
    section: 'DIBBS (P40) — row counts',
    label: 'Awards',
    value: await safeCount(prisma, `SELECT count(*) AS n FROM "tango_dibbs_award"`),
  });
  m.push({
    section: 'DIBBS (P40) — freshness',
    label: 'oldest solicitation issued_date on file',
    value: await safeValue(
      prisma,
      `SELECT min("issued_date")::text AS v FROM "tango_dibbs_solicitation"`,
    ),
    note: 'The sync window is issue-date-anchored (D-63) — an old min here alongside a recent max is expected, not a gap. Normalized: RFQ states issue_date, RFP states issued_date, both land in this one column.',
  });
  m.push({
    section: 'DIBBS (P40) — freshness',
    label: 'newest solicitation issued_date on file',
    value: await safeValue(
      prisma,
      `SELECT max("issued_date")::text AS v FROM "tango_dibbs_solicitation"`,
    ),
  });

  m.push({
    section: 'SBIR/STTR (P42) — row counts',
    label: 'Topics',
    value: await safeCount(prisma, `SELECT count(*) AS n FROM "tango_sbir_topic"`),
  });
  m.push({
    section: 'SBIR/STTR (P42) — row counts',
    label: 'Solicitation cycles',
    value: await safeCount(prisma, `SELECT count(*) AS n FROM "tango_sbir_solicitation"`),
  });
  m.push({
    section: 'SBIR/STTR (P42) — freshness',
    label: 'newest topic release_date on file',
    value: await safeValue(prisma, `SELECT max("release_date")::text AS v FROM "tango_sbir_topic"`),
  });
  m.push({
    section: 'SBIR/STTR (P42) — freshness',
    label: 'newest cycle start_date on file',
    value: await safeValue(prisma, `SELECT max("start_date")::text AS v FROM "tango_sbir_solicitation"`),
  });

  m.push({
    section: 'Checkpoint table (informational)',
    label: 'rows naming a dibbs/sbir resource_type',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_sync_checkpoint" WHERE "resource_type" ILIKE '%dibbs%' OR "resource_type" ILIKE '%sbir%'`,
    ),
    note: 'Expected to be 0 — neither sync can store one; see the header comment.',
  });

  return { generatedAt: new Date().toISOString(), measurements: m };
}

export function renderReport(report: IngestionReport): string[] {
  const lines: string[] = [
    `Tango DIBBS/SBIR ingestion diagnostic`,
    `generated: ${report.generatedAt}`,
    '',
  ];
  let current = '';
  for (const m of report.measurements) {
    if (m.section !== current) {
      current = m.section;
      lines.push(`── ${current} ${'─'.repeat(Math.max(0, 60 - current.length))}`);
    }
    const value =
      m.value === null
        ? '—'
        : typeof m.value === 'object' && 'failed' in m.value
          ? `QUERY FAILED — ${m.value.failed}`
          : String(m.value);
    lines.push(`  ${m.label.padEnd(46)} ${value}`);
    if (m.note) lines.push(`      ${m.note}`);
  }
  lines.push(
    '',
    'This report has no way to know the true size of either provider catalog —',
    'compare these counts against the most recent live capability/full-sync run,',
    'never against a percentage this script would have to invent.',
  );
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const report = await buildReport(prisma);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of renderReport(report)) console.log(line);
    }
  } finally {
    await prisma.$disconnect();
  }
}

const invoked = process.argv[1] ?? '';
if (invoked.includes('diag-tango-dibbs-sbir-ingestion')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'Unknown failure');
    process.exitCode = 1;
  });
}
