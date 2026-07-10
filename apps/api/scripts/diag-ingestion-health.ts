/**
 * Read-only INGESTION HEALTH report. For each major synced table: total row
 * count + most-recent timestamp (so we can see staleness), plus the alert-gate
 * coverage. SAFE: COUNT() + findFirst(orderBy desc) reads only. No writes.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function maxDate(model: string, field: string): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ m: Date | null }>>(
      `SELECT MAX("${field}") AS m FROM "${model}"`,
    );
    const v = rows?.[0]?.m;
    return v ? new Date(v).toISOString().slice(0, 10) : null;
  } catch (e) {
    return `ERR:${e instanceof Error ? e.message.slice(0, 60) : 'x'}`;
  }
}

async function count(model: string): Promise<number | string> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*)::bigint AS c FROM "${model}"`,
    );
    return Number(rows?.[0]?.c ?? 0);
  } catch (e) {
    return `ERR:${e instanceof Error ? e.message.slice(0, 60) : 'x'}`;
  }
}

// table -> [content-recency column, ingestion-recency column]. The content
// column is when the underlying event happened (may legitimately lag); the
// ingestion column (synced_at / last_synced_at) is when our sync last wrote
// the row — that's the authoritative "is the pipeline running?" signal.
// Table names + columns verified live 2026-06-16 against the schema @@map.
const TABLES: Array<[string, string, string]> = [
  ['congress_bill', 'latest_action_date', 'last_synced_at'],
  ['federal_register_document', 'publication_date', 'synced_at'],
  ['lda_filing', 'dt_posted', 'synced_at'],
  ['federal_award', 'awarded_at', 'synced_at'],
  ['committee_hearing', 'date', 'synced_at'],
  ['fec_contribution', 'contribution_date', 'synced_at'],
  ['fara_registration', 'registration_date', 'synced_at'],
  ['sec_filing', 'filing_date', 'synced_at'],
  ['gao_report', 'publish_date', 'synced_at'],
  ['crs_report', 'published_at', 'synced_at'],
  ['regulatory_docket', 'posted_date', 'synced_at'],
  ['intel_article', 'published_at', 'synced_at'],
  ['state_bill', 'latest_action_date', 'synced_at'],
  ['intelligence_change', 'detected_at', 'detected_at'],
];

interface StateSlaRow {
  state: string;
  p50Minutes: number | null;
  p95Minutes: number | null;
  sampleSize: number;
  lastDrainAt: string | null;
  lastListAt: string | null;
}

/**
 * State Legislation Platform SLA telemetry (Phase 0 S1.6) — measures
 * INGESTION LAG (firstSeenAt - action.date), not legislative recency. A naive
 * `max(action.date) - now` would misread quiet or out-of-session states as
 * permanent SLA breaches; this is the marketed freshness number (parent plan
 * SC-1) instead.
 */
async function stateIngestionSla(): Promise<StateSlaRow[]> {
  try {
    const percentiles = await prisma.$queryRawUnsafe<
      Array<{ state: string; p50: number | null; p95: number | null; n: bigint }>
    >(`
      SELECT sb.state,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (sba.first_seen_at - sba.date::timestamptz)) / 60
             ) AS p50,
             percentile_cont(0.95) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (sba.first_seen_at - sba.date::timestamptz)) / 60
             ) AS p95,
             COUNT(*)::bigint AS n
      FROM "state_bill_action" sba
      JOIN "state_bill" sb ON sb.id = sba.bill_key
      WHERE sba.first_seen_at > NOW() - INTERVAL '7 days'
      GROUP BY sb.state
      ORDER BY sb.state
    `);
    const lastSync = await prisma.$queryRawUnsafe<
      Array<{ state: string; last_drain_at: Date | null; last_list_at: Date | null }>
    >(`
      SELECT state, MAX(last_drain_at) AS last_drain_at, MAX(last_list_at) AS last_list_at
      FROM "state_sync_cursor"
      GROUP BY state
    `);
    const syncByState = new Map(lastSync.map((r) => [r.state, r]));
    return percentiles.map((r) => ({
      state: r.state,
      p50Minutes: r.p50 != null ? Math.round(r.p50) : null,
      p95Minutes: r.p95 != null ? Math.round(r.p95) : null,
      sampleSize: Number(r.n),
      lastDrainAt: syncByState.get(r.state)?.last_drain_at?.toISOString() ?? null,
      lastListAt: syncByState.get(r.state)?.last_list_at?.toISOString() ?? null,
    }));
  } catch (e) {
    console.error('INGEST_ERR state SLA query failed', e instanceof Error ? e.message : String(e));
    return [];
  }
}

async function main(): Promise<void> {
  const out: Record<
    string,
    { rows: number | string; latest: string | null; lastSynced: string | null }
  > = {};
  for (const [t, contentCol, syncCol] of TABLES) {
    out[t] = {
      rows: await count(t),
      latest: await maxDate(t, contentCol),
      lastSynced: await maxDate(t, syncCol),
    };
  }
  const stateSla = await stateIngestionSla();
  console.log(
    'INGEST_REPORT ' +
      JSON.stringify(
        { generatedAt: new Date().toISOString(), tables: out, stateLegislationSla: stateSla },
        null,
        2,
      ),
  );
}

main()
  .catch((err) => {
    console.error('INGEST_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
