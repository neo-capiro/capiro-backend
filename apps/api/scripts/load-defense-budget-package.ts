/**
 * Release R3, Step 3.2 — reviewed defense budget-package loader.
 *
 *   pnpm --filter @capiro/api load:defense-budget-package -- --artifact scripts/__data__/defense-budget/fy2027-package.json
 *   pnpm --filter @capiro/api load:defense-budget-package -- --artifact ... --commit
 *
 * Loads a CURATED, human-reviewed JSON artifact into budget_package /
 * budget_package_vehicle / funding_position / budget_interim_funding_period.
 *
 * DRY RUN BY DEFAULT (same discipline as every other dollar loader in this repo):
 * without --commit it prints the planned inserts, updates, supersessions, missing
 * sources, and conflicts, and writes NOTHING.
 *
 * The loader REJECTS a position that is stage-less, vehicle-less, scope-less,
 * source-less, or unit-ambiguous (§3.2). It never guesses units: each position
 * must declare `"units": "millions"` explicitly. It never writes
 * verificationStatus='superseded' from an artifact, and it refuses to overwrite an
 * already-'verified' figure with a different amount unless --supersede-verified is
 * passed, so a reviewed number cannot be silently replaced.
 *
 * The pure planner (`validateArtifact` + `planPackageLoad`) is exported and
 * unit-tested by load-defense-budget-package.spec.ts — it touches no DB.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BUDGET_VEHICLE_CLASSES,
  FUNDING_SCOPES,
  FUNDING_STAGES,
  FUNDING_VERIFICATION_STATUSES,
} from '@capiro/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';

dotenvConfig();

// ── Artifact shape (curated JSON) ────────────────────────────────────────────

export interface ArtifactVehicle {
  /** Stable key used by positions to reference this vehicle within the artifact. */
  key: string;
  track: string;
  stage: string;
  label: string;
  billId?: string | null;
  reportNumber?: string | null;
  publicLaw?: string | null;
  chamber?: string | null;
  status?: string | null;
  statusAt?: string | null;
  sourceUrl?: string | null;
  /** source_document.source_key to link, when the document is already registered. */
  sourceKey?: string | null;
}

export interface ArtifactPosition {
  vehicleKey: string;
  fiscalYear: number;
  vehicleClass: string;
  stage: string;
  scope: string;
  amountMillions: number;
  /** MUST be the literal 'millions'. Anything else is a units error, not a guess. */
  units: string;
  effectiveDate?: string | null;
  sourceUrl?: string | null;
  sourcePage?: number | null;
  note?: string | null;
  /** 'extracted' | 'reviewed' | 'verified'. Defaults to 'reviewed'. */
  verificationStatus?: string | null;
  sourceKey?: string | null;
}

export interface ArtifactInterimPeriod {
  sequence: number;
  vehicleLabel: string;
  startDate?: string | null;
  coverageThrough?: string | null;
  billId?: string | null;
  publicLaw?: string | null;
  shutdownDays?: number | null;
  notes?: string | null;
  sourceUrl?: string | null;
  sourceKey?: string | null;
}

export interface PackageArtifact {
  domain?: string;
  fiscalYear?: number;
  name?: string;
  status?: string;
  vehicles?: ArtifactVehicle[];
  positions?: ArtifactPosition[];
  interimFundingPeriods?: ArtifactInterimPeriod[];
}

/** A live funding_position row as the planner needs to see it. */
export interface ExistingPosition {
  id: string;
  vehicleKey: string | null;
  fiscalYear: number;
  vehicleClass: string;
  stage: string;
  scope: string;
  amountMillions: number;
  verificationStatus: string;
}

export type PlanAction = 'insert' | 'update' | 'supersede';

export interface PlannedPosition {
  action: PlanAction;
  /** The live row this plan replaces/updates (null for a fresh insert). */
  existingId: string | null;
  position: ArtifactPosition;
  /** Human-readable reason, printed in the dry run. */
  reason: string;
}

export interface LoadPlan {
  /** Hard validation failures. A non-empty list blocks --commit. */
  errors: string[];
  /** Non-blocking review notes (e.g. a position with no page citation). */
  warnings: string[];
  /**
   * Verified-row conflicts. Blocks --commit unless --supersede-verified is passed,
   * so an already-reviewed official figure is never silently replaced.
   */
  conflicts: string[];
  vehicles: ArtifactVehicle[];
  positions: PlannedPosition[];
  interimFundingPeriods: ArtifactInterimPeriod[];
}

const VEHICLE_CLASS_SET = new Set<string>(BUDGET_VEHICLE_CLASSES);
const STAGE_SET = new Set<string>(FUNDING_STAGES);
const SCOPE_SET = new Set<string>(FUNDING_SCOPES);
/** An artifact may assert these; 'superseded' is derived by the loader, never declared. */
const ARTIFACT_VERIFICATION_SET = new Set<string>(
  FUNDING_VERIFICATION_STATUSES.filter((s) => s !== 'superseded'),
);
const VEHICLE_STATUSES = new Set([
  'introduced',
  'reported',
  'passed',
  'enacted',
  'failed',
  'expired',
]);

/** ISO date (or datetime) → Date, or null. Rejects unparseable input via NaN check. */
function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Validate the artifact envelope + every vehicle. Returns hard errors only —
 * position-level validation happens in {@link planPackageLoad} so a single pass
 * reports everything at once.
 */
export function validateArtifact(a: PackageArtifact): string[] {
  const errors: string[] = [];
  if (!a.domain) errors.push('artifact.domain is required (e.g. "defense")');
  if (!Number.isInteger(a.fiscalYear)) errors.push('artifact.fiscalYear must be an integer year');
  if (!a.name) errors.push('artifact.name is required (e.g. "FY27 Defense Budget")');

  const keys = new Set<string>();
  for (const [i, v] of (a.vehicles ?? []).entries()) {
    const at = `vehicles[${i}]`;
    if (!v.key) errors.push(`${at}.key is required`);
    else if (keys.has(v.key)) errors.push(`${at}.key "${v.key}" is duplicated`);
    else keys.add(v.key);
    if (!v.label) errors.push(`${at}.label is required`);
    if (!VEHICLE_CLASS_SET.has(v.track)) {
      errors.push(`${at}.track "${v.track}" is not a BUDGET_VEHICLE_CLASSES value`);
    }
    if (!STAGE_SET.has(v.stage)) {
      errors.push(`${at}.stage "${v.stage}" is not a FUNDING_STAGES value`);
    }
    if (v.status && !VEHICLE_STATUSES.has(v.status)) {
      errors.push(`${at}.status "${v.status}" is not a known vehicle status`);
    }
    if (v.statusAt && !toDate(v.statusAt)) errors.push(`${at}.statusAt "${v.statusAt}" is unparseable`);
    // A vehicle must be identifiable as a real public artifact.
    if (!v.billId && !v.reportNumber && !v.publicLaw && !v.sourceUrl && !v.sourceKey) {
      errors.push(
        `${at} has no billId, reportNumber, publicLaw, sourceUrl, or sourceKey — a vehicle must be traceable to a public document`,
      );
    }
  }

  for (const [i, p] of (a.interimFundingPeriods ?? []).entries()) {
    const at = `interimFundingPeriods[${i}]`;
    if (!Number.isInteger(p.sequence) || p.sequence < 1) {
      errors.push(`${at}.sequence must be an integer >= 1`);
    }
    if (!p.vehicleLabel) errors.push(`${at}.vehicleLabel is required`);
    const start = toDate(p.startDate);
    const through = toDate(p.coverageThrough);
    if (p.startDate && !start) errors.push(`${at}.startDate "${p.startDate}" is unparseable`);
    if (p.coverageThrough && !through) {
      errors.push(`${at}.coverageThrough "${p.coverageThrough}" is unparseable`);
    }
    if (start && through && through < start) {
      errors.push(`${at}.coverageThrough is before startDate — impossible coverage window`);
    }
    if (p.shutdownDays != null && (!Number.isInteger(p.shutdownDays) || p.shutdownDays < 0)) {
      errors.push(`${at}.shutdownDays must be a non-negative integer`);
    }
  }

  const seq = (a.interimFundingPeriods ?? []).map((p) => p.sequence).sort((x, y) => x - y);
  for (const [i, s] of seq.entries()) {
    if (s !== i + 1) {
      errors.push(
        `interimFundingPeriods sequences must be contiguous from 1 (got [${seq.join(', ')}])`,
      );
      break;
    }
  }

  return errors;
}

/**
 * Plan the load: classify each artifact position against the live rows and collect
 * every rejection reason. PURE — no DB, no clock, no filesystem.
 *
 * A position is rejected outright (never committed) when it lacks a stage, a
 * vehicle, a scope, a source, or declares anything other than millions. A position
 * whose live counterpart holds a DIFFERENT amount supersedes it; identical amounts
 * update in place (refreshing note/page/source metadata only).
 */
export function planPackageLoad(a: PackageArtifact, existing: ExistingPosition[]): LoadPlan {
  const errors = validateArtifact(a);
  const warnings: string[] = [];
  const conflicts: string[] = [];
  const planned: PlannedPosition[] = [];

  const vehicles = a.vehicles ?? [];
  const vehicleByKey = new Map(vehicles.map((v) => [v.key, v]));
  const liveByKey = new Map(
    existing
      .filter((e) => e.verificationStatus !== 'superseded')
      .map((e) => [
        `${e.vehicleKey ?? ''}|${e.fiscalYear}|${e.vehicleClass}|${e.stage}|${e.scope}`,
        e,
      ]),
  );

  const seenKeys = new Set<string>();

  for (const [i, p] of (a.positions ?? []).entries()) {
    const at = `positions[${i}]`;
    const reject = (msg: string) => errors.push(`${at} REJECTED: ${msg}`);
    let ok = true;

    // ── the five hard rejections (§3.2) ──
    if (!p.stage || !STAGE_SET.has(p.stage)) {
      reject(`stage-less or unknown stage "${p.stage ?? ''}"`);
      ok = false;
    }
    if (!p.vehicleKey || !vehicleByKey.has(p.vehicleKey)) {
      reject(`vehicle-less — vehicleKey "${p.vehicleKey ?? ''}" matches no declared vehicle`);
      ok = false;
    }
    if (!p.vehicleClass || !VEHICLE_CLASS_SET.has(p.vehicleClass)) {
      reject(`unknown vehicleClass "${p.vehicleClass ?? ''}"`);
      ok = false;
    }
    if (!p.scope || !SCOPE_SET.has(p.scope)) {
      reject(`scope-less or unknown scope "${p.scope ?? ''}" — a delta needs an exact scope`);
      ok = false;
    }
    if (!p.sourceUrl && !p.sourceKey) {
      reject('source-less — every displayed amount needs a sourceUrl or a sourceKey');
      ok = false;
    }
    if (p.units !== 'millions') {
      reject(
        `unit-ambiguous — units must be the literal "millions" (got ${JSON.stringify(p.units ?? null)}); the loader never guesses a scale`,
      );
      ok = false;
    }
    if (typeof p.amountMillions !== 'number' || !Number.isFinite(p.amountMillions)) {
      reject(`amountMillions must be a finite number (got ${JSON.stringify(p.amountMillions)})`);
      ok = false;
    } else if (p.amountMillions < 0) {
      reject('amountMillions must be >= 0');
      ok = false;
    }
    if (!Number.isInteger(p.fiscalYear)) {
      reject('fiscalYear must be an integer year');
      ok = false;
    }
    if (p.verificationStatus && !ARTIFACT_VERIFICATION_SET.has(p.verificationStatus)) {
      reject(
        `verificationStatus "${p.verificationStatus}" cannot be declared by an artifact (allowed: ${[...ARTIFACT_VERIFICATION_SET].join(', ')})`,
      );
      ok = false;
    }
    if (p.effectiveDate && !toDate(p.effectiveDate)) {
      reject(`effectiveDate "${p.effectiveDate}" is unparseable`);
      ok = false;
    }
    if (!ok) continue;

    // A position's stage/class should agree with its vehicle; disagreement is a
    // review warning, not a rejection (a CR can carry a defense-title figure).
    const veh = vehicleByKey.get(p.vehicleKey)!;
    if (veh.stage !== p.stage) {
      warnings.push(`${at}: stage "${p.stage}" differs from vehicle "${veh.key}" stage "${veh.stage}"`);
    }
    if (veh.track !== p.vehicleClass) {
      warnings.push(
        `${at}: vehicleClass "${p.vehicleClass}" differs from vehicle "${veh.key}" track "${veh.track}"`,
      );
    }
    if (p.sourcePage == null) {
      warnings.push(`${at}: no sourcePage — the figure cannot be pinpointed in its document`);
    }
    if (a.fiscalYear != null && p.fiscalYear !== a.fiscalYear) {
      warnings.push(
        `${at}: fiscalYear ${p.fiscalYear} differs from the package fiscalYear ${a.fiscalYear} (prior-year or outyear figure)`,
      );
    }

    const key = `${p.vehicleKey}|${p.fiscalYear}|${p.vehicleClass}|${p.stage}|${p.scope}`;
    if (seenKeys.has(key)) {
      errors.push(
        `${at} REJECTED: duplicate natural key within the artifact (${key}) — two toplines cannot share one (vehicle, FY, class, stage, scope)`,
      );
      continue;
    }
    seenKeys.add(key);

    const live = liveByKey.get(key);
    if (!live) {
      planned.push({ action: 'insert', existingId: null, position: p, reason: 'no live row' });
      continue;
    }
    if (live.amountMillions === p.amountMillions) {
      planned.push({
        action: 'update',
        existingId: live.id,
        position: p,
        reason: 'same amount — refreshing source/page/note metadata only',
      });
      continue;
    }
    if (live.verificationStatus === 'verified') {
      conflicts.push(
        `${at}: live VERIFIED row ${live.id} holds ${live.amountMillions} $M, artifact asserts ${p.amountMillions} $M for (${key}). Pass --supersede-verified to record the new official figure and keep the old one as superseded.`,
      );
    }
    planned.push({
      action: 'supersede',
      existingId: live.id,
      position: p,
      reason: `amount changed ${live.amountMillions} → ${p.amountMillions} $M (live row kept as superseded)`,
    });
  }

  return {
    errors,
    warnings,
    conflicts,
    vehicles,
    positions: planned,
    interimFundingPeriods: a.interimFundingPeriods ?? [],
  };
}

/** One-line-per-item dry-run report. */
export function formatPlan(plan: LoadPlan): string {
  const lines: string[] = [];
  const counts = { insert: 0, update: 0, supersede: 0 } as Record<PlanAction, number>;
  for (const p of plan.positions) counts[p.action] += 1;
  lines.push(
    `vehicles=${plan.vehicles.length} positions: insert=${counts.insert} update=${counts.update} supersede=${counts.supersede} interimPeriods=${plan.interimFundingPeriods.length}`,
  );
  for (const p of plan.positions) {
    lines.push(
      `  ${p.action.toUpperCase().padEnd(9)} ${p.position.vehicleKey} FY${p.position.fiscalYear} ${p.position.stage}/${p.position.vehicleClass}/${p.position.scope} = ${p.position.amountMillions} $M — ${p.reason}`,
    );
  }
  for (const w of plan.warnings) lines.push(`  WARNING   ${w}`);
  for (const c of plan.conflicts) lines.push(`  CONFLICT  ${c}`);
  for (const e of plan.errors) lines.push(`  ERROR     ${e}`);
  return lines.join('\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error(
      'Usage: load-defense-budget-package.ts --artifact <package.json> [--commit] [--supersede-verified] [--validate-only]',
    );
    process.exit(1);
  }
  const commit = process.argv.includes('--commit');
  const supersedeVerified = process.argv.includes('--supersede-verified');
  /**
   * Validate the artifact with NO database at all — every rejection rule runs
   * against an empty live set. This is what a curator runs while transcribing
   * figures, long before the file goes anywhere near Aurora (which sits in a
   * private subnet and is unreachable from a laptop).
   */
  const validateOnly = process.argv.includes('--validate-only');

  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as PackageArtifact;
  const domain = artifact.domain ?? 'defense';
  const fiscalYear = Number(artifact.fiscalYear);

  if (validateOnly) {
    const plan = planPackageLoad(artifact, []);
    console.log(`VALIDATE-ONLY ${domain} FY${fiscalYear} — ${artifactPath} (no database read)`);
    console.log(formatPlan(plan));
    if (plan.errors.length) {
      console.error(`\n${plan.errors.length} hard error(s).`);
      process.exit(1);
    }
    console.log('\nArtifact is valid. Re-run without --validate-only (against the DB) to diff it.');
    return;
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    // Read the live package + its rows so the plan is a real diff, not a guess.
    const pkg = await prisma.budgetPackage.findUnique({
      where: { domain_fiscalYear: { domain, fiscalYear } },
      include: { vehicles: true, positions: true },
    });

    // Live positions keyed by their VEHICLE LABEL → artifact key, so a plan can be
    // computed before any id exists. Vehicles are matched on (track, stage, label).
    const artifactKeyByLabel = new Map(
      (artifact.vehicles ?? []).map((v) => [`${v.track}|${v.stage}|${v.label}`, v.key]),
    );
    const keyByVehicleId = new Map<string, string>();
    for (const v of pkg?.vehicles ?? []) {
      const k = artifactKeyByLabel.get(`${v.track}|${v.stage}|${v.label}`);
      if (k) keyByVehicleId.set(v.id, k);
    }
    const existing: ExistingPosition[] = (pkg?.positions ?? []).map((p) => ({
      id: p.id,
      vehicleKey: p.vehicleId ? (keyByVehicleId.get(p.vehicleId) ?? null) : null,
      fiscalYear: p.fiscalYear,
      vehicleClass: p.vehicleClass,
      stage: p.stage,
      scope: p.scope,
      amountMillions: Number(p.amountMillions),
      verificationStatus: p.verificationStatus,
    }));

    const plan = planPackageLoad(artifact, existing);
    console.log(`${commit ? 'COMMIT' : 'DRY RUN'} ${domain} FY${fiscalYear} — ${artifactPath}`);
    console.log(formatPlan(plan));

    if (plan.errors.length) {
      console.error(`\n${plan.errors.length} hard error(s) — nothing was written.`);
      process.exit(1);
    }
    if (plan.conflicts.length && !supersedeVerified) {
      console.error(
        `\n${plan.conflicts.length} verified-row conflict(s) — nothing was written. Re-run with --supersede-verified once the new figure is confirmed official.`,
      );
      process.exit(1);
    }
    if (!commit) {
      console.log('\nDry run — no writes. Re-run with --commit to apply.');
      return;
    }

    // ── writes ──
    const pkgRow = await prisma.budgetPackage.upsert({
      where: { domain_fiscalYear: { domain, fiscalYear } },
      create: {
        domain,
        fiscalYear,
        name: artifact.name ?? `FY${String(fiscalYear).slice(-2)} ${domain} budget`,
        status: artifact.status ?? 'open',
      },
      update: { name: artifact.name ?? undefined, status: artifact.status ?? undefined },
    });

    // Source documents are referenced, never created here: the registry is owned by
    // the ingestion pipeline. A sourceKey with no registered document is a warning,
    // and the position keeps its sourceUrl so provenance is never lost.
    const sourceKeys = [
      ...new Set(
        [
          ...(artifact.vehicles ?? []).map((v) => v.sourceKey),
          ...(artifact.positions ?? []).map((p) => p.sourceKey),
          ...(artifact.interimFundingPeriods ?? []).map((p) => p.sourceKey),
        ].filter((k): k is string => Boolean(k)),
      ),
    ];
    const docs = sourceKeys.length
      ? await prisma.sourceDocument.findMany({
          where: { sourceKey: { in: sourceKeys } },
          select: { id: true, sourceKey: true },
        })
      : [];
    const docIdByKey = new Map(docs.map((d) => [d.sourceKey, d.id]));
    for (const k of sourceKeys) {
      if (!docIdByKey.has(k)) {
        console.warn(`  MISSING SOURCE  source_document.source_key "${k}" is not registered`);
      }
    }

    // Vehicles: upsert on (package, track, stage, label) — there is no DB unique on
    // that triple (a stage may hold several vehicles), so match-then-write.
    const vehicleIdByKey = new Map<string, string>();
    for (const v of plan.vehicles) {
      const found = await prisma.budgetPackageVehicle.findFirst({
        where: { packageId: pkgRow.id, track: v.track, stage: v.stage, label: v.label },
        select: { id: true },
      });
      const data = {
        billId: v.billId ?? null,
        reportNumber: v.reportNumber ?? null,
        publicLaw: v.publicLaw ?? null,
        chamber: v.chamber ?? null,
        status: v.status ?? 'introduced',
        statusAt: toDate(v.statusAt),
        sourceUrl: v.sourceUrl ?? null,
        sourceDocumentId: v.sourceKey ? (docIdByKey.get(v.sourceKey) ?? null) : null,
      };
      const row = found
        ? await prisma.budgetPackageVehicle.update({ where: { id: found.id }, data })
        : await prisma.budgetPackageVehicle.create({
            data: { packageId: pkgRow.id, track: v.track, stage: v.stage, label: v.label, ...data },
          });
      vehicleIdByKey.set(v.key, row.id);
    }

    let inserted = 0;
    let updated = 0;
    let superseded = 0;
    for (const p of plan.positions) {
      const vehicleId = vehicleIdByKey.get(p.position.vehicleKey) ?? null;
      const data = {
        packageId: pkgRow.id,
        vehicleId,
        billId: plan.vehicles.find((v) => v.key === p.position.vehicleKey)?.billId ?? null,
        fiscalYear: p.position.fiscalYear,
        vehicleClass: p.position.vehicleClass,
        stage: p.position.stage,
        scope: p.position.scope,
        amountMillions: p.position.amountMillions,
        effectiveDate: toDate(p.position.effectiveDate),
        sourceUrl: p.position.sourceUrl ?? null,
        sourcePage: p.position.sourcePage ?? null,
        note: p.position.note ?? null,
        verificationStatus: p.position.verificationStatus ?? 'reviewed',
        sourceDocumentId: p.position.sourceKey ? (docIdByKey.get(p.position.sourceKey) ?? null) : null,
      };
      if (p.action === 'update' && p.existingId) {
        await prisma.fundingPosition.update({ where: { id: p.existingId }, data });
        updated += 1;
        continue;
      }
      if (p.action === 'supersede' && p.existingId) {
        // Retire then insert inside ONE transaction: the partial unique index allows
        // exactly one non-superseded row per natural key, so the retire MUST land
        // before the insert or the insert violates it.
        await prisma.$transaction([
          prisma.fundingPosition.update({
            where: { id: p.existingId },
            data: { verificationStatus: 'superseded' },
          }),
          prisma.fundingPosition.create({ data }),
        ]);
        superseded += 1;
        continue;
      }
      await prisma.fundingPosition.create({ data });
      inserted += 1;
    }

    let interim = 0;
    for (const p of plan.interimFundingPeriods) {
      await prisma.budgetInterimFundingPeriod.upsert({
        where: { domain_fiscalYear_sequence: { domain, fiscalYear, sequence: p.sequence } },
        create: {
          domain,
          fiscalYear,
          sequence: p.sequence,
          vehicleLabel: p.vehicleLabel,
          startDate: toDate(p.startDate),
          coverageThrough: toDate(p.coverageThrough),
          billId: p.billId ?? null,
          publicLaw: p.publicLaw ?? null,
          shutdownDays: p.shutdownDays ?? null,
          notes: p.notes ?? null,
          sourceUrl: p.sourceUrl ?? null,
          sourceDocumentId: p.sourceKey ? (docIdByKey.get(p.sourceKey) ?? null) : null,
        },
        update: {
          vehicleLabel: p.vehicleLabel,
          startDate: toDate(p.startDate),
          coverageThrough: toDate(p.coverageThrough),
          billId: p.billId ?? null,
          publicLaw: p.publicLaw ?? null,
          shutdownDays: p.shutdownDays ?? null,
          notes: p.notes ?? null,
          sourceUrl: p.sourceUrl ?? null,
        },
      });
      interim += 1;
    }

    console.log(
      JSON.stringify(
        {
          artifact: path.relative(process.cwd(), artifactPath),
          packageId: pkgRow.id,
          vehicles: vehicleIdByKey.size,
          positions: { inserted, updated, superseded },
          interimFundingPeriods: interim,
          warnings: plan.warnings.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly, so the spec can import the pure planner.
if (process.argv[1] && /load-defense-budget-package\.ts$/.test(process.argv[1])) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
