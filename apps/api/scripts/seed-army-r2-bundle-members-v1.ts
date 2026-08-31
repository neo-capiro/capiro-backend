/**
 * Phase 10B-19 Part N — seed the FY2024 Army R-2 bundle member manifest.
 *
 * Creates the ten `DefenseBudgetSourceBundleMember` rows from
 * `ARMY_RDTE_VOLUME_CATALOG` (@capiro/defense-domain) under ONE existing
 * `DefenseBudgetExpectedSource` row. Never marks a member observed/verified,
 * never touches `expected_state`, and never overwrites an already-seeded
 * member's status/binding on a re-run (idempotent by `member_key`).
 *
 * Fail-closed identity check: refuses to seed unless the named expected
 * source's own fiscalYear/authorityTrack/stage/sourceFamily/component
 * exactly match what every catalog entry declares — belt-and-suspenders on
 * top of the DB trigger (`defense_budget_source_bundle_member_identity_chk`)
 * that would otherwise reject each individual INSERT anyway; failing here
 * means zero partial-seed state instead of N-1 succeeding before the Nth
 * insert throws.
 *
 * Dry-run by default. Mutation requires BOTH --commit and
 * --confirm <environment>, matching every other trust-critical verb in this
 * codebase's entrypoint.sh.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { checkArmyR2ExpectedSourceIdentity, buildArmyR2SeedPlan } from '../src/defense-budget/governed-import/army-r2-seed-plan.js';

dotenvConfig();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
function usage(message: string): never {
  console.error(`seed-army-r2-bundle-members-v1: ${message}`);
  console.error(
    'usage: seed-army-r2-bundle-members-v1 --environment <env> --expected-source-id <uuid> [--commit --confirm <env>]',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const environment = argValue('--environment');
  if (!environment) usage('--environment is required');
  const expectedSourceId = argValue('--expected-source-id');
  if (!expectedSourceId) usage('--expected-source-id is required');

  const commit = hasFlag('--commit');
  const confirm = argValue('--confirm');
  if (commit && confirm !== environment) {
    usage(`--commit requires --confirm ${environment} (the exact --environment value, typed out)`);
  }

  const prisma = new PrismaClient();
  try {
    const expectedSource = await prisma.defenseBudgetExpectedSource.findUnique({
      where: { id: expectedSourceId },
    });
    if (!expectedSource) {
      console.error(JSON.stringify({ error: `expected source ${expectedSourceId} does not exist` }, null, 2));
      process.exitCode = 1;
      return;
    }

    // Fail-closed identity check (Part C, "critical"): every catalog entry is
    // FY2024/request/president_budget_request/pb_r2/ARMY. Refuse the WHOLE
    // seed if the named expected source is not exactly that — no partial
    // seed, no reliance on the DB trigger alone.
    const mismatches = checkArmyR2ExpectedSourceIdentity({
      fiscalYear: expectedSource.fiscalYear,
      authorityTrack: expectedSource.authorityTrack,
      stage: expectedSource.stage,
      sourceFamily: expectedSource.sourceFamily,
      component: expectedSource.component,
    });
    if (mismatches.length > 0) {
      console.error(
        JSON.stringify(
          { error: `expected source ${expectedSourceId} does not match the Army FY24 R-2 identity`, mismatches },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }

    const existing = await prisma.defenseBudgetSourceBundleMember.findMany({
      where: { expectedSourceId },
      select: { memberKey: true, memberStatus: true },
    });
    const existingByKey = new Map(existing.map((m) => [m.memberKey, m.memberStatus]));
    const plan = buildArmyR2SeedPlan({ fiscalYear: expectedSource.fiscalYear, existingMemberKeys: existingByKey });
    const toCreate = plan.filter((p) => !p.alreadyExists);

    if (!commit) {
      console.log(
        JSON.stringify(
          {
            safety: 'DRY RUN — no database mutation occurred.',
            environment,
            expectedSourceId,
            expectedSourceState: expectedSource.expectedState,
            requiredMemberCount: plan.filter((p) => p.required).length,
            optionalMemberCount: plan.filter((p) => !p.required).length,
            alreadySeededCount: plan.length - toCreate.length,
            wouldCreateCount: toCreate.length,
            plan,
          },
          null,
          2,
        ),
      );
      return;
    }

    for (const member of toCreate) {
      await prisma.defenseBudgetSourceBundleMember.create({
        data: {
          expectedSourceId,
          memberKey: member.memberKey,
          volume: member.volume,
          budgetActivity: member.budgetActivity,
          officialUrl: member.officialUrl,
          title: member.title,
          required: member.required,
          memberStatus: 'missing',
          expectedFiscalYear: expectedSource.fiscalYear,
          expectedAuthorityTrack: expectedSource.authorityTrack,
          expectedStage: expectedSource.stage,
          expectedSourceFamily: expectedSource.sourceFamily,
          expectedComponent: expectedSource.component,
        },
      });
    }

    const after = await prisma.defenseBudgetSourceBundleMember.findMany({
      where: { expectedSourceId },
      select: { memberKey: true, required: true, memberStatus: true },
    });
    const afterExpectedSource = await prisma.defenseBudgetExpectedSource.findUnique({
      where: { id: expectedSourceId },
      select: { expectedState: true },
    });

    console.log(
      JSON.stringify(
        {
          safety: 'Committed. Every created member is memberStatus=missing; expected_state was never written by this command.',
          environment,
          expectedSourceId,
          createdCount: toCreate.length,
          createdKeys: toCreate.map((m) => m.memberKey),
          totalMemberCount: after.length,
          requiredCount: after.filter((m) => m.required).length,
          verifiedCount: after.filter((m) => m.memberStatus === 'verified').length,
          observedCount: after.filter((m) => m.memberStatus === 'observed').length,
          missingCount: after.filter((m) => m.memberStatus === 'missing').length,
          expectedSourceStateBefore: expectedSource.expectedState,
          expectedSourceStateAfter: afterExpectedSource?.expectedState ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('seed-army-r2-bundle-members-v1 FAILED:', error);
  process.exit(1);
});
