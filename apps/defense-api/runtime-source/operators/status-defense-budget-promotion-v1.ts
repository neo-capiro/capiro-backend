/**
 * status-defense-budget-promotion-v1 (Phase 7 Workstream N) — read-only.
 *
 * Reports the current promotion state for a domain/environment: the active
 * snapshot pointer, whether the side-effect drain is paused (and why), and the
 * promotion outbox backlog by status. Issues no write statement.
 *
 *   status-defense-budget-promotion-v1 [--environment <env>] [--domain <domain>]
 *
 * Plan's required command output: environment, DB host fingerprint (no
 * password), Git SHA, mode, and an explicit no-secret statement.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  ConsoleSloMetricSinkV1,
  SloMetricRecorderV1,
} from '../src/defense-budget/promotion/slo-metrics-v1.js';

dotenvConfig();

const DEFAULT_DOMAIN = 'defense_budget';

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
  // Same rule as diag-program-element-trust-baseline.ts: the ECS
  // container-metadata URI is never a fallback — its last path segment is a
  // container id, not a reviewable commit.
  return (
    process.env.GIT_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.CODEBUILD_RESOLVED_SOURCE_VERSION ??
    'UNVERIFIED'
  );
}

async function main(): Promise<void> {
  const domain = argValue('--domain') ?? DEFAULT_DOMAIN;
  const environment = argValue('--environment');
  if (!environment) {
    console.error('status-defense-budget-promotion-v1: --environment is required');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const active = await prisma.$queryRawUnsafe<
      Array<{
        snapshotId: string;
        status: string;
        activatedAt: Date | null;
        snapshotHash: string | null;
      }>
    >(
      `SELECT s."id" AS "snapshotId", s."status", s."activated_at" AS "activatedAt",
              s."snapshot_hash" AS "snapshotHash"
         FROM "defense_budget_active_snapshot" p
         JOIN "defense_budget_canonical_snapshot" s ON s."id" = p."snapshot_id"
        WHERE p."domain" = $1 AND p."environment" = $2`,
      domain,
      environment,
    );

    const pause = await prisma.$queryRawUnsafe<
      Array<{
        paused: boolean;
        reason: string | null;
        pausedBy: string | null;
        pausedAt: Date | null;
      }>
    >(
      `SELECT "paused", "reason", "paused_by" AS "pausedBy", "paused_at" AS "pausedAt"
         FROM "defense_budget_side_effect_drain_pause"
        WHERE "domain" = $1 AND "environment" = $2`,
      domain,
      environment,
    );

    // Scoped to this domain/environment's active snapshot's outbox rows —
    // an outbox row's activation always points at an activation for this
    // scope, so joining through activation keeps the backlog count honest
    // even across a rollback (which points the outbox at a different
    // snapshot lineage than "the currently active one" alone would show).
    const backlog = await prisma.$queryRawUnsafe<Array<{ status: string; count: bigint }>>(
      `SELECT o."status", count(*)::bigint AS "count"
         FROM "defense_budget_promotion_outbox" o
         JOIN "defense_budget_promotion_activation" a ON a."id" = o."activation_id"
        WHERE a."environment" = $1
        GROUP BY o."status"
        ORDER BY o."status"`,
      environment,
    );

    // Phase 7 Gap 5 decision C — `promotion_outbox_backlog_age_ms`.
    //
    // Age of the *oldest undrained* row, not the count: a backlog of ten rows
    // that is four hours old is an incident, and a backlog of ten thousand rows
    // that is nine seconds old is a healthy burst. Only PENDING and FAILED
    // count as undrained. DONE has left, and POISON is deliberately excluded —
    // a quarantined row ages forever by design, and folding it in would peg
    // this metric permanently at the age of the oldest poison row, which is
    // exactly the alarm-fatigue shape that makes an operator stop reading it.
    // POISON has its own signal in the by-status counts above.
    //
    // Scoped through the same activation join as the counts, for the reason
    // stated there.
    const backlogAge = await prisma.$queryRawUnsafe<Array<{ ageMs: number | null }>>(
      `SELECT COALESCE(
                EXTRACT(EPOCH FROM (now() - MIN(o."created_at"))) * 1000,
                0
              )::double precision AS "ageMs"
         FROM "defense_budget_promotion_outbox" o
         JOIN "defense_budget_promotion_activation" a ON a."id" = o."activation_id"
        WHERE a."environment" = $1
          AND o."status" IN ('PENDING', 'FAILED')`,
      environment,
    );
    const outboxBacklogAgeMs = Number(backlogAge[0]?.ageMs ?? 0);

    // The console sink is the right one here and nowhere near a decision about
    // a production metrics backend: this verb is run by an operator who is
    // already reading its stdout, so the emission lands beside the report it
    // describes.
    new SloMetricRecorderV1({ sink: new ConsoleSloMetricSinkV1(), now: () => new Date() }).record(
      'promotion_outbox_backlog_age_ms',
      outboxBacklogAgeMs,
      { domain, environment },
    );

    const report = {
      environment,
      domain,
      databaseHost: databaseHost(),
      gitSha: gitSha(),
      mode: 'status',
      safety: 'Read-only. No write statement issued. No secrets included.',
      generatedAt: new Date().toISOString(),
      activeSnapshot: active[0] ?? null,
      sideEffectDrain: pause[0] ?? { paused: false, reason: null, pausedBy: null, pausedAt: null },
      outboxBacklogByStatus: Object.fromEntries(
        backlog.map((row) => [row.status, Number(row.count)]),
      ),
      outboxBacklogAgeMs,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('status-defense-budget-promotion-v1 FAILED:', error);
  process.exit(1);
});
