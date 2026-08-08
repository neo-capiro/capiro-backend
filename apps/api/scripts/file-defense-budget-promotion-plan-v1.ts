/**
 * file-defense-budget-promotion-plan-v1 (Gap 4 closeout) — the missing step
 * `plan-defense-budget-promotion-v1.ts`'s own header always said was separate:
 * "the plan is filed by a separate authorized step, not by this command."
 *
 * That step never existed. `validate`, `authorize`, and `execute` all read
 * `defense_budget_promotion_plan` expecting a row already there; every
 * rehearsal that exercises them seeded it directly with raw SQL. This is the
 * operator-facing equivalent of that seed: it takes exactly what
 * `plan-defense-budget-promotion-v1` already printed — the full plan
 * document, not a summary — recomputes the hash to prove it wasn't tampered
 * with in transit, and inserts one row.
 *
 * Deliberately narrow. It does not re-plan, does not re-derive eligibility,
 * and does not decide whether the plan is authorizable — `validate` and
 * `authorize` still do that, unchanged, against the row this creates. Filing
 * carries no promotion authority of its own: it runs under the general serve
 * role, same as `plan`, because recording what `plan` already computed is not
 * a decision about whether to promote anything.
 *
 *   file-defense-budget-promotion-plan-v1 --plan-document <plan.json> [--commit]
 *
 * `<plan.json>` accepts either the full `plan-defense-budget-promotion-v1`
 * report (reads its `.plan` field) or a bare `DefenseBudgetPromotionPlanV1`
 * object directly — `--summary-only` output has no `.plan` field and is
 * rejected with a clear message rather than a confusing parse failure.
 *
 * Without `--commit`, prints what would be inserted and writes nothing.
 *
 * Refuses a `plan_id` that already exists with a *different* plan hash —
 * re-filing the identical plan (same id, same hash) is accepted as a replay,
 * matching how every other content-addressed row in this schema behaves.
 *
 * Exit codes: 0 filed (or would file, in dry run), 3 refused, 2 usage, 1 error.
 */
import * as fs from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  promotionPlanHashV1,
  type DefenseBudgetPromotionPlanV1,
} from '../src/defense-budget/promotion/promotion-planner-v1.js';
import {
  sha256CanonicalJson,
  type JsonValue,
} from '../src/defense-budget/contracts/canonical-json.js';

dotenvConfig();

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
function usage(message: string): never {
  console.error(`file-defense-budget-promotion-plan-v1: ${message}`);
  process.exit(2);
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
  return (
    process.env.GIT_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION ??
    'UNVERIFIED'
  );
}

function loadPlan(path: string): DefenseBudgetPromotionPlanV1 {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
  const candidate = (raw.plan ?? raw) as Record<string, unknown> | undefined;
  if (
    candidate == null ||
    typeof candidate.planId !== 'string' ||
    typeof candidate.planHash !== 'string'
  ) {
    usage(
      `${path} does not contain a full plan document. Run plan-defense-budget-promotion-v1 without --summary-only.`,
    );
  }
  return candidate as unknown as DefenseBudgetPromotionPlanV1;
}

async function main(): Promise<void> {
  const planPath = argValue('--plan-document');
  if (!planPath) usage('--plan-document <plan.json> is required');
  const commit = hasFlag('--commit');

  const plan = loadPlan(planPath);
  // promotionPlanHashV1 hashes the plan as it existed the instant before
  // planHash was attached (promotion-planner-v1.ts's buildPromotionPlanV1:
  // `{ ...plan, planHash: promotionPlanHashV1(plan) }`). Its parameter type
  // says Omit<..., 'planHash'>, but that's erased at runtime — the loaded
  // `plan` here still carries the field, so it must be stripped by hand or
  // every recompute hashes a different object and never matches.
  const { planHash: _planHash, ...planWithoutHash } = plan;
  const recomputed = promotionPlanHashV1(planWithoutHash);
  if (recomputed !== plan.planHash) {
    console.log(
      JSON.stringify(
        {
          command: 'file-defense-budget-promotion-plan-v1',
          filed: false,
          reason: 'plan_hash_mismatch',
          detail: `the plan document's recomputed hash (${recomputed}) does not match its stated planHash (${plan.planHash}); it was altered after plan-defense-budget-promotion-v1 produced it`,
        },
        null,
        2,
      ),
    );
    process.exit(3);
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.$queryRawUnsafe<Array<{ planHash: string }>>(
      `SELECT "plan_hash" AS "planHash" FROM "defense_budget_promotion_plan" WHERE "plan_id" = $1`,
      plan.planId,
    );
    if (existing.length > 0 && existing[0]?.planHash !== plan.planHash) {
      console.log(
        JSON.stringify(
          {
            command: 'file-defense-budget-promotion-plan-v1',
            filed: false,
            reason: 'plan_id_conflict',
            detail: `plan id ${plan.planId} is already filed with a different hash (${existing[0]?.planHash}); a changed plan needs a new plan id`,
          },
          null,
          2,
        ),
      );
      process.exit(3);
    }

    const replay = existing.length > 0;
    const report = {
      command: 'file-defense-budget-promotion-plan-v1',
      databaseHost: databaseHost(),
      gitSha: gitSha(),
      noSecretsLogged: true,
      mode: commit ? 'commit' : 'dry_run',
      planId: plan.planId,
      planHash: plan.planHash,
      cycleId: plan.scope.cycleId,
      fiscalYear: plan.scope.fiscalYear,
      itemCount: plan.counts.total,
      blockedCount: plan.counts.blocked,
      replay,
      filed: false as boolean,
    };

    if (!commit) {
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (!replay) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "defense_budget_promotion_plan" (
           "plan_id", "plan_hash", "eligibility_hash", "mapping_registry_version",
           "mapping_registry_hash", "cycle_id", "fiscal_year", "scope", "scope_hash",
           "mode", "expected_active_snapshot_id", "proposed_snapshot_id",
           "item_count", "blocked_count", "plan_document"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::uuid, $12::uuid, $13, $14, $15::jsonb)`,
        plan.planId,
        plan.planHash,
        plan.eligibilityHash,
        plan.mappingRegistryVersion,
        plan.mappingRegistryHash,
        plan.scope.cycleId,
        plan.scope.fiscalYear,
        JSON.stringify(plan.scope),
        sha256CanonicalJson(plan.scope as unknown as JsonValue),
        plan.mode,
        plan.expectedActiveSnapshotId,
        plan.proposedSnapshotId,
        plan.counts.total,
        plan.counts.blocked,
        JSON.stringify(plan),
      );
    }

    report.filed = true;
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
