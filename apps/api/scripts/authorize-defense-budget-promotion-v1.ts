/**
 * authorize-defense-budget-promotion-v1 (Phase 7 Workstream A/N) — the
 * eighth and final promotion verb, closed out by Gap 3
 * (docs/defense-budget/PHASE-7-ARCHITECTURE-GAPS.md).
 *
 * Issues an immutable, one-use, expiring authorization against a plan already
 * on file. Writes only `defense_budget_promotion_authorization` — through
 * `DefenseBudgetPromotionAuthorizationServiceV1`, which reloads the plan and
 * its full eligibility record from persistence rather than trusting anything
 * this command supplies about *why* a promotion is eligible. This command
 * supplies only who is authorizing, why, and for how long.
 *
 *   authorize-defense-budget-promotion-v1 \
 *     --plan-id <id> --reason "<why, for a reviewer six months from now>" \
 *     --expires-at <ISO 8601> --authorizer-actor-id <id> \
 *     --authorizer-roles capiro_admin[,other_role] \
 *     [--authorization-id <id>] [--change-request-reference <ref>]
 *
 * `--authorization-id` defaults to a value deterministic in the plan ID and
 * authorizer, so a retried identical request recognizes the existing
 * authorization (`authorization_already_exists`) rather than silently
 * succeeding twice with two different IDs for the same intent.
 *
 * Runs under the general API serve role (`DATABASE_URL`), matching
 * `DefenseBudgetPromotionAuthorizationServiceV1`'s own documented boundary:
 * its only persistence surface is `loadPlan`/`findAuthorizationById`/
 * `insertAuthorization` — no snapshot, run, activation, outbox, or canonical
 * row method exists on the port, so no misuse here can reach them. Database
 * grants enforce the same boundary independently (`capiro_app` cannot write a
 * canonical row regardless of what this process does).
 *
 * Exit codes: 0 issued, 3 refused, 2 usage, 1 error.
 */
import { createHash } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { DefenseBudgetPromotionAuthorizationServiceV1 } from '../src/defense-budget/promotion/promotion-authorization-service-v1.js';
import { PrismaPromotionAuthorizationRepositoryV1 } from '../src/defense-budget/promotion/promotion-eligibility-authorization-repository-prisma-v1.js';
import { PrismaPromotionAuditSinkV1 } from '../src/defense-budget/promotion/promotion-eligibility-service-v1.js';

dotenvConfig();

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
  return (
    process.env.GIT_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION ??
    'UNVERIFIED'
  );
}

function usage(message: string): never {
  console.error(`authorize-defense-budget-promotion-v1: ${message}`);
  process.exit(2);
}

function deterministicAuthorizationIdV1(
  planId: string,
  authorizerActorId: string,
  reason: string,
): string {
  return `auth_${createHash('sha256').update(`${planId}:${authorizerActorId}:${reason}`).digest('hex').slice(0, 24)}`;
}

async function main(): Promise<void> {
  const planId = argValue('--plan-id');
  const reason = argValue('--reason');
  const expiresAt = argValue('--expires-at');
  const authorizerActorId = argValue('--authorizer-actor-id');
  const authorizerRolesRaw = argValue('--authorizer-roles');
  const changeRequestReference = argValue('--change-request-reference');

  if (!planId) usage('--plan-id is required');
  if (!reason) usage('--reason is required');
  if (!expiresAt) usage('--expires-at is required');
  if (!authorizerActorId) usage('--authorizer-actor-id is required');
  if (!authorizerRolesRaw) usage('--authorizer-roles is required');

  const authorizerRoles = authorizerRolesRaw
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  const authorizationId =
    argValue('--authorization-id') ??
    deterministicAuthorizationIdV1(planId, authorizerActorId, reason);

  const header = {
    command: 'authorize-defense-budget-promotion-v1',
    databaseHost: databaseHost(),
    gitSha: gitSha(),
    noSecretsLogged: true,
    authorizationId,
  };

  const prisma = new PrismaClient();
  try {
    const repository = new PrismaPromotionAuthorizationRepositoryV1(prisma);
    const audit = new PrismaPromotionAuditSinkV1(prisma.defenseBudgetPromotionAudit);
    const service = new DefenseBudgetPromotionAuthorizationServiceV1(repository, audit, {
      now: () => new Date(),
    });

    const result = await service.issue({
      planId,
      reason,
      expiresAt,
      authorizerActorId,
      authorizerRoles,
      authorizationId,
      ...(changeRequestReference != null ? { changeRequestReference } : {}),
    });

    // Exactly one JSON blob on stdout, matching every other Phase 7 CLI
    // (plan/validate/status): the safety-statement header merged into the
    // same object as the result, never printed as two separate console.log
    // calls — a caller parsing stdout as one JSON document must see one.
    console.log(JSON.stringify({ ...header, ...result }, null, 2));
    process.exit(result.issued ? 0 : 3);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
