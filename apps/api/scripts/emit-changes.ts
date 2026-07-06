/**
 * Emit IntelligenceChange rows for tables that received new rows in the last 24 hours.
 *   pnpm --filter @capiro/api emit:changes
 * Run this after sync scripts complete to surface new data to the Changes Inbox.
 * Also writes a SyncRun row per execution for auditability (Strategy Report §4.1).
 */
import { config as dotenvConfig } from 'dotenv';
import { createHash } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
dotenvConfig();

const prisma = new PrismaClient();

interface TableDef {
  source: string;
  label: string; // human-readable plural label
  sqlTable: string; // actual postgres table name
  dateCol: string; // column used to detect new rows
  idCol: string; // column to pull for sample_ids
}

const TABLES: TableDef[] = [
  {
    source: 'sec_filing',
    label: 'SEC filings',
    sqlTable: 'sec_filing',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'congress_bill',
    label: 'Congress bills',
    sqlTable: 'congress_bill',
    dateCol: 'last_synced_at',
    idCol: 'id',
  },
  {
    source: 'federal_register_document',
    label: 'Federal Register documents',
    sqlTable: 'federal_register_document',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'federal_grant',
    label: 'Federal grants',
    sqlTable: 'federal_grant',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'gao_report',
    label: 'GAO reports',
    sqlTable: 'gao_report',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'intel_article',
    label: 'intelligence articles',
    sqlTable: 'intel_article',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'committee_hearing',
    label: 'committee hearings',
    sqlTable: 'committee_hearing',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'state_bill',
    label: 'state bills',
    sqlTable: 'state_bill',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'bls_series',
    label: 'BLS economic data series',
    sqlTable: 'bls_series',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'bea_data',
    label: 'BEA economic data points',
    sqlTable: 'bea_data',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'census_district',
    label: 'Census district records',
    sqlTable: 'census_district',
    dateCol: 'synced_at',
    idCol: 'id',
  },
  {
    source: 'fec_contribution',
    label: 'FEC contributions',
    sqlTable: 'fec_contribution',
    dateCol: 'last_synced_at',
    idCol: 'id',
  },
  {
    source: 'lda_filing',
    label: 'LDA filings',
    sqlTable: 'lda_filing',
    dateCol: 'last_synced_at',
    idCol: 'id',
  },
];

function severity(count: number): string {
  if (count > 1000) return 'critical';
  if (count > 100) return 'notable';
  return 'info';
}

async function queryNewRows(
  tbl: TableDef,
  since: Date,
): Promise<{ count: number; sampleIds: string[] }> {
  const countRows = await prisma.$queryRawUnsafe<Array<{ n: string }>>(
    `SELECT COUNT(*)::text AS n FROM ${tbl.sqlTable} WHERE ${tbl.dateCol} > $1`,
    since,
  );
  const count = parseInt(countRows[0]?.n ?? '0', 10);
  if (count === 0) return { count: 0, sampleIds: [] };

  const sampleRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT ${tbl.idCol}::text AS id FROM ${tbl.sqlTable} WHERE ${tbl.dateCol} > $1 LIMIT 5`,
    since,
  );
  return { count, sampleIds: sampleRows.map((r) => r.id) };
}

async function main() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const startedAt = new Date();
  console.log(`[emit-changes] checking for new rows since ${since.toISOString()}`);

  const syncRun = await prisma.syncRun.create({
    data: { source: 'emit-changes', startedAt },
  });

  let emitted = 0;
  let errorCount = 0;

  for (const tbl of TABLES) {
    try {
      const { count, sampleIds } = await queryNewRows(tbl, since);
      if (count === 0) continue;

      // Idempotency (P1-T4): a same-window re-run must not double-emit. The key
      // is source + UTC-day bucket + a signature of the sampled ids, so a
      // genuinely different batch in the same window still emits, while a
      // re-run over the same data collides. The @unique column is the hard
      // guard (P2002 on a concurrent race); the findFirst is the cheap path.
      const bucket = since.toISOString().slice(0, 10);
      const sampleSig = createHash('sha1')
        .update(sampleIds.slice().sort().join(','))
        .digest('hex')
        .slice(0, 12);
      const dedupeKey = `${tbl.source}:${bucket}:${sampleSig}`;

      const existing = await prisma.intelligenceChange.findFirst({
        where: { dedupeKey },
        select: { id: true },
      });
      if (existing) {
        console.log(`[emit-changes] ${tbl.source}: duplicate for window ${bucket} — skipped`);
        continue;
      }

      try {
        await prisma.intelligenceChange.create({
          data: {
            source: tbl.source,
            changeType: 'new_data',
            severity: severity(count),
            title: `${count} new ${tbl.label} synced`,
            description: `${count} new ${tbl.label} detected in the last 24 hours.`,
            relatedClientIds: [],
            relatedIssues: [],
            data: { count, table: tbl.source, sample_ids: sampleIds },
            dedupeKey,
          },
        });
      } catch (err) {
        // Unique-violation race with a concurrent run = the dup we wanted to skip.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          console.log(`[emit-changes] ${tbl.source}: concurrent duplicate — skipped`);
          continue;
        }
        throw err;
      }
      emitted++;
      console.log(`[emit-changes] ${tbl.source}: ${count} new rows → ${severity(count)}`);
    } catch (err) {
      errorCount++;
      console.error(`[emit-changes] ${tbl.source}: error -`, err);
    }
  }

  await prisma.syncRun.update({
    where: { id: syncRun.id },
    data: {
      finishedAt: new Date(),
      rowsInserted: emitted,
      errorCount,
      status: errorCount > 0 ? 'failed' : 'completed',
    },
  });

  console.log(
    `[emit-changes] done. Emitted ${emitted} change event${emitted !== 1 ? 's' : ''}, ${errorCount} errors.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
