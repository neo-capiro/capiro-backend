/**
 * Release R3, Step 3.7 — READ-ONLY invariant report over the loaded defense
 * budget-package data.
 *
 *   pnpm --filter @capiro/api verify:defense-budget-packages
 *   pnpm --filter @capiro/api verify:defense-budget-packages -- --domain defense --fy 2027
 *
 * Writes NOTHING. Prints one line per finding plus a whole-line JSON metric marker,
 * and EXITS NON-ZERO on a hard failure so it can gate a deploy (§3.7).
 *
 * HARD failures — data that would put a wrong or unattributable number on screen:
 *   duplicate package keys, positions missing fiscal year / stage / vehicle class /
 *   scope / source, conflicting VERIFIED rows on one natural key, invalid units,
 *   orphan vehicles, interim-period sequence gaps, impossible coverage dates.
 *
 * SOFT findings — reported, non-blocking:
 *   orphan bill ids (a vehicle may legitimately precede its congress_bill row),
 *   positions with no page citation, still-'extracted' figures awaiting review.
 *
 * The classifier is a pure function (`classifyFindings`) so the exact
 * hard/soft split is unit-tested without a database.
 */
import { config as dotenvConfig } from 'dotenv';
import { FUNDING_SCOPES, FUNDING_STAGES, BUDGET_VEHICLE_CLASSES } from '@capiro/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';

dotenvConfig();

/** Sanity ceiling for a MILLIONS figure — $100T. Above this it is a units error. */
const MAX_SANE_MILLIONS = 100_000_000;

export type Severity = 'hard' | 'soft';

export interface Finding {
  severity: Severity;
  code: string;
  detail: string;
}

export interface VerifyInput {
  packages: Array<{ id: string; domain: string; fiscalYear: number; name: string }>;
  vehicles: Array<{
    id: string;
    packageId: string;
    track: string;
    stage: string;
    billId: string | null;
    label: string;
  }>;
  positions: Array<{
    id: string;
    packageId: string;
    vehicleId: string | null;
    billId: string | null;
    fiscalYear: number | null;
    vehicleClass: string | null;
    stage: string | null;
    scope: string | null;
    amountMillions: number;
    sourceUrl: string | null;
    sourceDocumentId: string | null;
    sourcePage: number | null;
    verificationStatus: string;
  }>;
  interimPeriods: Array<{
    id: string;
    domain: string;
    fiscalYear: number;
    sequence: number;
    startDate: Date | null;
    coverageThrough: Date | null;
  }>;
  /** Bill ids that DO exist in congress_bill, for the orphan-bill check. */
  knownBillIds: Set<string>;
}

const SCOPE_SET = new Set<string>(FUNDING_SCOPES);
const STAGE_SET = new Set<string>(FUNDING_STAGES);
const CLASS_SET = new Set<string>(BUDGET_VEHICLE_CLASSES);

/** Pure invariant classifier. No DB, no clock. */
export function classifyFindings(input: VerifyInput): Finding[] {
  const out: Finding[] = [];
  const hard = (code: string, detail: string) => out.push({ severity: 'hard', code, detail });
  const soft = (code: string, detail: string) => out.push({ severity: 'soft', code, detail });

  // ── duplicate package keys ──
  const pkgKeys = new Map<string, string[]>();
  for (const p of input.packages) {
    const k = `${p.domain}|${p.fiscalYear}`;
    pkgKeys.set(k, [...(pkgKeys.get(k) ?? []), p.id]);
  }
  for (const [k, ids] of pkgKeys) {
    if (ids.length > 1) {
      hard('duplicate_package_key', `(domain, fiscalYear) ${k} has ${ids.length} packages: ${ids.join(', ')}`);
    }
  }

  const packageIds = new Set(input.packages.map((p) => p.id));
  const vehicleIds = new Set(input.vehicles.map((v) => v.id));

  // ── orphan vehicles ──
  for (const v of input.vehicles) {
    if (!packageIds.has(v.packageId)) {
      hard('orphan_vehicle', `vehicle ${v.id} ("${v.label}") references missing package ${v.packageId}`);
    }
    if (!CLASS_SET.has(v.track)) {
      hard('vehicle_unknown_track', `vehicle ${v.id} has track "${v.track}"`);
    }
    if (!STAGE_SET.has(v.stage)) {
      hard('vehicle_unknown_stage', `vehicle ${v.id} has stage "${v.stage}"`);
    }
    // A vehicle whose bill row has not landed yet is expected, not broken.
    if (v.billId && !input.knownBillIds.has(v.billId)) {
      soft('orphan_bill_id', `vehicle ${v.id} references bill "${v.billId}" with no congress_bill row`);
    }
  }

  // ── position-level required metadata ──
  const liveByKey = new Map<string, typeof input.positions>();
  for (const p of input.positions) {
    if (!packageIds.has(p.packageId)) {
      hard('orphan_position', `position ${p.id} references missing package ${p.packageId}`);
    }
    if (p.vehicleId && !vehicleIds.has(p.vehicleId)) {
      hard('orphan_position_vehicle', `position ${p.id} references missing vehicle ${p.vehicleId}`);
    }
    if (p.fiscalYear == null || !Number.isInteger(p.fiscalYear)) {
      hard('position_missing_fiscal_year', `position ${p.id} has no fiscal year`);
    }
    if (!p.stage || !STAGE_SET.has(p.stage)) {
      hard('position_missing_stage', `position ${p.id} has stage ${JSON.stringify(p.stage)}`);
    }
    if (!p.vehicleClass || !CLASS_SET.has(p.vehicleClass)) {
      hard(
        'position_missing_vehicle_class',
        `position ${p.id} has vehicleClass ${JSON.stringify(p.vehicleClass)}`,
      );
    }
    if (!p.scope || !SCOPE_SET.has(p.scope)) {
      hard('position_missing_scope', `position ${p.id} has scope ${JSON.stringify(p.scope)}`);
    }
    if (!p.sourceUrl && !p.sourceDocumentId) {
      hard('position_missing_source', `position ${p.id} has neither a source URL nor a source document`);
    }
    if (!Number.isFinite(p.amountMillions) || p.amountMillions < 0) {
      hard('position_invalid_units', `position ${p.id} amount ${p.amountMillions} is not a valid millions figure`);
    } else if (p.amountMillions > MAX_SANE_MILLIONS) {
      hard(
        'position_invalid_units',
        `position ${p.id} amount ${p.amountMillions} $M exceeds the sanity ceiling — likely loaded in dollars or thousands`,
      );
    }
    if (p.sourcePage == null) {
      soft('position_missing_page', `position ${p.id} has no source page citation`);
    }
    if (p.verificationStatus === 'extracted') {
      soft(
        'position_awaiting_review',
        `position ${p.id} is still 'extracted' (parser-staged, not reviewed)`,
      );
    }

    if (p.verificationStatus !== 'superseded') {
      const k = `${p.packageId}|${p.vehicleId ?? ''}|${p.fiscalYear}|${p.vehicleClass}|${p.stage}|${p.scope}`;
      liveByKey.set(k, [...(liveByKey.get(k) ?? []), p]);
    }
  }

  // ── conflicting live rows on one natural key ──
  for (const [k, rows] of liveByKey) {
    if (rows.length < 2) continue;
    const amounts = [...new Set(rows.map((r) => r.amountMillions))];
    const verified = rows.filter((r) => r.verificationStatus === 'verified');
    if (verified.length > 1 || amounts.length > 1) {
      hard(
        'conflicting_live_positions',
        `natural key ${k} has ${rows.length} live rows (${rows.map((r) => `${r.id}=${r.amountMillions}$M/${r.verificationStatus}`).join(', ')})`,
      );
    }
  }

  // ── interim-funding periods ──
  const seqByFy = new Map<string, number[]>();
  for (const p of input.interimPeriods) {
    const k = `${p.domain}|${p.fiscalYear}`;
    seqByFy.set(k, [...(seqByFy.get(k) ?? []), p.sequence]);
    if (p.startDate && p.coverageThrough && p.coverageThrough < p.startDate) {
      hard(
        'impossible_coverage_dates',
        `interim period ${p.id} funds through ${p.coverageThrough.toISOString()} but starts ${p.startDate.toISOString()}`,
      );
    }
  }
  for (const [k, seqs] of seqByFy) {
    const sorted = [...seqs].sort((a, b) => a - b);
    for (const [i, s] of sorted.entries()) {
      if (s !== i + 1) {
        hard(
          'interim_sequence_gap',
          `${k} interim sequences are not contiguous from 1: [${sorted.join(', ')}]`,
        );
        break;
      }
    }
  }

  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const domain = arg('domain');
  const fyArg = arg('fy');
  const fiscalYear = fyArg ? Number(fyArg) : undefined;
  const pkgWhere = {
    ...(domain ? { domain } : {}),
    ...(fiscalYear != null && Number.isFinite(fiscalYear) ? { fiscalYear } : {}),
  };

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const packages = await prisma.budgetPackage.findMany({
      where: pkgWhere,
      select: { id: true, domain: true, fiscalYear: true, name: true },
    });
    const packageIds = packages.map((p) => p.id);

    const [vehicles, positions, interimPeriods] = await Promise.all([
      prisma.budgetPackageVehicle.findMany({
        where: packageIds.length ? { packageId: { in: packageIds } } : {},
        select: { id: true, packageId: true, track: true, stage: true, billId: true, label: true },
      }),
      prisma.fundingPosition.findMany({
        where: packageIds.length ? { packageId: { in: packageIds } } : {},
      }),
      prisma.budgetInterimFundingPeriod.findMany({
        where: {
          ...(domain ? { domain } : {}),
          ...(fiscalYear != null && Number.isFinite(fiscalYear) ? { fiscalYear } : {}),
        },
        select: {
          id: true,
          domain: true,
          fiscalYear: true,
          sequence: true,
          startDate: true,
          coverageThrough: true,
        },
      }),
    ]);

    // Resolve which referenced bill ids actually exist, in ONE bounded query.
    const referencedBills = [
      ...new Set(
        [
          ...vehicles.map((v) => v.billId),
          ...positions.map((p) => p.billId),
          ...interimPeriods.map(() => null),
        ].filter((b): b is string => Boolean(b)),
      ),
    ];
    const known = referencedBills.length
      ? await prisma.congressBill.findMany({
          where: { id: { in: referencedBills } },
          select: { id: true },
        })
      : [];

    const findings = classifyFindings({
      packages,
      vehicles,
      positions: positions.map((p) => ({
        id: p.id,
        packageId: p.packageId,
        vehicleId: p.vehicleId,
        billId: p.billId,
        fiscalYear: p.fiscalYear,
        vehicleClass: p.vehicleClass,
        stage: p.stage,
        scope: p.scope,
        amountMillions: Number(p.amountMillions),
        sourceUrl: p.sourceUrl,
        sourceDocumentId: p.sourceDocumentId,
        sourcePage: p.sourcePage,
        verificationStatus: p.verificationStatus,
      })),
      interimPeriods,
      knownBillIds: new Set(known.map((b) => b.id)),
    });

    const hard = findings.filter((f) => f.severity === 'hard');
    const soft = findings.filter((f) => f.severity === 'soft');
    for (const f of soft) console.log(`SOFT  ${f.code}  ${f.detail}`);
    for (const f of hard) console.error(`HARD  ${f.code}  ${f.detail}`);

    console.log(
      `CHECKED packages=${packages.length} vehicles=${vehicles.length} positions=${positions.length} interimPeriods=${interimPeriods.length}`,
    );
    // Whole-line JSON marker for a CloudWatch Logs metric filter on $.hardFailures.
    console.log(
      JSON.stringify({
        marker: 'defense_budget_packages_metric',
        packages: packages.length,
        vehicles: vehicles.length,
        positions: positions.length,
        interimPeriods: interimPeriods.length,
        softFindings: soft.length,
        hardFailures: hard.length,
      }),
    );

    if (hard.length) {
      console.error(`\n${hard.length} hard failure(s) — budget package data is NOT safe to display.`);
      process.exit(1);
    }
    console.log('\nAll hard invariants hold.');
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly, so the spec can import the pure classifier.
if (process.argv[1] && /verify-defense-budget-packages\.ts$/.test(process.argv[1])) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
