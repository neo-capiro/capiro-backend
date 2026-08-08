/**
 * persist-defense-budget-projection-plan-v1 (Phase 7 Gap 5, decision 3) — the
 * producer-side write path for a Phase 4/5/6 projection plan.
 *
 * Ownership stays with the producing phase. This verb is the shared substrate
 * all three write through, not a Phase 7 command that reaches into their
 * output: it takes a plan document a family planner already printed
 * (`build-rdte-cycle`, `plan-defense-budget-non-rdte-projection`, the Phase 6
 * cycle commands), derives everything summarizable from it, and files one
 * immutable row.
 *
 *   persist-defense-budget-projection-plan-v1 \
 *     --plan <plan.json> --family rdte \
 *     --producer-version build-rdte-cycle@<sha> \
 *     --certification-sha256 <cycle bundle or certification content sha> \
 *     [--certification-id <phase 6 certification row id>] \
 *     [--commit]
 *
 * Dry run by default. The dry run performs the whole derivation — parse,
 * summarize, classify every exclusion reason, compute the artifact-set binding
 * and the content-addressed plan ID — and only skips the INSERT, so a clean dry
 * run is real evidence.
 *
 * Runs under the serve role. Filing a plan a producer already computed carries
 * no promotion authority: the row is read-only evidence, the table is
 * append-only, and nothing canonical is touched.
 *
 * Refuses rather than defaults, in three places that matter:
 *   - an unclassified exclusion reason (a new reason must be classified as
 *     blocking or not, never assumed harmless);
 *   - a family whose plan document disagrees with `--family`;
 *   - a re-file of the same `projectionPlanId` is accepted as a replay, because
 *     the ID is content-addressed — but a *different* plan necessarily gets a
 *     different ID rather than overwriting.
 *
 * Exit codes: 0 filed or dry-run clean, 3 the plan is BLOCKED (still filed when
 * committing — a blocked plan is evidence too), 2 usage, 1 error.
 */
import * as fs from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { buildProjectionPlanRecordV1 } from '../src/defense-budget/projection-plan/projection-plan-record-v1.js';
import { PrismaProjectionPlanRepositoryV1 } from '../src/defense-budget/projection-plan/projection-plan-repository-prisma-v1.js';

dotenvConfig();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<number> {
  if (flag('promote')) {
    throw new Error(
      'this command has no promote mode; it files read-only projection evidence, and canonical ' +
        'promotion is execute-defense-budget-promotion-v1',
    );
  }

  const planPath = arg('plan');
  const family = arg('family');
  const producerVersion = arg('producer-version');
  const certificationSha256 = arg('certification-sha256');
  const certificationId = arg('certification-id') ?? null;
  if (planPath == null) throw new Error('--plan <plan.json> is required');
  if (family == null)
    throw new Error('--family <rdte|procurement|om|milcon|committee> is required');
  if (producerVersion == null) {
    throw new Error('--producer-version <identifier> is required; a plan must name what built it');
  }
  if (certificationSha256 == null) {
    throw new Error(
      '--certification-sha256 <sha> is required; a plan must bind to the certified input it was computed from',
    );
  }

  const raw: unknown = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  // Accept either a bare plan or a producer report carrying one under `.plan`,
  // matching how file-defense-budget-promotion-plan-v1 reads its input.
  const planDocument =
    raw != null && typeof raw === 'object' && 'plan' in raw ? (raw as { plan: unknown }).plan : raw;

  const record = buildProjectionPlanRecordV1({
    family,
    producerVersion,
    certificationId,
    certificationSha256,
    planDocument,
  });

  const commit = flag('commit');
  const summary = {
    projectionPlanId: record.projectionPlanId,
    family: record.family,
    cycleId: record.cycleId,
    fiscalYear: record.fiscalYear,
    contentSha256: record.contentSha256,
    artifactSetSha256: record.artifactSetSha256,
    status: record.status,
    conflictCount: record.conflictCount,
    unsupportedCount: record.unsupportedCount,
  };

  if (!commit) {
    console.log(
      JSON.stringify(
        { mode: 'dry_run', reason: 'pass --commit to file this plan', ...summary },
        null,
        2,
      ),
    );
    return record.status === 'BLOCKED' ? 3 : 0;
  }

  const prisma = new PrismaClient();
  try {
    await new PrismaProjectionPlanRepositoryV1(prisma).insert(record);
    console.log(JSON.stringify({ mode: 'filed', ...summary }, null, 2));
    return record.status === 'BLOCKED' ? 3 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
