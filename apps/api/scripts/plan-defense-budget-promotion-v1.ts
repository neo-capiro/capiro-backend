/**
 * plan-defense-budget-promotion-v1 (Phase 7 Workstream N) — read-only.
 *
 * Builds a deterministic promotion plan for one cycle/scope and prints it as
 * machine-readable JSON. Issues no write statement: the plan is filed by a
 * separate authorized step, not by this command.
 *
 *   plan-defense-budget-promotion-v1 --environment <env> --cycle-id <id>
 *                                    --fiscal-year <fy> --families <a,b>
 *                                    --eligibility-hash <sha256>
 *                                    [--mode new_cycle|baseline_hydration|correction|rollback]
 *                                    [--plan-id <id>] [--proposed-snapshot-id <uuid>]
 *                                    [--expected-active-snapshot-id <uuid>]
 *                                    [--stages <a,b>] [--domain <domain>]
 *                                    [--summary-only]
 *
 * Determinism: `--plan-id` and `--proposed-snapshot-id` default to values
 * derived from the scope, so re-running against unchanged inputs reproduces the
 * same plan hash — which is the Workstream C acceptance criterion. Passing a
 * random snapshot id would break it.
 *
 * `--eligibility-hash` is required rather than computed. The eligibility
 * service (Workstream A) has no Prisma repository in this build, so there is no
 * trustworthy way to derive the hash here; accepting an operator-supplied one
 * and binding the plan to it is honest, whereas inventing one would produce a
 * plan that claims an eligibility evaluation that never happened.
 *
 * Exit codes: 0 plan is clean, 3 plan is blocked, 2 usage, 1 error.
 */
import { createHash } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  buildPromotionPlanV1,
  type ManualOverlayV1,
  type PriorCanonicalRowV1,
  type PromotionModeV1,
} from '../src/defense-budget/promotion/promotion-planner-v1.js';
import {
  canonicalMappingRegistryHashV1,
  DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
  type CanonicalEntityV1,
} from '../src/defense-budget/promotion/canonical-mapping-registry-v1.js';
import { PrismaPromotionProjectionSourceV1 } from '../src/defense-budget/promotion/promotion-projection-source-prisma-v1.js';
import {
  BUDGET_FAMILY_V1_VALUES,
  type BudgetFamilyV1,
  type FundingFieldV1,
} from '../src/defense-budget/contracts/extraction-artifact-v1.js';

dotenvConfig();

const DEFAULT_DOMAIN = 'defense_budget';
const PROMOTION_MODES: readonly PromotionModeV1[] = [
  'baseline_hydration',
  'new_cycle',
  'correction',
  'rollback',
];

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function databaseHost(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return 'UNAVAILABLE';
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${parsed.pathname.replace(/^\//, '')}`;
  } catch {
    return 'UNPARSEABLE_DATABASE_URL';
  }
}

function gitSha(): string {
  // Same rule as status-defense-budget-promotion-v1.ts: the ECS
  // container-metadata URI is never a fallback — its last path segment is a
  // container id, not a reviewable commit.
  return (
    process.env.GIT_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION ??
    'UNVERIFIED'
  );
}

function usage(message: string): never {
  console.error(`plan-defense-budget-promotion-v1: ${message}`);
  process.exit(2);
}

/**
 * A well-formed UUID derived from the scope. Deterministic by construction so
 * that the same scope always proposes the same snapshot id and therefore the
 * same plan hash.
 */
function deterministicUuidV1(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = (((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8) >>> 0).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

interface PriorRowQueryResultV1 {
  canonicalEntity: string;
  canonicalNaturalKey: string;
  canonicalRowHash: string;
  snapshotId: string;
}

interface OverlayQueryResultV1 {
  canonicalEntity: string;
  canonicalNaturalKey: string;
  fiscalYear: number | null;
  fundingField: string | null;
  status: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

async function main(): Promise<void> {
  const domain = argValue('--domain') ?? DEFAULT_DOMAIN;
  const environment = argValue('--environment');
  const cycleId = argValue('--cycle-id');
  const fiscalYearRaw = argValue('--fiscal-year');
  const familiesRaw = argValue('--families');
  const eligibilityHash = argValue('--eligibility-hash');

  if (!environment) usage('--environment is required');
  if (!cycleId) usage('--cycle-id is required');
  if (!fiscalYearRaw) usage('--fiscal-year is required');
  if (!familiesRaw) usage('--families is required (comma-separated)');
  if (!eligibilityHash) usage('--eligibility-hash is required (64 hex characters)');
  if (!/^[0-9a-f]{64}$/.test(eligibilityHash)) {
    usage('--eligibility-hash must be 64 lowercase hex characters');
  }

  const fiscalYear = Number(fiscalYearRaw);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) {
    usage(`--fiscal-year must be an integer between 1900 and 2200 (got ${fiscalYearRaw})`);
  }

  const families = [
    ...new Set(
      familiesRaw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b)) as BudgetFamilyV1[];
  if (families.length === 0) usage('--families must name at least one family');
  const unknownFamilies = families.filter(
    (family) => !(BUDGET_FAMILY_V1_VALUES as readonly string[]).includes(family),
  );
  if (unknownFamilies.length > 0) {
    usage(
      `unknown budget family/families: ${unknownFamilies.join(', ')}; valid values are ${BUDGET_FAMILY_V1_VALUES.join(', ')}`,
    );
  }

  const stages = (argValue('--stages') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort((a, b) => a.localeCompare(b));

  const mode = (argValue('--mode') ?? 'new_cycle') as PromotionModeV1;
  if (!PROMOTION_MODES.includes(mode)) {
    usage(`--mode must be one of ${PROMOTION_MODES.join(', ')} (got ${mode})`);
  }

  const scope = { cycleId, fiscalYear, families, stages };
  const scopeSeed = JSON.stringify({ domain, environment, scope, mode });
  const planId =
    argValue('--plan-id') ??
    `plan-${createHash('sha256').update(scopeSeed).digest('hex').slice(0, 24)}`;
  const proposedSnapshotId =
    argValue('--proposed-snapshot-id') ?? deterministicUuidV1(`snapshot:${scopeSeed}`);

  const prisma = new PrismaClient();
  try {
    /* ---- What is actually active right now, read read-only ---- */

    const activeRows = await prisma.$queryRawUnsafe<Array<{ snapshotId: string }>>(
      `SELECT "snapshot_id" AS "snapshotId"
         FROM "defense_budget_active_snapshot"
        WHERE "domain" = $1 AND "environment" = $2`,
      domain,
      environment,
    );
    const actualActiveSnapshotId = activeRows[0]?.snapshotId ?? null;
    const expectedActiveSnapshotId =
      argValue('--expected-active-snapshot-id') ?? actualActiveSnapshotId;

    /* ---- Prior canonical rows from the active snapshot ---- */

    const priorRows: PriorCanonicalRowV1[] =
      actualActiveSnapshotId == null
        ? []
        : (
            await prisma.$queryRawUnsafe<PriorRowQueryResultV1[]>(
              `SELECT "canonical_entity" AS "canonicalEntity",
                      "canonical_natural_key" AS "canonicalNaturalKey",
                      "canonical_row_hash" AS "canonicalRowHash",
                      "snapshot_id" AS "snapshotId"
                 FROM "defense_budget_canonical_row"
                WHERE "snapshot_id" = $1::uuid
                ORDER BY "canonical_entity", "canonical_natural_key"`,
              actualActiveSnapshotId,
            )
          ).map((row) => ({
            canonicalEntity: row.canonicalEntity as CanonicalEntityV1,
            naturalKey: row.canonicalNaturalKey,
            rowHash: row.canonicalRowHash,
            snapshotId: row.snapshotId,
          }));

    /* ---- Governed manual overrides, newest version per target ---- */

    const overlayRows = await prisma.$queryRawUnsafe<OverlayQueryResultV1[]>(
      `SELECT DISTINCT ON ("canonical_entity", "canonical_natural_key", "fiscal_year", "funding_field")
              "canonical_entity" AS "canonicalEntity",
              "canonical_natural_key" AS "canonicalNaturalKey",
              "fiscal_year" AS "fiscalYear",
              "funding_field" AS "fundingField",
              "status", "effective_from" AS "effectiveFrom", "effective_to" AS "effectiveTo"
         FROM "defense_budget_manual_override"
        WHERE "status" <> 'proposed'
        ORDER BY "canonical_entity", "canonical_natural_key", "fiscal_year", "funding_field",
                 "version" DESC`,
    );

    const now = Date.now();
    const overlays: ManualOverlayV1[] = overlayRows.map((row) => {
      // Expiry is derived from the window at read time, never stored — the
      // migration's own note. Mirror that here rather than trusting a flag.
      const status: ManualOverlayV1['status'] =
        row.status === 'revoked'
          ? 'revoked'
          : row.effectiveTo != null && new Date(row.effectiveTo).getTime() <= now
            ? 'expired'
            : 'active';
      return {
        canonicalEntity: row.canonicalEntity as CanonicalEntityV1,
        naturalKey: row.canonicalNaturalKey,
        fiscalYear: row.fiscalYear,
        fundingField: row.fundingField as FundingFieldV1 | null,
        status,
      };
    });

    /* ---- Verified projections ---- */

    const source = new PrismaPromotionProjectionSourceV1(prisma);
    const loaded = await source.loadForScope({ fiscalYear, families });

    const header = {
      environment,
      domain,
      databaseHost: databaseHost(),
      gitSha: gitSha(),
      mode: 'plan',
      safety: 'Read-only. No write statement issued. No secrets included.',
      generatedAt: new Date().toISOString(),
    };

    /* An unreadable family or a refused candidate blocks the plan outright.
     * Emitting a plan that silently omits them is exactly the failure the
     * Phase 7 invariants forbid — the plan would look clean while covering
     * less than its own scope claims. */
    if (loaded.unsupportedFamilies.length > 0 || loaded.refusals.length > 0) {
      console.log(
        JSON.stringify(
          {
            ...header,
            planId,
            scope,
            promotionMode: mode,
            planProduced: false,
            blocked: true,
            unsupportedFamilies: loaded.unsupportedFamilies,
            refusals: loaded.refusals,
            detail:
              loaded.unsupportedFamilies.length > 0
                ? 'this build has no verified-projection reader for every requested family; no plan was produced'
                : 'the family projector refused one or more candidates; no plan was produced',
          },
          null,
          2,
        ),
      );
      process.exit(3);
    }

    const plan = buildPromotionPlanV1({
      planId,
      eligibilityHash,
      scope,
      mode,
      proposedSnapshotId,
      expectedActiveSnapshotId,
      actualActiveSnapshotId,
      mappingRegistryHash: canonicalMappingRegistryHashV1(),
      projections: loaded.projections,
      priorRows,
      overlays,
    });

    const summaryOnly = hasFlag('--summary-only');
    const report = {
      ...header,
      planId: plan.planId,
      planHash: plan.planHash,
      eligibilityHash,
      mappingRegistryVersion: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
      mappingRegistryHash: plan.mappingRegistryHash,
      scope,
      promotionMode: mode,
      expectedActiveSnapshotId,
      actualActiveSnapshotId,
      proposedSnapshotId,
      planProduced: true,
      blocked: plan.blocked,
      counts: plan.counts,
      diffsByFamily: plan.diffsByFamily,
      diffsByEntity: plan.diffsByEntity,
      diffsByFiscalYear: plan.diffsByFiscalYear,
      inputs: {
        projectionCount: loaded.projections.length,
        priorRowCount: priorRows.length,
        overlayCount: overlays.length,
        activeOverlayCount: overlays.filter((overlay) => overlay.status === 'active').length,
        identitiesWithoutScopedFunding: loaded.identitiesWithoutScopedFunding,
      },
      plan: summaryOnly ? undefined : plan,
    };

    console.log(JSON.stringify(report, null, 2));
    if (plan.blocked) process.exit(3);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('plan-defense-budget-promotion-v1 FAILED:', error);
  process.exit(1);
});
