/**
 * rollback-defense-budget-snapshot-v1 (Phase 7 Workstream N).
 *
 * Reactivates a prior immutable snapshot. Rollback is a forward audited
 * pointer transition, never a deletion: both the failed snapshot and the one
 * being restored survive, and the rollback is itself recorded.
 *
 *   rollback-defense-budget-snapshot-v1 --environment <env> \
 *     --to-snapshot-id <uuid> --authorization-id <id> --reason "<why>" \
 *     [--executor-identity <id>] [--domain <domain>] [--commit --confirm <env>]
 *
 * Like `execute`, it reads `PROMOTER_DATABASE_URL` and never falls back to
 * `DATABASE_URL`, is a dry run unless `--commit`, and requires `--confirm`
 * echoing the environment. Rollback needs its own authorization — the one that
 * authorized the promotion being undone does not authorize undoing it.
 *
 * The service pauses the side-effect drain as part of rolling back;
 * `resume-defense-budget-promotion-side-effects-v1` is how it starts again.
 *
 * Exit codes: 0 rolled back or clean dry run, 3 refused, 2 usage, 1 error.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';
import { DefenseBudgetCanonicalPromotionServiceV1 } from '../src/defense-budget/promotion/canonical-promotion-service-v1.js';
import {
  PrismaPromotionExecutionRepositoryV1,
  type PromotionPrismaLikeV1,
} from '../src/defense-budget/promotion/canonical-promotion-repository-prisma-v1.js';
import { PrismaPromotionProjectionSourceV1 } from '../src/defense-budget/promotion/promotion-projection-source-prisma-v1.js';
import { PrismaPromotionAuditSinkV1 } from '../src/defense-budget/promotion/promotion-eligibility-service-v1.js';

dotenvConfig();

const DEFAULT_DOMAIN = 'defense_budget';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function databaseHost(url: string | undefined): string {
  if (!url) return 'UNAVAILABLE';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${parsed.pathname.replace(/^\//, '')}`;
  } catch {
    return 'UNPARSEABLE_DATABASE_URL';
  }
}

function databaseRole(url: string | undefined): string {
  if (!url) return 'UNAVAILABLE';
  try {
    return new URL(url).username || 'UNSPECIFIED';
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

function usage(message: string): never {
  console.error(`rollback-defense-budget-snapshot-v1: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const domain = argValue('--domain') ?? DEFAULT_DOMAIN;
  const environment = argValue('--environment');
  const toSnapshotId = argValue('--to-snapshot-id');
  const authorizationId = argValue('--authorization-id');
  const reason = argValue('--reason');
  const commit = process.argv.includes('--commit');
  const confirm = argValue('--confirm');

  if (!environment) usage('--environment is required');
  if (!toSnapshotId) usage('--to-snapshot-id is required');
  if (!authorizationId) usage('--authorization-id is required');
  if (!reason) usage('--reason is required; a rollback with no recorded reason is not auditable');
  if (commit && confirm !== environment) {
    usage(
      `--commit requires --confirm ${environment} (echo the target environment exactly); got ${confirm ?? 'nothing'}`,
    );
  }

  const promoterUrl = process.env.PROMOTER_DATABASE_URL;
  if (!promoterUrl) {
    usage(
      'PROMOTER_DATABASE_URL is required; this command will not move the active pointer using DATABASE_URL or any other credential',
    );
  }

  const executorIdentity =
    argValue('--executor-identity') ??
    process.env.ECS_TASK_ARN ??
    `operator:${process.env.USER ?? process.env.USERNAME ?? 'unknown'}`;

  const promoter = new PrismaClient({ datasources: { db: { url: promoterUrl } } });

  const header = {
    environment,
    domain,
    databaseHost: databaseHost(promoterUrl),
    databaseRole: databaseRole(promoterUrl),
    gitSha: gitSha(),
    mode: commit ? 'rollback' : 'dry_run',
    toSnapshotId,
    authorizationId,
    reason,
    executorIdentity,
    safety:
      'Runs as the dedicated promoter role. Deletes nothing: both snapshots survive. No secrets included.',
    generatedAt: new Date().toISOString(),
  };

  try {
    /* ---- Read the current pointer and the target, for both modes ---- */

    const activeRows = await promoter.$queryRawUnsafe<Array<{ snapshotId: string }>>(
      `SELECT "snapshot_id" AS "snapshotId"
         FROM "defense_budget_active_snapshot"
        WHERE "domain" = $1 AND "environment" = $2`,
      domain,
      environment,
    );
    const currentActiveSnapshotId = activeRows[0]?.snapshotId ?? null;

    const targetRows = await promoter.$queryRawUnsafe<
      Array<{ status: string; environment: string; snapshotHash: string | null }>
    >(
      `SELECT "status", "environment", "snapshot_hash" AS "snapshotHash"
         FROM "defense_budget_canonical_snapshot"
        WHERE "id" = $1::uuid`,
      toSnapshotId,
    );
    const target = targetRows[0] ?? null;

    if (!commit) {
      console.log(
        JSON.stringify(
          {
            ...header,
            rolledBack: false,
            currentActiveSnapshotId,
            targetSnapshot: target,
            detail:
              target == null
                ? 'dry run — the target snapshot does not exist; rollback would refuse'
                : 'dry run — re-run with --commit --confirm <environment> to move the pointer',
          },
          null,
          2,
        ),
      );
      if (target == null) process.exit(3);
      return;
    }

    const projectionSource = new PrismaPromotionProjectionSourceV1(promoter);
    const repository = new PrismaPromotionExecutionRepositoryV1(
      promoter as unknown as PromotionPrismaLikeV1,
      projectionSource,
      async () => {
        const client = new PgClient({ connectionString: promoterUrl });
        await client.connect();
        return client;
      },
    );
    const audit = new PrismaPromotionAuditSinkV1(promoter.defenseBudgetPromotionAudit);
    const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, audit, {
      now: () => new Date(),
    });

    const result = await service.rollback({
      toSnapshotId,
      authorizationId,
      executorIdentity,
      environment,
      domain,
      reason,
    });

    console.log(
      JSON.stringify(
        {
          ...header,
          rolledBack: result.committed,
          previousActiveSnapshotId: currentActiveSnapshotId,
          runId: result.runId,
          snapshotId: result.snapshotId,
          activationId: result.activationId,
          outboxRowCount: result.outboxRowCount,
          refusals: result.refusals,
          nextStep: result.committed
            ? 'the side-effect drain is paused; resume-defense-budget-promotion-side-effects-v1 restarts it'
            : undefined,
        },
        null,
        2,
      ),
    );

    if (result.refusals.length > 0) process.exit(3);
  } finally {
    await promoter.$disconnect();
  }
}

void main().catch((error) => {
  console.error('rollback-defense-budget-snapshot-v1 FAILED:', error);
  process.exit(1);
});
