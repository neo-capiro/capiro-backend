/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Read-only DISTRICT NEXUS SOURCE MATRIX report (Gate 2, pre-R5 closeout).
 * For each source: row count, distinct source-run rows (attempts) if tracked,
 * last successful sync timestamp, and (for Tango subawards) the stored sync
 * checkpoint. SAFE: COUNT()/MAX()/SELECT reads only. No writes.
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const usage = 'Usage: apps/api/scripts/diag-district-nexus-source-matrix.ts requires DATABASE_URL (database configuration is required)';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (args.length > 0) {
    console.error(usage);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(usage);
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    async function scalar<T>(sql: string): Promise<T | string> {
      try {
        const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql);
        const row = rows?.[0];
        if (!row) return 'null';
        const value = Object.values(row)[0];
        if (value == null) return 'null';
        if (typeof value === 'bigint') return Number(value) as unknown as T;
        if (value instanceof Date) return value.toISOString() as unknown as T;
        return value as T;
      } catch (e) {
        return `ERR:${e instanceof Error ? e.message.slice(0, 120) : 'x'}`;
      }
    }

    async function rows(sql: string): Promise<unknown[] | string> {
      try {
        const r = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql);
        return r.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [
              k,
              typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v,
            ]),
          ),
        );
      } catch (e) {
        return `ERR:${e instanceof Error ? e.message.slice(0, 120) : 'x'}`;
      }
    }

    const report: Record<string, unknown> = {};

    for (const source of ['acs', 'cbp', 'lodes']) {
      report[`district_economic_fact.${source}`] = {
        rowCount: await scalar(`SELECT COUNT(*) FROM district_economic_fact WHERE source = '${source}'`),
        distinctDistricts: await scalar(
          `SELECT COUNT(DISTINCT (state, district_code)) FROM district_economic_fact WHERE source = '${source}'`,
        ),
        maxSourceYear: await scalar(`SELECT MAX(source_year) FROM district_economic_fact WHERE source = '${source}'`),
        lastObservedAt: await scalar(
          `SELECT MAX(observed_at) FROM district_economic_fact WHERE source = '${source}'`,
        ),
        lastSyncedAt: await scalar(
          `SELECT MAX(last_synced_at) FROM district_economic_fact WHERE source = '${source}'`,
        ),
      };
    }
    report['district_economic_source_run'] = {
      recentRuns: await rows(
        `SELECT source, status, attempted_at FROM district_economic_source_run ORDER BY attempted_at DESC LIMIT 15`,
      ),
    };

    report['gsa_real_property'] = {
      rowCount: await scalar(`SELECT COUNT(*) FROM gsa_real_property`),
      maxRetrievedAt: await scalar(`SELECT MAX(retrieved_at) FROM gsa_real_property`),
    };
    report['gsa_real_property_source_run'] = {
      recentRuns: await rows(
        `SELECT status, dry_run, attempted_at, completed_at, rows_seen, rows_written, rows_rejected FROM gsa_real_property_source_run ORDER BY attempted_at DESC LIMIT 10`,
      ),
    };

    report['community_funding_request'] = {
      rowCount: await scalar(`SELECT COUNT(*) FROM community_funding_request`),
      nullRequesterState: await scalar(
        `SELECT COUNT(*) FROM community_funding_request WHERE requester_state IS NULL`,
      ),
      maxFiscalYear: await scalar(`SELECT MAX(fiscal_year) FROM community_funding_request`),
    };
    report['community_funding_ingest_run'] = {
      recentRuns: await rows(
        `SELECT source, chamber, status, rows_emitted, upserted, rejected, created_at FROM community_funding_ingest_run ORDER BY created_at DESC LIMIT 10`,
      ),
    };

    report['sam_opportunity'] = {
      rowCount: await scalar(`SELECT COUNT(*) FROM sam_opportunity`),
      maxLastSyncedAt: await scalar(`SELECT MAX(last_synced_at) FROM sam_opportunity`),
    };
    report['tango_procurement_forecast'] = {
      rowCount: await scalar(`SELECT COUNT(*) FROM tango_procurement_forecast`),
    };

    report['tango_subaward'] = {
      rowCount: await scalar(`SELECT COUNT(*) FROM tango_subaward`),
      maxLastSyncedAt: await scalar(`SELECT MAX(last_synced_at) FROM tango_subaward`),
    };
    report['tango_subaward_sync_checkpoint'] = {
      checkpoints: await rows(
        `SELECT sync_key, window_start, window_end, next_page, completeness, rows_processed, page_size, page_size_source, total_reported, updated_at FROM tango_subaward_sync_checkpoint ORDER BY updated_at DESC`,
      ),
    };

    // L3Harris / FL-08 UEI gap (Gate 2 item 2) — direct trace, independent of
    // client_intel_mapping wiring, to inspect the actual excluded rows.
    report['l3harris_fl08_null_uei'] = {
      countAndSum: await rows(
        `SELECT COUNT(*) AS award_count, SUM(amount)::float8 AS total_amount
         FROM federal_award
        WHERE (contractor_name ILIKE '%L3HARRIS%' OR contractor_name ILIKE '%L3 HARRIS%')
          AND pop_state = 'FL' AND pop_congressional_district = '08'
          AND recipient_uei IS NULL`,
      ),
      sampleRows: await rows(
        `SELECT id::text, award_unique_id, piid, contractor_name, amount::float8, action_date, last_synced_at, recipient_uei
         FROM federal_award
        WHERE (contractor_name ILIKE '%L3HARRIS%' OR contractor_name ILIKE '%L3 HARRIS%')
          AND pop_state = 'FL' AND pop_congressional_district = '08'
          AND recipient_uei IS NULL
        ORDER BY amount DESC LIMIT 15`,
      ),
      sameContractorOtherRowsHaveUei: await scalar(
        `SELECT COUNT(*) FROM federal_award
        WHERE (contractor_name ILIKE '%L3HARRIS%' OR contractor_name ILIKE '%L3 HARRIS%')
          AND recipient_uei IS NOT NULL`,
      ),
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((e) => {
    console.error('FATAL', e);
    process.exitCode = 1;
  });
}
