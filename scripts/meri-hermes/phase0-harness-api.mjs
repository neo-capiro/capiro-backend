#!/usr/bin/env node
/**
 * Launch the Phase 0 harness API (apps/api/scripts/meri-hermes-phase0-harness-api.ts).
 *
 * NestJS needs `emitDecoratorMetadata`, which esbuild/tsx cannot provide, so the
 * harness is compiled with tsc (`tsconfig.meri-hermes-harness.json`, outDir
 * `dist-harness`) exactly like the production `nest build`, and the compiled
 * CommonJS entry is run with node. Pass `--compile` to (re)build first.
 * Environment is inherited; see the header of the TS script for variable names.
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'apps/api');
const ENTRY = path.join(API, 'dist-harness/scripts/meri-hermes-phase0-harness-api.js');
const bin = (name) => path.join(API, 'node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const shell = process.platform === 'win32';

if (process.argv.includes('--compile') || !existsSync(ENTRY)) {
  console.log('[harness-api] compiling with tsc (tsconfig.meri-hermes-harness.json → dist-harness)…');
  const result = spawnSync(bin('tsc'), ['-p', 'tsconfig.meri-hermes-harness.json', '--noEmit', 'false', '--outDir', 'dist-harness', '--incremental', 'true', '--tsBuildInfoFile', 'dist-harness/.tsbuildinfo'], { cwd: API, stdio: 'inherit', shell });
  if (result.status !== 0) {
    // tsc emits even when it reports diagnostics (noEmitOnError is off). The
    // base commit carries one unrelated TS1479 in program-element/models
    // (ESM import under CJS); tolerate a non-zero status only when the entry was emitted.
    if (!existsSync(ENTRY)) {
      console.error('[harness-api] compile failed and no entry was emitted');
      process.exit(result.status ?? 1);
    }
    console.warn(`[harness-api] tsc exited ${result.status} with diagnostics; entry emitted, continuing`);
  }
}
const child = spawn(process.execPath, [ENTRY], { cwd: API, env: { NODE_ENV: 'test', ...process.env }, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
