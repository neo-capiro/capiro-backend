/**
 * Tango↔SAM crosswalk and parity diagnostic (Funding Opportunities P27).
 *
 *   tsx scripts/diag-tango-opportunity-parity.ts
 *   tsx scripts/diag-tango-opportunity-parity.ts --max-conflicts=25
 *   tsx scripts/diag-tango-opportunity-parity.ts --stale-hours=48 --field=response_deadline
 *
 * READ-ONLY. No Tango call, no API key, no write of any kind — this only reads
 * Capiro's own database.
 *
 * ── What "blocking" means here, and why the default is nothing ───────────────
 *
 * An ordinary `unlinked` row is NOT a problem. The provider's catalog and
 * Capiro's own SAM.gov rail sync on different schedules and cover slightly
 * different windows, so a steady population of provider notices with no local
 * counterpart is the expected state of a verification rail, not a failure. A
 * diagnostic that exited nonzero on those would be red permanently and
 * therefore ignored — the same mistake `funding-opportunities-ci.yml`'s own
 * header records for a drift check that was red on arrival.
 *
 * So this command exits 0 unless a threshold the OPERATOR set is breached:
 *
 *   `--max-conflicts=<n>`   unreviewed per-field conflicts
 *   `--max-ambiguous=<n>`   provider notices whose solicitation number matched
 *                           more than one local notice
 *   `--stale-hours=<n>`     hours since the last completed shadow sync
 *
 * With none of the three set it reports and exits 0. That is deliberate: the
 * decision about what counts as too much disagreement is an operational one,
 * and hard-coding it here would make it invisible.
 *
 * ── The one thing this command will never do ──────────────────────────────────
 *
 * It does not resolve a conflict. `resolution` moves only through an explicit,
 * attributed human review, because a conflict resolved by whichever job ran
 * last is exactly the "last write wins" merge plan §4.2 forbids. The report
 * names the conflicts; a person decides.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PARITY_FIELDS, type ParityField } from '../src/external/tango/tango-opportunity.mapper.js';

dotenvConfig();

const SYNC_VERB = 'sync-tango-opportunity-shadow';

// ── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function positiveInt(argv: string[], name: string): number | undefined {
  const raw = flagValue(argv, name);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export interface ParsedArgs {
  /** Undefined means "no threshold" — report and exit 0. */
  maxConflicts: number | undefined;
  maxAmbiguous: number | undefined;
  staleHours: number | undefined;
  /** Narrow the conflict sample to one field. Unknown values are ignored, not guessed. */
  field: ParityField | undefined;
  /** How many example conflicts to print. */
  sample: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const fieldRaw = flagValue(argv, 'field');
  const sample = positiveInt(argv, 'sample');
  return {
    maxConflicts: positiveInt(argv, 'max-conflicts'),
    maxAmbiguous: positiveInt(argv, 'max-ambiguous'),
    staleHours: positiveInt(argv, 'stale-hours'),
    field:
      fieldRaw != null && (PARITY_FIELDS as readonly string[]).includes(fieldRaw)
        ? (fieldRaw as ParityField)
        : undefined,
    sample: sample ?? 10,
  };
}

// ── The report ───────────────────────────────────────────────────────────────

export interface ParityReport {
  /** Per-field counts of every agreement outcome. */
  byField: Record<string, Record<string, number>>;
  /** Totals across all fields. */
  byAgreement: Record<string, number>;
  /** Conflicts nobody has reviewed yet. The number a threshold is set against. */
  unreviewedConflicts: number;
  /** Conflicts a human has explicitly kept the LOCAL value for. */
  localCanonicalConflicts: number;
  /** Distinct linked (provider, local) pairs the ledger covers. */
  linkedPairs: number;
  /** Active `exact_identifier` links recorded in tango_resource_link. */
  activeLinks: number;
  /** Provider observations held that no link points at. */
  unlinkedObservations: number;
  /** The last completed shadow-sync checkpoint, and its age in hours. */
  lastSync: { at: string | null; completeness: string | null; hoursAgo: number | null };
  /** Up to `sample` example unreviewed conflicts, oldest first. */
  examples: Array<{
    field: string;
    tangoOpportunityId: string;
    samOpportunityId: string;
    localValue: string | null;
    providerValue: string | null;
    firstObservedAt: string;
  }>;
  /** Non-empty when an operator-set threshold was breached. Drives the exit code. */
  breaches: string[];
}

export interface ParityReaderPort {
  countByFieldAndAgreement(): Promise<Array<{ field: string; agreement: string; count: number }>>;
  countConflictsByResolution(): Promise<Array<{ resolution: string; count: number }>>;
  countLinkedPairs(): Promise<number>;
  countActiveLinks(): Promise<number>;
  countObservations(): Promise<number>;
  readLastSync(): Promise<{ at: Date | null; completeness: string | null }>;
  sampleUnreviewedConflicts(
    limit: number,
    field: ParityField | undefined,
  ): Promise<
    Array<{
      field: string;
      tangoOpportunityId: string;
      samOpportunityId: string;
      localValue: string | null;
      providerValue: string | null;
      firstObservedAt: Date;
    }>
  >;
}

/**
 * Build the report. Pure with respect to its reader, so the threshold logic —
 * the only part with an exit code attached — is provable without a database.
 */
export async function buildParityReport(
  port: ParityReaderPort,
  args: ParsedArgs,
  asOf: Date = new Date(),
): Promise<ParityReport> {
  const [grouped, byResolution, linkedPairs, activeLinks, observations, lastSync, examples] =
    await Promise.all([
      port.countByFieldAndAgreement(),
      port.countConflictsByResolution(),
      port.countLinkedPairs(),
      port.countActiveLinks(),
      port.countObservations(),
      port.readLastSync(),
      port.sampleUnreviewedConflicts(args.sample, args.field),
    ]);

  const byField: Record<string, Record<string, number>> = {};
  const byAgreement: Record<string, number> = {};
  for (const row of grouped) {
    byField[row.field] ??= {};
    byField[row.field]![row.agreement] = row.count;
    byAgreement[row.agreement] = (byAgreement[row.agreement] ?? 0) + row.count;
  }

  const resolutionCounts = new Map(byResolution.map((r) => [r.resolution, r.count]));
  const unreviewedConflicts = resolutionCounts.get('unreviewed') ?? 0;
  const localCanonicalConflicts = resolutionCounts.get('local_canonical') ?? 0;

  const hoursAgo =
    lastSync.at != null
      ? Math.floor((asOf.getTime() - lastSync.at.getTime()) / 3_600_000)
      : null;

  const breaches: string[] = [];
  if (args.maxConflicts != null && unreviewedConflicts > args.maxConflicts) {
    breaches.push(
      `unreviewed conflicts ${unreviewedConflicts} exceeds --max-conflicts=${args.maxConflicts}`,
    );
  }
  const ambiguous = byAgreement['ambiguous'] ?? 0;
  if (args.maxAmbiguous != null && ambiguous > args.maxAmbiguous) {
    breaches.push(`ambiguous crosswalks ${ambiguous} exceeds --max-ambiguous=${args.maxAmbiguous}`);
  }
  if (args.staleHours != null) {
    if (hoursAgo == null) {
      // "Never run" breaches a staleness threshold. Reporting it as fresh
      // because there is no timestamp to compare would be the most misleading
      // available answer.
      breaches.push(
        `the shadow sync has never completed a run, and --stale-hours=${args.staleHours} was set`,
      );
    } else if (hoursAgo > args.staleHours) {
      breaches.push(`last completed sync was ${hoursAgo}h ago, exceeding --stale-hours=${args.staleHours}`);
    }
  }

  return {
    byField,
    byAgreement,
    unreviewedConflicts,
    localCanonicalConflicts,
    linkedPairs,
    activeLinks,
    unlinkedObservations: Math.max(observations - activeLinks, 0),
    lastSync: {
      at: lastSync.at ? lastSync.at.toISOString() : null,
      completeness: lastSync.completeness,
      hoursAgo,
    },
    examples: examples.map((e) => ({
      field: e.field,
      tangoOpportunityId: e.tangoOpportunityId,
      samOpportunityId: e.samOpportunityId,
      localValue: e.localValue,
      providerValue: e.providerValue,
      firstObservedAt: e.firstObservedAt.toISOString(),
    })),
    breaches,
  };
}

/**
 * The human-readable summary.
 *
 * States the LOCAL-IS-CANONICAL rule in the output itself rather than assuming
 * the reader knows it. A table of disagreements with no statement about which
 * side wins invites somebody to "fix" the local value.
 */
export function formatParityReport(report: ParityReport): string {
  const lines: string[] = [];
  lines.push('Tango↔SAM parity ledger');
  lines.push('  Capiro\'s own SAM.gov row stays canonical for every field below.');
  lines.push('  A conflict is evidence for review, never a value to copy over.');
  lines.push('');
  lines.push(
    `  linked pairs: ${report.linkedPairs}   active exact-identifier links: ${report.activeLinks}   provider observations with no link: ${report.unlinkedObservations}`,
  );
  lines.push(
    `  unreviewed conflicts: ${report.unreviewedConflicts}   reviewed & kept local: ${report.localCanonicalConflicts}`,
  );
  const at = report.lastSync.at ?? 'never';
  const age = report.lastSync.hoursAgo != null ? ` (${report.lastSync.hoursAgo}h ago)` : '';
  lines.push(`  last completed shadow sync: ${at}${age} [${report.lastSync.completeness ?? 'n/a'}]`);
  lines.push('');
  for (const field of PARITY_FIELDS) {
    const counts = report.byField[field];
    if (!counts) continue;
    const parts = Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(`  ${field.padEnd(20)} ${parts}`);
  }
  if (report.examples.length > 0) {
    lines.push('');
    lines.push('  Example unreviewed conflicts (oldest first):');
    for (const e of report.examples) {
      lines.push(
        `    ${e.field}: local="${e.localValue ?? '—'}" provider="${e.providerValue ?? '—'}"  since ${e.firstObservedAt}  (tango ${e.tangoOpportunityId} / sam ${e.samOpportunityId})`,
      );
    }
  }
  if (report.breaches.length > 0) {
    lines.push('');
    lines.push('  THRESHOLD BREACHED:');
    for (const b of report.breaches) lines.push(`    - ${b}`);
  }
  return lines.join('\n');
}

// ── Real wiring ──────────────────────────────────────────────────────────────

function realPort(prisma: PrismaClient): ParityReaderPort {
  return {
    // tenant-scope-exempt: tango_opportunity_parity, tango_resource_link and
    // tango_resource_snapshot are all GLOBAL provider tables with no tenant_id
    // and no RLS (P15/P27) — same category as sam_opportunity.
    countByFieldAndAgreement: async () => {
      const rows = await prisma.tangoOpportunityParity.groupBy({
        by: ['field', 'agreement'],
        _count: { _all: true },
      });
      return rows.map((r) => ({ field: r.field, agreement: r.agreement, count: r._count._all }));
    },
    countConflictsByResolution: async () => {
      const rows = await prisma.tangoOpportunityParity.groupBy({
        by: ['resolution'],
        where: { agreement: 'conflict' },
        _count: { _all: true },
      });
      return rows.map((r) => ({ resolution: r.resolution, count: r._count._all }));
    },
    countLinkedPairs: async () => {
      const rows = await prisma.tangoOpportunityParity.groupBy({
        by: ['tangoOpportunityId', 'samOpportunityId'],
      });
      return rows.length;
    },
    countActiveLinks: () =>
      prisma.tangoResourceLink.count({
        where: {
          localResourceType: 'sam_opportunity',
          tangoResourceType: 'opportunity',
          status: 'active',
        },
      }),
    countObservations: () =>
      prisma.tangoResourceSnapshot.count({
        where: { resourceType: 'opportunity', active: true },
      }),
    readLastSync: async () => {
      const row = await prisma.tangoSyncCheckpoint.findFirst({
        where: { syncVerb: SYNC_VERB, resourceType: 'opportunity', completeness: 'complete' },
        orderBy: { windowEnd: 'desc' },
        select: { windowEnd: true, completeness: true },
      });
      return { at: row?.windowEnd ?? null, completeness: row?.completeness ?? null };
    },
    sampleUnreviewedConflicts: async (limit, field) => {
      const rows = await prisma.tangoOpportunityParity.findMany({
        where: {
          agreement: 'conflict',
          resolution: 'unreviewed',
          ...(field ? { field } : {}),
        },
        orderBy: { firstObservedAt: 'asc' },
        take: limit,
        select: {
          field: true,
          tangoOpportunityId: true,
          samOpportunityId: true,
          localValue: true,
          providerValue: true,
          firstObservedAt: true,
        },
      });
      return rows;
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const report = await buildParityReport(realPort(prisma), args);
    console.log(formatParityReport(report));
    console.log(`TANGO_OPP_PARITY_JSON ${JSON.stringify(report)}`);
    // Nonzero ONLY for an operator-set threshold. An ordinary unlinked row is
    // the expected state of a verification rail, not a failure.
    if (report.breaches.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /diag-tango-opportunity-parity(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    console.error('TANGO_OPP_PARITY_ERR', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { main };
