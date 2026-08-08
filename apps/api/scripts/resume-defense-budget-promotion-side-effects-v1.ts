/**
 * resume-defense-budget-promotion-side-effects-v1 (Phase 7 Workstream N).
 *
 * Closes the gap the session-6 handoff flagged: a rollback now genuinely
 * pauses the side-effect drain (`pauseSideEffectDrain`, wired to a real table
 * in Workstream L), and nothing in the product could resume it — the only
 * supported path was `resumeDrainV1` called directly, or one hand-written SQL
 * statement. This is that command, made operable.
 *
 * Writes exactly one thing: the pause row's `paused=false`. Never touches a
 * canonical row, a snapshot, or an activation — resuming side effects is not
 * a promotion action, and this command does not use the promoter role.
 *
 *   resume-defense-budget-promotion-side-effects-v1 --environment <env> \
 *     --actor <actor-id> --reason "<why>" [--domain <domain>] [--commit]
 *
 * Dry-run by default (reports whether a resume would apply); --commit writes.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  isDrainPausedV1,
  resumeDrainV1,
} from '../src/defense-budget/promotion/side-effect-drain-pause-prisma-v1.js';

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
  const actor = argValue('--actor');
  const reason = argValue('--reason');
  const commit = process.argv.includes('--commit');

  if (!environment || !actor || !reason) {
    console.error(
      'resume-defense-budget-promotion-side-effects-v1: --environment, --actor, and --reason are all required',
    );
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const delegate = prisma.defenseBudgetSideEffectDrainPause;
    const pausedBefore = await isDrainPausedV1(delegate, domain, environment);

    const header = {
      environment,
      domain,
      databaseHost: databaseHost(),
      gitSha: gitSha(),
      mode: commit ? 'execute' : 'dry_run',
      safety: "Writes only this scope's drain-pause row. No secrets included.",
      generatedAt: new Date().toISOString(),
      pausedBefore,
    };

    if (!pausedBefore) {
      console.log(
        JSON.stringify(
          { ...header, resumed: false, detail: 'not paused — nothing to resume' },
          null,
          2,
        ),
      );
      return;
    }

    if (!commit) {
      console.log(
        JSON.stringify(
          {
            ...header,
            resumed: false,
            detail: 'dry run — re-run with --commit to resume the drain',
          },
          null,
          2,
        ),
      );
      return;
    }

    const result = await resumeDrainV1(delegate, { domain, environment, resumedBy: actor });
    console.log(JSON.stringify({ ...header, ...result, reason }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('resume-defense-budget-promotion-side-effects-v1 FAILED:', error);
  process.exit(1);
});
