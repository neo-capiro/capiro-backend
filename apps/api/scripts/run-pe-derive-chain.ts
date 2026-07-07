/**
 * run-pe-derive-chain — nightly PE derive DAG (PE Watch auto-update plan, Phase 0;
 * docs/plans/2026-07-06-pe-watch-auto-update-plan.md).
 *
 * Runs the money-graph derivations in dependency order (BL-0 DAG), sequentially,
 * aborting on the first failure so a later step never reads a partially-failed
 * earlier step's view:
 *
 *   compute-budget-deltas → derive-budget-actions → derive-relationships
 *     → seed-capabilities → derive-intelligence-cache
 *
 *   run-pe-derive-chain             # DRY RUN: children run WITHOUT --commit, no SyncRun row
 *   run-pe-derive-chain --commit    # persist (what the EventBridge rule passes)
 *
 * Each child is dry-run-by-default and idempotent (upserts latest-wins or
 * deletes/rewrites only its own derived_by cohort), so re-running the chain is
 * always safe. Steps shell out through the same tsx invocation the entrypoint
 * dispatch uses (backfill-all precedent), so per-step logs/JSON land in the
 * task's CloudWatch stream unchanged.
 *
 * Commit runs are wrapped in runWithSyncRun('pe-derive-chain') for the
 * ingestion dashboard, the INGESTION_METRIC line, and the one-instance guard
 * (a slow chain + the next cron tick must not run concurrently).
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, emptyCounts, type RunCounts } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

interface Step {
  script: string;
  /** Extra CLI args the verb requires beyond the --commit gate. */
  args?: readonly string[];
}

/** Dependency-ordered derive DAG. Later steps read the tables earlier steps write. */
const STEPS: readonly Step[] = [
  { script: 'compute-budget-deltas' },
  { script: 'derive-budget-actions' },
  { script: 'derive-relationships' },
  // seed-capabilities refuses to run without its curated seed artifact.
  {
    script: 'seed-capabilities',
    args: ['--artifact', 'scripts/__data__/corrected_json/capabilities_seed.json'],
  },
  { script: 'derive-intelligence-cache' },
  // Phase 2: alerts fire only after fresh derivations. Email delivery inside is
  // canary-gated by PE_ALERT_EMAIL_TENANTS (unset = dark); watchlist stamping
  // always runs on --commit.
  { script: 'send-pe-alert-emails' },
];

function runStep(step: Step, commit: boolean): Promise<number> {
  const tsxBin = path.join('node_modules', '.bin', 'tsx');
  const args = [
    path.join('scripts', `${step.script}.ts`),
    ...(step.args ?? []),
    ...(commit ? ['--commit'] : []),
  ];
  return new Promise((resolve) => {
    const child = spawn(tsxBin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`[pe-derive-chain] spawn failed for ${step.script}: ${err.message}`);
      resolve(1);
    });
  });
}

async function runChain(commit: boolean): Promise<RunCounts> {
  const counts = emptyCounts();
  for (const step of STEPS) {
    console.log(`\n>>> [pe-derive-chain] ${step.script}${commit ? ' --commit' : ' (dry run)'}`);
    const t0 = Date.now();
    const code = await runStep(step, commit);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (code !== 0) {
      counts.errors += 1;
      console.error(
        `<<< [pe-derive-chain] ${step.script} FAILED exit=${code} (${secs}s) — aborting chain`,
      );
      throw new Error(`[pe-derive-chain] ${step.script} exited ${code}`);
    }
    counts.updated += 1;
    console.log(`<<< [pe-derive-chain] ${step.script} OK (${secs}s)`);
  }
  return counts;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');

  if (!commit) {
    // Dry runs stay out of SyncRun: they must not advance the watermark or show
    // up as job successes on the ingestion dashboard.
    await runChain(false);
    console.log('\n[pe-derive-chain] dry run complete (no SyncRun row written)');
    return;
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await runWithSyncRun(prisma, 'pe-derive-chain', () => runChain(true));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((e) => {
  console.error('[run-pe-derive-chain] fatal', (e as Error)?.stack ?? e);
  process.exit(1);
});
