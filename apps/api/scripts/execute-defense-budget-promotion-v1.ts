/**
 * execute-defense-budget-promotion-v1 (Phase 7 Workstream N).
 *
 * The only operator path that stages and activates a canonical snapshot. Every
 * safety property it relies on lives in
 * `DefenseBudgetCanonicalPromotionServiceV1`; this command's job is to hand
 * that service a trustworthy connection and refuse to run in the shapes an
 * operator can get wrong.
 *
 *   execute-defense-budget-promotion-v1 --environment <env> --plan-id <id> \
 *     --authorization-id <id> --expected-plan-hash <sha256> \
 *     [--expected-active-snapshot-id <uuid>] [--executor-identity <id>] \
 *     [--domain <domain>] [--resume] [--commit --confirm <env>]
 *
 * Three deliberate refusals:
 *
 *   * It reads `PROMOTER_DATABASE_URL` and never falls back to
 *     `DATABASE_URL`. The promotion task has a dedicated role and secret, and
 *     silently promoting as the serve role is the exact boundary Workstream D
 *     spent a migration establishing. A missing promoter URL is a usage error,
 *     not a reason to reach for whatever else is in the environment.
 *   * It is `dry_run` unless `--commit`, matching
 *     `resume-defense-budget-promotion-side-effects-v1`.
 *   * `--commit` additionally requires `--confirm <environment>` echoing the
 *     target environment exactly. A plan id pasted against the wrong
 *     environment is the realistic operator error, and an echo is the cheapest
 *     thing that catches it.
 *
 * The plan hash is supplied and compared, never trusted: the service reloads
 * the plan from persistence and refuses if the two disagree.
 *
 * Exit codes: 0 committed or clean dry run, 3 refused, 2 usage, 1 error.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';
import {
  DefenseBudgetCanonicalPromotionServiceV1,
  type PromotionExecutionModeV1,
  type PromotionExecutionRequestV1,
} from '../src/defense-budget/promotion/canonical-promotion-service-v1.js';
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

/** The role the connection actually authenticates as, without its password. */
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
  console.error(`execute-defense-budget-promotion-v1: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const domain = argValue('--domain') ?? DEFAULT_DOMAIN;
  const environment = argValue('--environment');
  const planId = argValue('--plan-id');
  const authorizationId = argValue('--authorization-id');
  const expectedPlanHash = argValue('--expected-plan-hash');
  const expectedActiveSnapshotId = argValue('--expected-active-snapshot-id') ?? null;
  const commit = process.argv.includes('--commit');
  const resume = process.argv.includes('--resume');
  const confirm = argValue('--confirm');

  if (!environment) usage('--environment is required');
  if (!planId) usage('--plan-id is required');
  if (!authorizationId) usage('--authorization-id is required');
  if (!expectedPlanHash) usage('--expected-plan-hash is required');
  if (!/^[0-9a-f]{64}$/.test(expectedPlanHash)) {
    usage('--expected-plan-hash must be 64 lowercase hex characters');
  }
  if (commit && confirm !== environment) {
    usage(
      `--commit requires --confirm ${environment} (echo the target environment exactly); got ${confirm ?? 'nothing'}`,
    );
  }

  // Never fall back to DATABASE_URL. Promotion has its own role and secret.
  const promoterUrl = process.env.PROMOTER_DATABASE_URL;
  if (!promoterUrl) {
    usage(
      'PROMOTER_DATABASE_URL is required; this command will not promote using DATABASE_URL or any other credential',
    );
  }

  const executionMode: PromotionExecutionModeV1 = commit
    ? resume
      ? 'resume'
      : 'execute'
    : 'dry_run';
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
    mode: executionMode,
    planId,
    authorizationId,
    expectedPlanHash,
    expectedActiveSnapshotId,
    executorIdentity,
    safety:
      'Runs as the dedicated promoter role. No secrets included. Nothing is written unless mode is execute or resume.',
    generatedAt: new Date().toISOString(),
  };

  try {
    const projectionSource = new PrismaPromotionProjectionSourceV1(promoter);
    const repository = new PrismaPromotionExecutionRepositoryV1(
      promoter as unknown as PromotionPrismaLikeV1,
      projectionSource,
      async () => {
        // A session-scoped advisory lock needs its own connection: Prisma's
        // pool would hand the unlock to a different session.
        const client = new PgClient({ connectionString: promoterUrl });
        await client.connect();
        return client;
      },
    );
    const audit = new PrismaPromotionAuditSinkV1(promoter.defenseBudgetPromotionAudit);
    const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, audit, {
      now: () => new Date(),
    });

    const request: PromotionExecutionRequestV1 = {
      planId,
      authorizationId,
      expectedPlanHash,
      expectedActiveSnapshotId,
      executorIdentity,
      executionMode,
      domain,
      environment,
    };

    const result = await service.execute(request);

    console.log(
      JSON.stringify(
        {
          ...header,
          committed: result.committed,
          runId: result.runId,
          snapshotId: result.snapshotId,
          activationId: result.activationId,
          stagedRowCount: result.stagedRowCount,
          outboxRowCount: result.outboxRowCount,
          recoveredExistingActivation: result.recoveredExistingActivation,
          refusals: result.refusals,
          detail: commit
            ? undefined
            : 'dry run — re-run with --commit --confirm <environment> to stage and activate',
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
  console.error('execute-defense-budget-promotion-v1 FAILED:', error);
  process.exit(1);
});
