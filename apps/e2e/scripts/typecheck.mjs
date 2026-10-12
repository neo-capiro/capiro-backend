#!/usr/bin/env node
/**
 * Typecheck the visual harness against the SHARED EXTERNAL Playwright runtime.
 *
 * `tsc` resolves `@playwright/test` types by normal ancestor lookup. The
 * external runtime is OUTSIDE every repository ancestor, so on a fresh CI
 * checkout `apps/e2e/tests/*.spec.ts` and `playwright.config.ts` would fail to
 * resolve `@playwright/test` — unless it is present incidentally. This wrapper
 * removes the accident: it resolves the SAME external instance the launcher
 * uses (lib/playwright-runtime.mjs) and generates a throwaway tsconfig whose
 * `baseUrl` is that runtime's `node_modules` with `paths` pinned at it. The
 * checked-in tsconfig.json is never mutated; the generated file is gitignored.
 *
 * A proof can assert `resolved=explicit` (never `implicit`) and run with
 * PLAYWRIGHT_CLI / PLAYWRIGHT_RUNTIME_DIR set to the external prefix.
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlaywrightRuntime } from '../lib/playwright-runtime.mjs';

const USAGE = 'Usage: typecheck.mjs --check (writes the gitignored tsconfig.visual-typecheck.json)';
const cliArgs = process.argv.slice(2);
if (cliArgs.length === 1 && (cliArgs[0] === '--help' || cliArgs[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (cliArgs.length !== 1 || cliArgs[0] !== '--check') {
  console.error(USAGE);
  if (cliArgs.length) console.error(`[typecheck] unknown argument: ${cliArgs.join(' ')}`);
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GEN = path.join(ROOT, 'tsconfig.visual-typecheck.json');

let runtime;
try {
  runtime = resolvePlaywrightRuntime({ requireFrom: path.join(ROOT, 'package.json') });
} catch (e) {
  console.error('[typecheck] shared external @playwright/test runtime not resolvable:');
  console.error(e.message);
  process.exit(2);
}
if ((process.env.PLAYWRIGHT_CLI || process.env.PLAYWRIGHT_RUNTIME_DIR) && runtime.source === 'implicit') {
  console.error('[typecheck] explicit runtime requested but only implicit resolution succeeded');
  process.exit(2);
}

// .../node_modules/@playwright/test -> .../node_modules
const runtimeNodeModules = path.dirname(path.dirname(runtime.packageDir));
const generated = {
  extends: './tsconfig.json',
  compilerOptions: {
    baseUrl: runtimeNodeModules,
    paths: {
      '@playwright/test': ['@playwright/test/index.d.ts'],
      '@playwright/test/*': ['@playwright/test/*'],
    },
  },
};
fs.writeFileSync(GEN, `${JSON.stringify(generated, null, 2)}\n`, 'utf8');

const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tsc)) {
  console.error(`[typecheck] local typescript not found at ${tsc} (pnpm install apps/e2e deps)`);
  process.exit(2);
}

console.error(
  `[typecheck] resolved=${runtime.source} playwright=${runtime.packageDir} baseUrl=${runtimeNodeModules}`,
);
const res = spawnSync(process.execPath, [tsc, '-p', GEN, '--noEmit'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env },
});
process.exit(res.status ?? 1);
