/**
 * Phase 9 integrated release rehearsal (closeout).
 *
 * Modes:
 *  - default / --full     : run ordered steps (long)
 *  - --backend-only       : backend/shared rehearsal; separate evidence and success marker
 *  - --integrity-only     : tip path transport scan (fast)
 *  - --extended-proofs-only : assert extended proof ownership map + re-run proof owners' unit markers
 *  - --catalog-only       : catalog honesty only
 *  - --dry-run            : print steps, do not execute
 *  - --skip-install       : skip frozen install (operator already installed)
 *  - --skip-disposable-pg : skip docker migrate + RLS rehearsal (record ENV skip)
 *  - --base-sha <sha>     : optional merge-base for failure classification (re-run select required gates)
 *  - --evidence-dir <path>: write JSON summary under docs/verification/... or custom
 *
 * Database rehearsals require operator-qualified disposable targets; the retained
 * Phase C RLS script accepts inherited PG settings. Never use shared/prod Postgres.
 * Does not self-PASS the adversarial review exit gate — prints PE_PHASE_9_OK for the
 * executable harness only; independent REVIEW is still required.
 */
import { strict as assert } from 'node:assert';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  PE_PHASE_9_EXTENDED_PROOF_IDS,
  PE_PHASE_9_EXTENDED_PROOF_OWNERS,
  pePhase9StepsForScope,
  type PePhase9Scope,
  type PePhase9Step,
} from './lib/pe-phase-9-rehearsal-catalog.js';
import {
  PE_PHASE_9_ENV_SKIP_EXIT,
  assertPePhase9CatalogHonest,
  evaluatePePhase9Gate,
  evaluatePePhase9Integrity,
  type PePhase9StepOutcome,
} from './lib/pe-phase-9-rehearsal.js';
import { pePhase9BaseComparisons, runPePhase9Steps } from './lib/pe-phase-9-runner.js';
import { pePhase9Evidence, pePhase9EvidenceMarkdown } from './lib/pe-phase-9-evidence.js';

function repoRootFromCwd(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  if (cwd.endsWith('/apps/api')) return resolve(process.cwd(), '../..');
  // walk up looking for pnpm-workspace
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function apiRoot(): string {
  return resolve(repoRootFromCwd(), 'apps/api');
}

function parseArgs(argv: string[]) {
  const booleanFlags = new Set([
    '--run',
    '--full',
    '--backend-only',
    '--integrity-only',
    '--extended-proofs-only',
    '--catalog-only',
    '--dry-run',
    '--skip-install',
    '--skip-disposable-pg',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--' || booleanFlags.has(arg)) continue;
    if (arg === '--base-sha' || arg === '--evidence-dir') {
      const next = argv[i + 1];
      assert.ok(next && !next.startsWith('--'), `Missing value for ${arg}`);
      i++;
    } else if (arg.startsWith('--base-sha=') || arg.startsWith('--evidence-dir=')) {
      assert.ok(arg.slice(arg.indexOf('=') + 1), `Missing value for ${arg.split('=')[0]}`);
    } else {
      throw new Error(`Unknown Phase 9 argument: ${arg}`);
    }
  }
  assert.ok(
    !(argv.includes('--backend-only') && argv.includes('--full')),
    '--backend-only conflicts with --full',
  );
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    const next = idx >= 0 ? argv[idx + 1] : undefined;
    if (idx >= 0 && next && !next.startsWith('--')) return next;
    const pref = argv.find((a) => a.startsWith(`${name}=`));
    return pref ? pref.slice(name.length + 1) : undefined;
  };
  return {
    scope: (flags.has('--backend-only') ? 'backend' : 'full') as PePhase9Scope,
    integrityOnly: flags.has('--integrity-only'),
    extendedOnly: flags.has('--extended-proofs-only'),
    catalogOnly: flags.has('--catalog-only'),
    dryRun: flags.has('--dry-run'),
    skipInstall: flags.has('--skip-install'),
    skipDisposablePg: flags.has('--skip-disposable-pg'),
    full:
      flags.has('--full') ||
      (!flags.has('--integrity-only') &&
        !flags.has('--extended-proofs-only') &&
        !flags.has('--catalog-only')),
    baseSha: get('--base-sha'),
    evidenceDir: get('--evidence-dir'),
  };
}

function git(args: string[], cwd: string): { code: number; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function listTipPaths(root: string): string[] {
  const r = git(['ls-tree', '-r', '--name-only', 'HEAD'], root);
  if (r.code !== 0) {
    // fallback walk limited package trees
    const acc: string[] = [];
    const walk = (rel: string, depth: number) => {
      if (depth > 8) return;
      const abs = resolve(root, rel);
      if (!existsSync(abs)) return;
      for (const name of readdirSync(abs)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const child = rel ? `${rel}/${name}` : name;
        const st = statSync(resolve(root, child));
        if (st.isDirectory()) walk(child, depth + 1);
        else acc.push(child.replace(/\\/g, '/'));
      }
    };
    walk('', 0);
    return acc;
  }
  return r.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function listChangedPaths(root: string): string[] {
  const r = git(['diff', '--name-only', 'origin/main...HEAD'], root);
  if (r.code !== 0) return [];
  return r.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Windows Hermes/MSYS: the `pnpm` shim may rewrite C:\\Users → C:\\c\\Users and break
 * node module resolution. Prefer invoking corepack's pnpm.js with a known NODE_EXE.
 */
function rewritePnpmCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): { command: string; env: NodeJS.ProcessEnv } {
  const nodeExe =
    env.PE_PHASE_9_NODE ||
    env.NODE_EXE ||
    (existsSync('C:/Users/neoma/AppData/Local/hermes/node/node.exe')
      ? 'C:/Users/neoma/AppData/Local/hermes/node/node.exe'
      : '');
  const pnpmJs =
    env.PE_PHASE_9_PNPM_JS ||
    env.PNPM_JS ||
    (existsSync('C:/Users/neoma/AppData/Local/hermes/node/node_modules/corepack/dist/pnpm.js')
      ? 'C:/Users/neoma/AppData/Local/hermes/node/node_modules/corepack/dist/pnpm.js'
      : '');
  if (!nodeExe || !pnpmJs) return { command, env };
  // Only rewrite leading pnpm invocations (package scripts / root).
  if (!/(^|[;&|]\s*)pnpm(\s|$)/.test(command)) return { command, env };
  const rewritten = command.replace(/(^|[;&|]\s*)pnpm\b/g, `$1"${nodeExe}" "${pnpmJs}"`);
  return {
    command: rewritten,
    env: { ...env, NODE_EXE: nodeExe, PNPM_JS: pnpmJs },
  };
}

function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): PePhase9StepOutcome & { raw: string } {
  const started = Date.now();
  const rewritten = rewritePnpmCommand(command, env);
  try {
    const out = execSync(rewritten.command, {
      cwd,
      env: rewritten.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      shell: process.platform === 'win32' ? 'bash' : '/bin/bash',
    });
    return {
      stepId: '',
      exitCode: 0,
      detail: String(out).slice(-2000),
      durationMs: Date.now() - started,
      raw: String(out),
    };
  } catch (e) {
    const err = e as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const stdout = err.stdout ? String(err.stdout) : '';
    const stderr = err.stderr ? String(err.stderr) : '';
    return {
      stepId: '',
      exitCode: typeof err.status === 'number' ? err.status : 1,
      detail: `${stdout}\n${stderr}`.slice(-4000) || err.message,
      durationMs: Date.now() - started,
      raw: `${stdout}\n${stderr}`,
    };
  }
}

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 20_000 });
  return (r.status ?? 1) === 0;
}

function writeEvidence(dir: string, payload: unknown): void {
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'phase-9-rehearsal-summary.json');
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote evidence ${path}`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const root = repoRootFromCwd();
  const steps = pePhase9StepsForScope(opts.scope);
  const catalog = assertPePhase9CatalogHonest(opts.scope);
  assert.equal(catalog.ok, true, `Phase 9 catalog dishonest:\n${catalog.errors.join('\n')}`);

  if (opts.catalogOnly) {
    console.log(
      opts.scope === 'backend' ? 'PE_PHASE_9_BACKEND_CATALOG_OK' : 'PE_PHASE_9_CATALOG_OK',
    );
    return;
  }

  const tipPaths = listTipPaths(root);
  const changedPaths = listChangedPaths(root);
  const integrity = evaluatePePhase9Integrity({ tipPaths, changedPaths });

  if (handleReadOnlyMode(opts, steps, integrity)) return;
  const execution = executeRehearsal(root, opts, steps, integrity, catalog.errors, changedPaths);
  reportRehearsal(root, opts, execution);
}

function handleReadOnlyMode(
  opts: ReturnType<typeof parseArgs>,
  steps: readonly PePhase9Step[],
  integrity: ReturnType<typeof evaluatePePhase9Integrity>,
): boolean {
  if (opts.integrityOnly) {
    assert.equal(integrity.ok, true, integrity.blockers.join('\n'));
    console.log(
      opts.scope === 'backend' ? 'PE_PHASE_9_BACKEND_INTEGRITY_OK' : 'PE_PHASE_9_INTEGRITY_OK',
    );
    return true;
  }

  if (opts.extendedOnly) {
    for (const id of PE_PHASE_9_EXTENDED_PROOF_IDS) {
      const owner = PE_PHASE_9_EXTENDED_PROOF_OWNERS[id];
      assert.ok(owner.ownerStepIds.length > 0, id);
      for (const sid of owner.ownerStepIds) {
        assert.ok(
          steps.some((s) => s.id === sid),
          `owner ${sid} missing for ${id}`,
        );
      }
      console.log(`EXTENDED_PROOF_MAPPED ${id} -> ${owner.ownerStepIds.join(',')}`);
    }
    // Lightweight proof that owner packages still expose the scripts
    const apiPkg = JSON.parse(readFileSync(resolve(apiRoot(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const letter of ['e', 'd', 'f', 'i', 'j'] as const) {
      const key = `verify:pe-phase-${letter}`;
      assert.match(apiPkg.scripts?.[key] ?? '', /./, `missing script ${key}`);
    }
    console.log(
      opts.scope === 'backend'
        ? 'PE_PHASE_9_BACKEND_EXTENDED_PROOFS_OK'
        : 'PE_PHASE_9_EXTENDED_PROOFS_OK',
    );
    return true;
  }

  if (opts.dryRun) {
    for (const step of steps) {
      console.log(`[dry-run] ${step.id}: (${step.cwd ?? '.'}) ${step.command}`);
    }
    console.log(`steps=${steps.length} required=${steps.filter((s) => s.required).length}`);
    return true;
  }

  return false;
}

function executeRehearsal(
  root: string,
  opts: ReturnType<typeof parseArgs>,
  steps: readonly PePhase9Step[],
  integrity: ReturnType<typeof evaluatePePhase9Integrity>,
  catalogErrors: string[],
  changedPaths: readonly string[],
) {
  const headSha = git(['rev-parse', 'HEAD'], root).out.trim();
  const mainSha = git(['rev-parse', 'origin/main'], root).out.trim();
  const mergeBase =
    opts.baseSha || git(['merge-base', 'origin/main', 'HEAD'], root).out.trim() || mainSha;

  console.log(`PE Phase 9 rehearsal HEAD=${headSha}`);
  console.log(`merge-base=${mergeBase} origin/main=${mainSha}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Quiet turbo / CI-ish
    CI: process.env.CI ?? '1',
    // Dummy URL where prisma validate/generate need a placeholder
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgresql://capiro:capiro@127.0.0.1:5432/capiro?schema=public',
  };

  const outcomes = runPePhase9Steps({
    steps,
    integrity,
    skipInstall: opts.skipInstall,
    skipDisposablePg: opts.skipDisposablePg,
    ports: {
      log: (message) => console.log(message),
      disposableAvailable: () => dockerAvailable() || Boolean(process.env.PE_PHASE_9_PGHOST),
      runShell: (step, timeoutMs) =>
        runShell(step.command, step.cwd ? resolve(root, step.cwd) : root, env, timeoutMs),
    },
  });
  const failedRequired = outcomes.filter(
    (o) =>
      steps.some((s) => s.id === o.stepId && s.required) &&
      o.exitCode !== 0 &&
      o.exitCode !== PE_PHASE_9_ENV_SKIP_EXIT,
  );
  let injectedBaseResults: Record<string, number> = {};
  if (failedRequired.length && mergeBase && mergeBase !== headSha) {
    console.log(`Base-compare ${failedRequired.length} failed required step(s) at ${mergeBase}…`);
    const injected = process.env.PE_PHASE_9_BASE_RESULTS_JSON;
    if (injected && existsSync(injected))
      injectedBaseResults = JSON.parse(readFileSync(injected, 'utf8')) as Record<string, number>;
  }
  const baseComparisons = pePhase9BaseComparisons({
    steps,
    outcomes,
    changedPaths,
    compareWithBase: Boolean(mergeBase && mergeBase !== headSha),
    injectedBaseResults,
  });

  const gate = evaluatePePhase9Gate({
    scope: opts.scope,
    outcomes,
    baseComparisons,
    integrity,
    catalogErrors,
  });

  return { headSha, mainSha, mergeBase, integrity, outcomes, baseComparisons, gate };
}

function reportRehearsal(
  root: string,
  opts: ReturnType<typeof parseArgs>,
  execution: ReturnType<typeof executeRehearsal>,
): void {
  const { gate } = execution;
  const evidence = pePhase9Evidence(opts.scope, execution);
  const evidenceDir =
    opts.evidenceDir ||
    resolve(
      root,
      `docs/verification/program-elements-trust/${opts.scope === 'backend' ? 'phase-9-backend' : 'phase-9'}`,
    );
  writeEvidence(evidenceDir, evidence);

  const md = pePhase9EvidenceMarkdown(opts.scope, evidence);
  writeFileSync(resolve(evidenceDir, 'README.md'), md, 'utf8');

  if (!gate.ok) {
    console.error(opts.scope === 'backend' ? 'PE_PHASE_9_BACKEND_FAIL' : 'PE_PHASE_9_FAIL');
    for (const b of gate.blockers) console.error(`  BLOCKER: ${b}`);
    for (const w of gate.warnings) console.warn(`  WARN: ${w}`);
    process.exit(1);
  }

  for (const w of gate.warnings) console.warn(`  WARN: ${w}`);
  console.log(opts.scope === 'backend' ? 'PE_PHASE_9_BACKEND_OK' : 'PE_PHASE_9_OK');
}

main();
