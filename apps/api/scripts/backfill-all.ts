/**
 * One-time, dependency-ordered, resumable ingestion backfill (Production
 * Ingestion plan, Phase 3.1). Populates every source table once, in the order
 * sources -> derived/emitters -> embeddings, by running each ingestion command
 * through the SAME entrypoint dispatch the schedules use.
 *
 *   tsx scripts/backfill-all.ts                 # run the full ordered backfill
 *   tsx scripts/backfill-all.ts --dry-run       # print the plan, run nothing
 *   tsx scripts/backfill-all.ts --only sync-fec,sync-lda
 *   tsx scripts/backfill-all.ts --from emit-changes   # resume from a step
 *   tsx scripts/backfill-all.ts --continue-on-error   # don't stop on a failed step
 *
 * Resumable: writes progress to BACKFILL_STATE_FILE (default
 * /tmp/capiro-backfill-state.json). A re-run skips steps already 'done' unless
 * --force. Safe to re-run regardless — every sync upserts.
 *
 * Each step shells out to `node_modules/.bin/tsx scripts/<file>.ts <args>` so
 * this works locally and as the `backfill-all` ECS command. PE PDF-artifact
 * parsers (parse-hasc/sasc/ndaa/pdoc) are intentionally EXCLUDED — they need
 * committed offline artifacts, not a live API.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as path from 'node:path';

interface Step {
  /** Stable id (used in the state file + --only/--from). */
  id: string;
  /** Script file under scripts/ (without .ts). */
  script: string;
  /** Extra CLI args for this step. */
  args?: string[];
  /** Phase grouping for the printed plan. */
  phase: 'sources' | 'derived' | 'embeddings';
}

// Order matters: sources first, then derived/emitters that read them, then
// embeddings last. Within sources, order is roughly by downstream dependency
// (awards before district enrichment; lda/openlobby before the MV refresh).
const STEPS: Step[] = [
  // ---- sources ----
  { id: 'sync-congress', script: 'sync-congress', phase: 'sources' },
  { id: 'sync-fec', script: 'sync-fec', phase: 'sources' },
  { id: 'sync-fec-pac', script: 'sync-fec-pac', phase: 'sources' },
  { id: 'sync-federal-award', script: 'sync-federal-award', phase: 'sources' },
  { id: 'enrich-award-districts', script: 'enrich-award-districts', phase: 'sources' },
  { id: 'sync-census', script: 'sync-census', phase: 'sources' },
  { id: 'sync-lda', script: 'sync-lda', phase: 'sources' },
  { id: 'sync-openlobby', script: 'sync-openlobby', phase: 'sources' },
  { id: 'sync-hearings', script: 'sync-hearings', phase: 'sources' },
  { id: 'sync-gao', script: 'sync-gao', phase: 'sources' },
  { id: 'sync-crs', script: 'sync-crs', phase: 'sources' },
  { id: 'sync-federal-register', script: 'sync-federal-register', phase: 'sources' },
  { id: 'sync-regulations', script: 'sync-regulations', phase: 'sources' },
  { id: 'sync-openstates', script: 'sync-openstates', phase: 'sources' },
  { id: 'sync-fara', script: 'sync-fara', phase: 'sources' },
  { id: 'sync-sec-edgar', script: 'sync-sec-edgar', phase: 'sources' },
  { id: 'sync-tango-funding', script: 'sync-tango-funding', args: ['--commit'], phase: 'sources' },
  { id: 'sync-openspending', script: 'sync-openspending', phase: 'sources' },
  { id: 'sync-bea', script: 'sync-bea', phase: 'sources' },
  { id: 'sync-bls', script: 'sync-bls', phase: 'sources' },
  { id: 'sync-rss-intel', script: 'sync-rss-intel', phase: 'sources' },
  { id: 'sync-peo-rosters', script: 'sync-peo-rosters', phase: 'sources' },
  { id: 'sync-sam-personnel', script: 'sync-sam-personnel', phase: 'sources' },
  // ---- derived / emitters (read the sources above) ----
  { id: 'extract-bill-pe-codes', script: 'extract-bill-pe-codes', phase: 'derived' },
  { id: 'refresh-lobby-intel-mv', script: 'refresh-lobby-intel-mv', phase: 'derived' },
  { id: 'sync-lobby-trending', script: 'sync-lobby-trending', phase: 'derived' },
  { id: 'emit-changes', script: 'emit-changes', phase: 'derived' },
  { id: 'emit-bill-alerts', script: 'emit-bill-alerts', phase: 'derived' },
  { id: 'check-comment-periods', script: 'check-comment-periods', phase: 'derived' },
  { id: 'compute-health-scores', script: 'compute-health-scores', phase: 'derived' },
  { id: 'generate-briefings', script: 'generate-briefings', phase: 'derived' },
  { id: 'recompute-conference-probability', script: 'recompute-conference-probability', phase: 'derived' },
  // ---- embeddings (last; read bills/lda/capabilities) ----
  { id: 'embed-backfill', script: 'embed-backfill', args: ['--source', 'all'], phase: 'embeddings' },
];

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    only: { type: 'string' },
    from: { type: 'string' },
    'continue-on-error': { type: 'boolean' },
    force: { type: 'boolean' },
  },
});

const STATE_FILE = process.env.BACKFILL_STATE_FILE ?? '/tmp/capiro-backfill-state.json';
type State = Record<string, 'done' | 'error'>;

function loadState(): State {
  if (values.force || !existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  } catch {
    return {};
  }
}
function saveState(s: State): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.warn(`[backfill] could not write state file: ${(e as Error).message}`);
  }
}

function selectSteps(): Step[] {
  let steps = STEPS;
  if (values.only) {
    const ids = new Set(values.only.split(',').map((s) => s.trim()));
    steps = steps.filter((s) => ids.has(s.id));
  }
  if (values.from) {
    const idx = steps.findIndex((s) => s.id === values.from);
    if (idx >= 0) steps = steps.slice(idx);
  }
  return steps;
}

function runStep(step: Step): Promise<number> {
  const tsxBin = path.join('node_modules', '.bin', 'tsx');
  const scriptPath = path.join('scripts', `${step.script}.ts`);
  const args = [scriptPath, ...(step.args ?? [])];
  return new Promise((resolve) => {
    const child = spawn(tsxBin, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`[backfill] spawn failed for ${step.id}: ${err.message}`);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  const steps = selectSteps();
  const state = loadState();

  console.log(`=== Ingestion backfill: ${steps.length} steps (state: ${STATE_FILE}) ===`);
  let lastPhase = '';
  for (const s of steps) {
    if (s.phase !== lastPhase) {
      console.log(`\n--- ${s.phase.toUpperCase()} ---`);
      lastPhase = s.phase;
    }
    const status = state[s.id];
    const skip = status === 'done' && !values.force;
    console.log(`  ${skip ? '[skip done]' : '[run]'} ${s.id}${s.args ? ' ' + s.args.join(' ') : ''}`);
  }

  if (values['dry-run']) {
    console.log('\ndry-run: nothing executed.');
    return;
  }

  let failures = 0;
  for (const s of steps) {
    if (state[s.id] === 'done' && !values.force) continue;
    console.log(`\n>>> ${s.id} ...`);
    const t0 = Date.now();
    const code = await runStep(s);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (code === 0) {
      state[s.id] = 'done';
      console.log(`<<< ${s.id} OK (${secs}s)`);
    } else {
      state[s.id] = 'error';
      failures += 1;
      console.error(`<<< ${s.id} FAILED exit=${code} (${secs}s)`);
      saveState(state);
      if (!values['continue-on-error']) {
        console.error(`\nStopping at first failure. Fix, then resume: --from ${s.id}`);
        process.exit(1);
      }
    }
    saveState(state);
  }

  console.log(`\n=== Backfill complete. failures=${failures} ===`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
