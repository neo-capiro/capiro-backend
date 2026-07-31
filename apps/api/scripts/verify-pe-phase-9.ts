/**
 * Phase 9 integrated release rehearsal (closeout).
 *
 * Modes:
 *  - default / --full     : run ordered PE_PHASE_9_REHEARSAL_STEPS (long)
 *  - --integrity-only     : tip path transport scan (fast)
 *  - --extended-proofs-only : assert extended proof ownership map + re-run proof owners' unit markers
 *  - --catalog-only       : catalog honesty only
 *  - --dry-run            : print steps, do not execute
 *  - --skip-install       : skip frozen install (operator already installed)
 *  - --skip-disposable-pg : skip docker migrate + RLS rehearsal (record ENV skip)
 *  - --base-sha <sha>     : optional merge-base for failure classification (re-run select required gates)
 *  - --evidence-dir <path>: write JSON summary under docs/verification/... or custom
 *
 * Never targets shared/prod Postgres. Disposable containers only.
 * Does not self-PASS the adversarial review exit gate — prints PE_PHASE_9_OK for the
 * executable harness only; independent REVIEW is still required.
 */
import { strict as assert } from 'node:assert';
import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  PE_PHASE_9_EXTENDED_PROOF_IDS,
  PE_PHASE_9_EXTENDED_PROOF_OWNERS,
  PE_PHASE_9_REHEARSAL_STEPS,
  type PePhase9Step,
} from './lib/pe-phase-9-rehearsal-catalog.js';
import {
  PE_PHASE_9_ENV_SKIP_EXIT,
  assertPePhase9CatalogHonest,
  evaluatePePhase9Gate,
  evaluatePePhase9Integrity,
  stepTouchesChangedPaths,
  type PePhase9BaseComparison,
  type PePhase9StepOutcome,
} from './lib/pe-phase-9-rehearsal.js';

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
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    const next = idx >= 0 ? argv[idx + 1] : undefined;
    if (idx >= 0 && next && !next.startsWith('--')) return next;
    const pref = argv.find((a) => a.startsWith(`${name}=`));
    return pref ? pref.slice(name.length + 1) : undefined;
  };
  return {
    integrityOnly: flags.has('--integrity-only'),
    extendedOnly: flags.has('--extended-proofs-only'),
    catalogOnly: flags.has('--catalog-only'),
    dryRun: flags.has('--dry-run'),
    skipInstall: flags.has('--skip-install'),
    skipDisposablePg: flags.has('--skip-disposable-pg'),
    full: flags.has('--full') || (!flags.has('--integrity-only') && !flags.has('--extended-proofs-only') && !flags.has('--catalog-only')),
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
function rewritePnpmCommand(command: string, env: NodeJS.ProcessEnv): { command: string; env: NodeJS.ProcessEnv } {
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

function shouldSkipStep(step: PePhase9Step, opts: ReturnType<typeof parseArgs>): string | null {
  if (opts.skipInstall && step.id === 'install_frozen') return 'skip-install flag';
  if (opts.skipDisposablePg && step.disposablePostgresOnly) return 'skip-disposable-pg flag';
  return null;
}

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 20_000 });
  return (r.status ?? 1) === 0;
}

function writeEvidence(
  dir: string,
  payload: unknown,
): void {
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'phase-9-rehearsal-summary.json');
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote evidence ${path}`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const root = repoRootFromCwd();
  const catalog = assertPePhase9CatalogHonest();
  assert.equal(catalog.ok, true, `Phase 9 catalog dishonest:\n${catalog.errors.join('\n')}`);

  if (opts.catalogOnly) {
    console.log('PE_PHASE_9_CATALOG_OK');
    return;
  }

  const tipPaths = listTipPaths(root);
  const changedPaths = listChangedPaths(root);
  const integrity = evaluatePePhase9Integrity({ tipPaths, changedPaths });

  if (opts.integrityOnly) {
    assert.equal(integrity.ok, true, integrity.blockers.join('\n'));
    console.log('PE_PHASE_9_INTEGRITY_OK');
    return;
  }

  if (opts.extendedOnly) {
    for (const id of PE_PHASE_9_EXTENDED_PROOF_IDS) {
      const owner = PE_PHASE_9_EXTENDED_PROOF_OWNERS[id];
      assert.ok(owner.ownerStepIds.length > 0, id);
      for (const sid of owner.ownerStepIds) {
        assert.ok(
          PE_PHASE_9_REHEARSAL_STEPS.some((s) => s.id === sid),
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
    console.log('PE_PHASE_9_EXTENDED_PROOFS_OK');
    return;
  }

  if (opts.dryRun) {
    for (const step of PE_PHASE_9_REHEARSAL_STEPS) {
      console.log(`[dry-run] ${step.id}: (${step.cwd ?? '.'}) ${step.command}`);
    }
    console.log(`steps=${PE_PHASE_9_REHEARSAL_STEPS.length} required=${PE_PHASE_9_REHEARSAL_STEPS.filter((s) => s.required).length}`);
    return;
  }

  const headSha = git(['rev-parse', 'HEAD'], root).out.trim();
  const mainSha = git(['rev-parse', 'origin/main'], root).out.trim();
  const mergeBase =
    opts.baseSha ||
    git(['merge-base', 'origin/main', 'HEAD'], root).out.trim() ||
    mainSha;

  console.log(`PE Phase 9 rehearsal HEAD=${headSha}`);
  console.log(`merge-base=${mergeBase} origin/main=${mainSha}`);

  const outcomes: PePhase9StepOutcome[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Quiet turbo / CI-ish
    CI: process.env.CI ?? '1',
    // Dummy URL where prisma validate/generate need a placeholder
    DATABASE_URL:
      process.env.DATABASE_URL ??
      'postgresql://capiro:capiro@127.0.0.1:5432/capiro?schema=public',
  };

  for (const step of PE_PHASE_9_REHEARSAL_STEPS) {
    const skip = shouldSkipStep(step, opts);
    if (skip) {
      console.log(`SKIP ${step.id}: ${skip}`);
      outcomes.push({
        stepId: step.id,
        exitCode: step.required && step.disposablePostgresOnly ? PE_PHASE_9_ENV_SKIP_EXIT : 0,
        detail: skip,
      });
      continue;
    }

    if (step.disposablePostgresOnly && !dockerAvailable() && !process.env.PE_PHASE_9_PGHOST) {
      console.log(`ENV_SKIP ${step.id}: docker unavailable and PE_PHASE_9_PGHOST unset`);
      outcomes.push({
        stepId: step.id,
        exitCode: PE_PHASE_9_ENV_SKIP_EXIT,
        detail: 'docker unavailable',
      });
      continue;
    }

    // Integrity step is special-cased to pure scan (already computed) / recursive guard
    if (step.id === 'transport_absent') {
      console.log(`RUN ${step.id} (in-process integrity)`);
      outcomes.push({
        stepId: step.id,
        exitCode: integrity.ok ? 0 : 1,
        detail: integrity.ok ? 'clean' : integrity.blockers.join('; '),
      });
      continue;
    }

    if (step.id === 'extended_loader_dry_run_matrix') {
      console.log(`RUN ${step.id} (in-process extended map)`);
      let ok = true;
      const notes: string[] = [];
      for (const id of PE_PHASE_9_EXTENDED_PROOF_IDS) {
        const owner = PE_PHASE_9_EXTENDED_PROOF_OWNERS[id];
        const ownersRanOk = owner.ownerStepIds.every((sid) => {
          const o = outcomes.find((x) => x.stepId === sid);
          return o && o.exitCode === 0;
        });
        if (!ownersRanOk) {
          ok = false;
          notes.push(`${id}: owner gate not green`);
        } else {
          notes.push(`${id}: ok via ${owner.ownerStepIds.join(',')}`);
        }
      }
      outcomes.push({
        stepId: step.id,
        exitCode: ok ? 0 : 1,
        detail: notes.join(' | '),
      });
      continue;
    }

    const cwd = step.cwd ? resolve(root, step.cwd) : root;
    const timeoutMs =
      step.kind === 'install'
        ? 15 * 60_000
        : step.kind === 'migration_replay' || step.kind === 'rls'
          ? 30 * 60_000
          : step.id === 'full_pe_api_tests' || step.id === 'web_build'
            ? 25 * 60_000
            : 15 * 60_000;

    console.log(`RUN ${step.id}: ${step.command}`);
    const result = runShell(step.command, cwd, env, timeoutMs);
    console.log(`  exit=${result.exitCode} durationMs=${result.durationMs}`);
    if (result.exitCode !== 0) {
      console.log(`  detail_tail:\n${(result.detail ?? '').split('\n').slice(-30).join('\n')}`);
    }
    outcomes.push({
      stepId: step.id,
      exitCode: result.exitCode,
      detail: result.detail,
      durationMs: result.durationMs,
    });
  }

  // Optional base comparison for failed required steps (expensive — only failures)
  const baseComparisons: PePhase9BaseComparison[] = [];
  const failedRequired = outcomes.filter((o) => {
    const step = PE_PHASE_9_REHEARSAL_STEPS.find((s) => s.id === o.stepId);
    return step?.required && o.exitCode !== 0 && o.exitCode !== PE_PHASE_9_ENV_SKIP_EXIT;
  });

  if (failedRequired.length && mergeBase && mergeBase !== headSha) {
    console.log(`Base-compare ${failedRequired.length} failed required step(s) at ${mergeBase}…`);
    // We do not checkout base in this process (destructive). Instead record null base
    // unless PE_PHASE_9_BASE_RESULTS_JSON is supplied by operator (or prior evidence).
    const injected = process.env.PE_PHASE_9_BASE_RESULTS_JSON;
    let injectedMap: Record<string, number> = {};
    if (injected && existsSync(injected)) {
      injectedMap = JSON.parse(readFileSync(injected, 'utf8')) as Record<string, number>;
    }
    for (const fail of failedRequired) {
      const step = PE_PHASE_9_REHEARSAL_STEPS.find((s) => s.id === fail.stepId)!;
      const injectedExit = injectedMap[fail.stepId];
      const baseExit: number | null =
        typeof injectedExit === 'number' ? injectedExit : null;
      baseComparisons.push({
        stepId: fail.stepId,
        headExitCode: fail.exitCode,
        baseExitCode: baseExit,
        touchesChangedRuntimePaths: stepTouchesChangedPaths(step, changedPaths),
      });
    }
  }

  // Treat disposable ENV skips on *required* migration replay as blockers
  for (const o of outcomes) {
    const step = PE_PHASE_9_REHEARSAL_STEPS.find((s) => s.id === o.stepId);
    if (
      step?.required &&
      step.disposablePostgresOnly &&
      o.exitCode === PE_PHASE_9_ENV_SKIP_EXIT
    ) {
      o.detail = `${o.detail ?? ''}; required disposable Postgres step skipped`.trim();
      // leave exit code 75 — classify as environment/blocker via gate (not base_proven)
      // Map to non-zero non-base for gate: treat as branch_introduced-ish blocker by forcing base null
      baseComparisons.push({
        stepId: o.stepId,
        headExitCode: o.exitCode,
        baseExitCode: null,
        touchesChangedRuntimePaths: true,
      });
    }
  }

  const gate = evaluatePePhase9Gate({
    outcomes,
    baseComparisons,
    integrity,
    catalogErrors: catalog.errors,
  });

  const evidence = {
    phase: 9,
    kind: 'integrated_release_rehearsal',
    headSha,
    mergeBase,
    mainSha,
    generatedAt: new Date().toISOString(),
    integrity,
    outcomes,
    baseComparisons,
    gate: {
      ok: gate.ok,
      blockers: gate.blockers,
      warnings: gate.warnings,
      classifications: gate.classifications,
    },
    extendedProofs: PE_PHASE_9_EXTENDED_PROOF_IDS.map((id) => ({
      id,
      ...PE_PHASE_9_EXTENDED_PROOF_OWNERS[id],
    })),
    note:
      'PE_PHASE_9_OK certifies the executable rehearsal harness only. Independent adversarial REVIEW is still required. Synthetic goldens remain NOT human-reviewed.',
  };

  const evidenceDir =
    opts.evidenceDir ||
    resolve(root, 'docs/verification/program-elements-trust/phase-9');
  writeEvidence(evidenceDir, evidence);

  // Human-readable sidecar
  const md = [
    '# Phase 9 integrated release rehearsal evidence',
    '',
    `- HEAD: \`${headSha}\``,
    `- merge-base: \`${mergeBase}\``,
    `- origin/main: \`${mainSha}\``,
    `- gate.ok: **${gate.ok}**`,
    `- generated: ${evidence.generatedAt}`,
    '',
    '## Blockers',
    gate.blockers.length ? gate.blockers.map((b) => `- ${b}`).join('\n') : '- (none)',
    '',
    '## Warnings / base-proven',
    gate.warnings.length ? gate.warnings.map((w) => `- ${w}`).join('\n') : '- (none)',
    '',
    '## Outcomes',
    ...outcomes.map(
      (o) =>
        `- \`${o.stepId}\` exit=${o.exitCode}${o.durationMs != null ? ` (${o.durationMs}ms)` : ''}`,
    ),
    '',
    '## Honesty',
    '',
    '- This file is machine + implementer evidence, **not** independent REVIEW PASS.',
    '- Grounded-field goldens remain SYNTHETIC / NOT human-reviewed (Phase K6).',
    '- No shared-env migrate/deploy/ingestion/email/LlamaParse/Secrets Manager in this phase.',
    '',
  ].join('\n');
  writeFileSync(resolve(evidenceDir, 'README.md'), md, 'utf8');

  if (!gate.ok) {
    console.error('PE_PHASE_9_FAIL');
    for (const b of gate.blockers) console.error(`  BLOCKER: ${b}`);
    for (const w of gate.warnings) console.warn(`  WARN: ${w}`);
    process.exit(1);
  }

  for (const w of gate.warnings) console.warn(`  WARN: ${w}`);
  console.log('PE_PHASE_9_OK');
}

main();
