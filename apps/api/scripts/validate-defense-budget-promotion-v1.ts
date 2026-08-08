/**
 * validate-defense-budget-promotion-v1 (Phase 7 Workstream N) — read-only.
 *
 * Re-checks an already-filed promotion plan against current persistence, so an
 * operator can tell whether an authorization would still be safe to issue. It
 * reloads the plan document from `defense_budget_promotion_plan` and proves the
 * stored hash still describes it, that the mapping registry has not moved under
 * it, that nothing is blocked, and that the snapshot pointer it expects is
 * still the one that is active.
 *
 *   validate-defense-budget-promotion-v1 --environment <env> --plan-id <id>
 *                                        [--domain <domain>]
 *
 * Issues no write statement. Exit codes: 0 valid, 3 invalid, 2 usage, 1 error.
 *
 * Plan's required command output: environment, DB host fingerprint (no
 * password), Git SHA, mode, and an explicit no-secret statement.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  promotionPlanHashV1,
  type DefenseBudgetPromotionPlanV1,
} from '../src/defense-budget/promotion/promotion-planner-v1.js';
import {
  canonicalMappingRegistryHashV1,
  DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
} from '../src/defense-budget/promotion/canonical-mapping-registry-v1.js';

dotenvConfig();

const DEFAULT_DOMAIN = 'defense_budget';

/** A snapshot a plan may still legitimately be staged into. */
const STAGEABLE_SNAPSHOT_STATUSES = new Set(['STAGING', 'READY']);

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
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

/**
 * `blocking` failures mean the plan must not be authorized as it stands.
 * `advisory` failures are reportable facts that do not by themselves invalidate
 * the plan — a plan that has not been authorized yet is the normal case when
 * this command runs, so a missing authorization cannot be blocking.
 */
interface CheckResultV1 {
  check: string;
  severity: 'blocking' | 'advisory';
  ok: boolean;
  detail: string;
}

interface PlanRowV1 {
  planId: string;
  planHash: string;
  eligibilityHash: string;
  mappingRegistryVersion: string;
  mappingRegistryHash: string;
  cycleId: string;
  fiscalYear: number;
  mode: string;
  expectedActiveSnapshotId: string | null;
  proposedSnapshotId: string;
  itemCount: number;
  blockedCount: number;
  planDocument: unknown;
  createdAt: Date;
}

interface SnapshotRowV1 {
  status: string;
  environment: string;
  activatedAt: Date | null;
  supersededAt: Date | null;
}

interface AuthorizationRowV1 {
  authorizationId: string;
  planHash: string;
  expectedActiveSnapshotId: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

async function main(): Promise<void> {
  const domain = argValue('--domain') ?? DEFAULT_DOMAIN;
  const environment = argValue('--environment');
  const planId = argValue('--plan-id');
  if (!environment || !planId) {
    console.error(
      'validate-defense-budget-promotion-v1: --environment and --plan-id are both required',
    );
    process.exit(2);
  }

  const prisma = new PrismaClient();
  const checks: CheckResultV1[] = [];
  const record = (
    check: string,
    severity: CheckResultV1['severity'],
    ok: boolean,
    detail: string,
  ): void => {
    checks.push({ check, severity, ok, detail });
  };

  try {
    const planRows = await prisma.$queryRawUnsafe<PlanRowV1[]>(
      `SELECT "plan_id" AS "planId", "plan_hash" AS "planHash",
              "eligibility_hash" AS "eligibilityHash",
              "mapping_registry_version" AS "mappingRegistryVersion",
              "mapping_registry_hash" AS "mappingRegistryHash",
              "cycle_id" AS "cycleId", "fiscal_year" AS "fiscalYear", "mode",
              "expected_active_snapshot_id" AS "expectedActiveSnapshotId",
              "proposed_snapshot_id" AS "proposedSnapshotId",
              "item_count" AS "itemCount", "blocked_count" AS "blockedCount",
              "plan_document" AS "planDocument", "created_at" AS "createdAt"
         FROM "defense_budget_promotion_plan"
        WHERE "plan_id" = $1`,
      planId,
    );

    const planRow = planRows[0];
    if (planRow == null) {
      const report = {
        environment,
        domain,
        databaseHost: databaseHost(),
        gitSha: gitSha(),
        mode: 'validate',
        safety: 'Read-only. No write statement issued. No secrets included.',
        generatedAt: new Date().toISOString(),
        planId,
        valid: false,
        checks: [
          {
            check: 'plan_exists',
            severity: 'blocking' as const,
            ok: false,
            detail: `no promotion plan is filed under plan_id ${planId}`,
          },
        ],
      };
      console.log(JSON.stringify(report, null, 2));
      process.exit(3);
    }

    record('plan_exists', 'blocking', true, `plan ${planId} loaded`);

    /* ---- 1. The stored hash still describes the stored document ---- */

    const planDocument = planRow.planDocument as DefenseBudgetPromotionPlanV1 | null;
    let recomputedHash: string | null = null;
    if (planDocument == null || typeof planDocument !== 'object') {
      record('plan_document_readable', 'blocking', false, 'plan_document is not a JSON object');
    } else {
      record('plan_document_readable', 'blocking', true, 'plan_document parsed');
      const { planHash: _stored, ...withoutHash } = planDocument;
      recomputedHash = promotionPlanHashV1(withoutHash);
      record(
        'plan_hash_matches_document',
        'blocking',
        recomputedHash === planRow.planHash && planDocument.planHash === planRow.planHash,
        recomputedHash === planRow.planHash && planDocument.planHash === planRow.planHash
          ? `plan hash ${planRow.planHash} reproduces from the stored document`
          : `stored plan_hash ${planRow.planHash} does not reproduce (recomputed ${recomputedHash}, document says ${planDocument.planHash})`,
      );

      /* ---- 2. The row's summary counts still agree with the document ---- */

      const countsAgree =
        Number(planRow.itemCount) === planDocument.counts.total &&
        Number(planRow.blockedCount) === planDocument.counts.blocked;
      record(
        'counts_match_document',
        'blocking',
        countsAgree,
        countsAgree
          ? `item_count ${planRow.itemCount} / blocked_count ${planRow.blockedCount} agree with the document`
          : `row says ${planRow.itemCount}/${planRow.blockedCount}, document says ${planDocument.counts.total}/${planDocument.counts.blocked}`,
      );

      /* ---- 3. Nothing is blocked ---- */

      record(
        'no_blocked_items',
        'blocking',
        planDocument.counts.blocked === 0,
        planDocument.counts.blocked === 0
          ? 'no blocked items'
          : `${planDocument.counts.blocked} blocked item(s); promotion cannot proceed for this scope`,
      );

      /* ---- 4. The mapping registry has not moved under the plan ---- */

      const currentRegistryHash = canonicalMappingRegistryHashV1();
      const registryCurrent =
        planDocument.mappingRegistryHash === currentRegistryHash &&
        planRow.mappingRegistryVersion === DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION;
      record(
        'mapping_registry_current',
        'blocking',
        registryCurrent,
        registryCurrent
          ? `mapping registry ${planRow.mappingRegistryVersion} / ${currentRegistryHash} unchanged`
          : `plan was built against registry ${planRow.mappingRegistryVersion} / ${planDocument.mappingRegistryHash}; this build carries ${DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION} / ${currentRegistryHash} — the plan must be rebuilt`,
      );
    }

    /* ---- 5. The active pointer the plan expects is still the active one ---- */

    const activeRows = await prisma.$queryRawUnsafe<Array<{ snapshotId: string }>>(
      `SELECT "snapshot_id" AS "snapshotId"
         FROM "defense_budget_active_snapshot"
        WHERE "domain" = $1 AND "environment" = $2`,
      domain,
      environment,
    );
    const actualActiveSnapshotId = activeRows[0]?.snapshotId ?? null;
    const expected = planRow.expectedActiveSnapshotId;
    const pointerMatches = expected === actualActiveSnapshotId;
    record(
      'expected_active_snapshot_current',
      'blocking',
      pointerMatches,
      pointerMatches
        ? `active snapshot is ${actualActiveSnapshotId ?? 'none'}, as the plan expects`
        : `plan expects active snapshot ${expected ?? 'none'} but ${actualActiveSnapshotId ?? 'none'} is active — the plan's diff was computed against rows that are no longer current`,
    );

    /* ---- 6. The proposed snapshot is still stageable ---- */

    const snapshotRows = await prisma.$queryRawUnsafe<SnapshotRowV1[]>(
      `SELECT "status", "environment", "activated_at" AS "activatedAt",
              "superseded_at" AS "supersededAt"
         FROM "defense_budget_canonical_snapshot"
        WHERE "id" = $1::uuid`,
      planRow.proposedSnapshotId,
    );
    const snapshot = snapshotRows[0];
    if (snapshot == null) {
      // Not yet created is the normal pre-staging state, not a defect.
      record(
        'proposed_snapshot_stageable',
        'advisory',
        true,
        `proposed snapshot ${planRow.proposedSnapshotId} does not exist yet; execution will create it`,
      );
    } else {
      const stageable = STAGEABLE_SNAPSHOT_STATUSES.has(snapshot.status);
      record(
        'proposed_snapshot_stageable',
        'blocking',
        stageable,
        stageable
          ? `proposed snapshot ${planRow.proposedSnapshotId} is ${snapshot.status}`
          : `proposed snapshot ${planRow.proposedSnapshotId} is ${snapshot.status}; this plan has already been executed or retired`,
      );
      const environmentMatches = snapshot.environment === environment;
      record(
        'proposed_snapshot_environment',
        'blocking',
        environmentMatches,
        environmentMatches
          ? `snapshot belongs to environment ${environment}`
          : `snapshot belongs to environment ${snapshot.environment}, not ${environment}`,
      );
    }

    /* ---- 7. Authorizations, if any have been issued ---- */

    const authorizationRows = await prisma.$queryRawUnsafe<AuthorizationRowV1[]>(
      `SELECT "authorization_id" AS "authorizationId", "plan_hash" AS "planHash",
              "expected_active_snapshot_id" AS "expectedActiveSnapshotId",
              "expires_at" AS "expiresAt", "consumed_at" AS "consumedAt"
         FROM "defense_budget_promotion_authorization"
        WHERE "plan_id" = $1
        ORDER BY "issued_at"`,
      planId,
    );

    if (authorizationRows.length === 0) {
      record(
        'authorization_binding',
        'advisory',
        true,
        'no authorization issued yet; validate normally runs before authorize',
      );
    } else {
      // An authorization that names a different plan hash is a real defect: it
      // would redeem against content the authorizer never saw.
      const mismatched = authorizationRows.filter((row) => row.planHash !== planRow.planHash);
      record(
        'authorization_binding',
        'blocking',
        mismatched.length === 0,
        mismatched.length === 0
          ? `${authorizationRows.length} authorization(s) all bind plan hash ${planRow.planHash}`
          : `${mismatched.length} authorization(s) bind a different plan hash: ${mismatched.map((row) => `${row.authorizationId}->${row.planHash}`).join(', ')}`,
      );

      const now = Date.now();
      const usable = authorizationRows.filter(
        (row) =>
          row.consumedAt == null &&
          new Date(row.expiresAt).getTime() > now &&
          row.planHash === planRow.planHash,
      );
      record(
        'authorization_usable',
        'advisory',
        usable.length > 0,
        usable.length > 0
          ? `${usable.length} unconsumed, unexpired authorization(s): ${usable.map((row) => row.authorizationId).join(', ')}`
          : 'every issued authorization is consumed or expired; a new one is required to execute',
      );
    }

    const blockingFailures = checks.filter((entry) => entry.severity === 'blocking' && !entry.ok);
    const valid = blockingFailures.length === 0;

    const report = {
      environment,
      domain,
      databaseHost: databaseHost(),
      gitSha: gitSha(),
      mode: 'validate',
      safety: 'Read-only. No write statement issued. No secrets included.',
      generatedAt: new Date().toISOString(),
      planId: planRow.planId,
      planHash: planRow.planHash,
      recomputedPlanHash: recomputedHash,
      eligibilityHash: planRow.eligibilityHash,
      cycleId: planRow.cycleId,
      fiscalYear: Number(planRow.fiscalYear),
      promotionMode: planRow.mode,
      expectedActiveSnapshotId: planRow.expectedActiveSnapshotId,
      actualActiveSnapshotId,
      proposedSnapshotId: planRow.proposedSnapshotId,
      itemCount: Number(planRow.itemCount),
      blockedCount: Number(planRow.blockedCount),
      planFiledAt: planRow.createdAt,
      valid,
      blockingFailureCount: blockingFailures.length,
      checks,
    };

    console.log(JSON.stringify(report, null, 2));
    if (!valid) process.exit(3);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('validate-defense-budget-promotion-v1 FAILED:', error);
  process.exit(1);
});
