/**
 * Read-only canary diagnostic for the whole MakeGov/Tango program — Funding
 * Opportunities P49.
 *
 *   tsx scripts/diag-funding-opportunities-makegov.ts
 *   tsx scripts/diag-funding-opportunities-makegov.ts --tenant=<uuid>
 *   tsx scripts/diag-funding-opportunities-makegov.ts --json
 *
 * ── SELECT-ONLY. No writes, no provider call, no key required ────────────────
 *
 * This never talks to MakeGov. It reports what Capiro's own database says about
 * a canary run that has already happened, which is the only thing a canary
 * REVIEW can honestly be: re-fetching from the provider would change the very
 * freshness numbers the reviewer is trying to judge, and would spend account
 * quota during a review.
 *
 * `TANGO_API_KEY` is deliberately not read. A diagnostic that needed the key
 * could not be run by whoever is reviewing the canary unless they also held the
 * credential.
 *
 * ── What it answers, and why each one is on P49's list ───────────────────────
 *
 *   FRESHNESS   — when each provider dataset was last synced. A canary that
 *                 looks healthy because it is reading week-old data is the
 *                 failure this catches.
 *   COUNTS      — row counts per provider table. Zero is a legitimate answer
 *                 and is reported as zero, never hidden.
 *   LINKAGE     — how many Tango observations resolved to a local record.
 *                 Unlinked is not an error; unlinked-and-unreported is.
 *   CONFLICTS   — parity rows where Tango and the first-party rail disagree.
 *                 §4.2 requires a conflict be RECORDED, never silently merged,
 *                 so a nonzero count here is the system working.
 *   ENRICHMENT  — clients with a UEI but no entity profile: work P19 has not
 *                 done yet, which would otherwise look like "no data".
 *   API USAGE   — calls, 429s, and error rate from `tango_api_usage` (P18).
 *   QUIETNESS   — alerts written per day, and the suppression picture. P48's
 *                 whole promise is that unchanged data is silent; this is where
 *                 a reviewer sees whether that held over two passes.
 *
 * ── Nothing here is a verdict ────────────────────────────────────────────────
 *
 * Every number is reported with the query that produced it. The script does not
 * print PASS or FAIL, because "is this canary acceptable" is a judgement about
 * a specific tenant's data that a person makes — and a green banner is exactly
 * how a canary gets waved through.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

export interface ParsedArgs {
  tenantId: string | null;
  json: boolean;
  /** How many days of usage/alert history to summarize. */
  windowDays: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const get = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const raw = get('window-days');
  const parsed = raw === null ? NaN : Number(raw);
  return {
    tenantId: get('tenant'),
    json: argv.includes('--json'),
    windowDays: Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 7,
  };
}

/** One reported measurement. `query` is carried so a reader can re-run it. */
export interface Measurement {
  section: string;
  label: string;
  /** A `{failed}` value means the QUERY broke — not that the data is absent. */
  value: Measured;
  /** Present when the value needs reading in context rather than at face value. */
  note?: string;
}

export interface CanaryReport {
  generatedAt: string;
  tenantScope: string;
  windowDays: number;
  measurements: Measurement[];
}

/**
 * Render the report as text.
 *
 * Grouped by section, and a null value prints as `—` rather than `0`. That
 * distinction is the same one this whole program is built on: "the source
 * stated nothing" is not "the source stated zero".
 */
export function renderReport(report: CanaryReport): string[] {
  const lines: string[] = [
    `Funding Opportunities + MakeGov canary diagnostic`,
    `generated: ${report.generatedAt}`,
    `tenant scope: ${report.tenantScope}`,
    `window: last ${report.windowDays} day(s)`,
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
  lines.push('');
  lines.push(
    'This report states no verdict. Whether the canary is acceptable is a judgement',
    "about this tenant's data, made by a person — see",
    'docs/runbooks/funding-opportunities-makegov-canary.md.',
  );
  return lines;
}

/**
 * A query that FAILED is not the same fact as a query that found nothing, and
 * conflating them is how three broken queries in the first version of this
 * script hid in plain sight.
 *
 * They referenced `tango_entity_profile` (a table that has never existed —
 * P19 stores entity snapshots in `tango_resource_snapshot`) and a column
 * `agrees` (the real one is `agreement`). Both threw, both were swallowed, and
 * both rendered as an em dash — visually identical to "the provider holds
 * nothing". A canary reviewer would have read three broken measurements as
 * three empty datasets and moved on.
 *
 * So a failure is now its own value, and it PRINTS as `QUERY FAILED` with the
 * reason. It still does not abort the report: a table missing because its
 * migration has not been applied is a real canary state worth seeing alongside
 * everything else.
 */
export type Measured = number | string | null | { failed: string };

/** Collapse an error to one short, single-line reason. Never a payload. */
export function failure(e: unknown): { failed: string } {
  const raw = e instanceof Error ? e.message : String(e);
  return { failed: raw.replace(/\s+/g, ' ').trim().slice(0, 120) };
}

async function safeCount(prisma: PrismaClient, sql: string): Promise<Measured> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(sql);
    const n = rows[0]?.n;
    // No row back from a COUNT is itself impossible; treat it as a failure
    // rather than as zero.
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

/** True when any measurement failed outright, as opposed to being absent. */
export function hasQueryFailure(report: CanaryReport): boolean {
  return report.measurements.some(
    (m) => typeof m.value === 'object' && m.value !== null && 'failed' in m.value,
  );
}

export async function buildReport(prisma: PrismaClient, args: ParsedArgs): Promise<CanaryReport> {
  const m: Measurement[] = [];
  const w = args.windowDays;

  // ── Freshness ─────────────────────────────────────────────────────────────
  const freshness: [string, string][] = [
    ['__entity_snapshots__', 'entity snapshots (P19)'],
    ['tango_procurement_forecast', 'forecasts (P24)'],
    ['tango_opportunity_notice', 'notice history (P28)'],
    ['tango_budget_account', 'budget accounts (P44)'],
    ['tango_procurement_protest', 'protests (P45)'],
  ];
  for (const [table, label] of freshness) {
    // P19 has NO dedicated entity table — it writes into the P15 substrate,
    // `tango_resource_snapshot`, whose freshness column is `provider_fetched_at`
    // rather than `last_synced_at`. The first version of this script queried a
    // `tango_entity_profile` table that has never existed.
    const sql =
      table === '__entity_snapshots__'
        ? `SELECT max("provider_fetched_at")::text AS v FROM "tango_resource_snapshot" WHERE "resource_type" = 'entity'`
        : `SELECT max("last_synced_at")::text AS v FROM "${table}"`;
    m.push({ section: 'Freshness — last sync', label, value: await safeValue(prisma, sql) });
  }

  // ── Counts ────────────────────────────────────────────────────────────────
  const counts: [string, string][] = [
    ['tango_resource_snapshot', 'provider snapshots'],
    ['__entity_snapshots__', 'entity snapshots'],
    ['tango_procurement_forecast', 'forecasts'],
    ['tango_opportunity_notice', 'notices'],
    ['tango_webhook_delivery', 'verified webhook deliveries (P46)'],
    ['tango_event_outbox', 'queued events (P48)'],
    ['tango_event_alert', 'client alerts (P48)'],
  ];
  for (const [table, label] of counts) {
    const sql =
      table === '__entity_snapshots__'
        ? `SELECT count(*) AS n FROM "tango_resource_snapshot" WHERE "resource_type" = 'entity'`
        : `SELECT count(*) AS n FROM "${table}"`;
    m.push({ section: 'Counts', label, value: await safeCount(prisma, sql) });
  }

  // ── Linkage ───────────────────────────────────────────────────────────────
  m.push({
    section: 'Linkage',
    label: 'notices linked to a SAM opportunity',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_opportunity_notice" WHERE "sam_opportunity_id" IS NOT NULL`,
    ),
  });
  m.push({
    section: 'Linkage',
    label: 'notices NOT linked',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_opportunity_notice" WHERE "sam_opportunity_id" IS NULL`,
    ),
    note: 'Unlinked is not an error — most provider notices will never match a Capiro row. Unlinked and unreported would be.',
  });

  // ── Conflicts ─────────────────────────────────────────────────────────────
  m.push({
    section: 'Conflicts',
    label: 'parity rows where the two sources disagree',
    value: await safeCount(
      prisma,
      // The column is `agreement`, with vocabulary
      // agree | conflict | local_only | provider_only | both_absent — NOT a
      // boolean `agrees`. Only 'conflict' is a disagreement: local_only and
      // provider_only mean one side simply has no value, which is absence, not
      // a contradiction, and counting them as conflicts would inflate the one
      // number a reviewer is most likely to act on.
      `SELECT count(*) AS n FROM "tango_opportunity_parity" WHERE "agreement" = 'conflict'`,
    ),
    note: '§4.2 requires a conflict be RECORDED, never silently merged. A nonzero count here is the system working, not failing.',
  });

  // ── Missing enrichment ────────────────────────────────────────────────────
  m.push({
    section: 'Missing enrichment',
    label: 'clients with a UEI but no entity snapshot',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "clients" c
       WHERE c."uei" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "tango_resource_snapshot" s
           WHERE s."resource_type" = 'entity' AND s."external_id" = c."uei" AND s."active"
         )`,
    ),
    note: 'Work P19 has not done yet. Without this line it would look identical to "the provider holds nothing".',
  });

  // ── API usage ─────────────────────────────────────────────────────────────
  m.push({
    section: `API usage (last ${w}d)`,
    label: 'total calls',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_api_usage" WHERE "created_at" > now() - interval '${w} days'`,
    ),
  });
  m.push({
    section: `API usage (last ${w}d)`,
    label: 'rate-limited (429)',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_api_usage" WHERE "status" = 'rate_limit' AND "created_at" > now() - interval '${w} days'`,
    ),
  });
  m.push({
    section: `API usage (last ${w}d)`,
    label: 'errors (any non-success status)',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_api_usage" WHERE "status" <> 'success' AND "created_at" > now() - interval '${w} days'`,
    ),
  });
  m.push({
    section: `API usage (last ${w}d)`,
    label: 'last successful call',
    value: await safeValue(
      prisma,
      `SELECT max("created_at")::text AS v FROM "tango_api_usage" WHERE "status" = 'success'`,
    ),
  });

  // ── Alert quietness ───────────────────────────────────────────────────────
  m.push({
    section: `Alert quietness (last ${w}d)`,
    label: 'alerts written',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_event_alert" WHERE "created_at" > now() - interval '${w} days'`,
    ),
    note: 'P48 promises unchanged data is silent. Across two manual passes with no source change, this must not grow.',
  });
  m.push({
    section: `Alert quietness (last ${w}d)`,
    label: 'distinct clients alerted',
    value: await safeCount(
      prisma,
      `SELECT count(DISTINCT "client_id") AS n FROM "tango_event_alert" WHERE "created_at" > now() - interval '${w} days'`,
    ),
  });
  m.push({
    section: `Alert quietness (last ${w}d)`,
    label: 'critical-severity alerts',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_event_alert" WHERE "severity" = 'critical' AND "created_at" > now() - interval '${w} days'`,
    ),
  });
  m.push({
    section: 'Event queue health',
    label: 'quarantined events',
    value: await safeCount(
      prisma,
      `SELECT count(*) AS n FROM "tango_event_outbox" WHERE "status" = 'quarantined'`,
    ),
    note: 'Terminal and never retried. Each one is an operator decision, not a transient failure.',
  });
  m.push({
    section: 'Event queue health',
    label: 'oldest pending event',
    value: await safeValue(
      prisma,
      `SELECT min("created_at")::text AS v FROM "tango_event_outbox" WHERE "status" = 'pending'`,
    ),
    note: 'Queue age. A growing value means the drain is not keeping up, or is not running.',
  });

  return {
    generatedAt: new Date().toISOString(),
    tenantScope: args.tenantId ?? 'all tenants (global provider tables are not tenant-scoped)',
    windowDays: w,
    measurements: m,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const report = await buildReport(prisma, args);
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
if (invoked.includes('diag-funding-opportunities-makegov')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'Unknown failure');
    process.exitCode = 1;
  });
}
