#!/usr/bin/env node
/**
 * Launcher for the shared EXTERNAL Playwright runner.
 *
 * Resolution is EXPLICIT and fail-closed (lib/playwright-runtime.mjs): the
 * external runtime lives OUTSIDE every repository ancestor, so Node's implicit
 * ancestor walk cannot find it on a fresh CI checkout. PLAYWRIGHT_CLI (CI
 * contract) or PLAYWRIGHT_RUNTIME_DIR must point at it; the implicit shared
 * C:/dev/node_modules install is only a developer convenience and is reported
 * as source `implicit` so a proof can assert it was NOT used.
 *
 * Playwright is never a dependency of this or any monorepo manifest and no
 * local `playwright install` is ever run. Configured command args pass through;
 * bare usage/help and unknown top-level options exit before runtime resolution:
 *
 *   node scripts/run-playwright.mjs test                     # run suite
 *   node scripts/run-playwright.mjs test --list              # runner identities
 *   node scripts/run-playwright.mjs test --update-snapshots  # regenerate baselines
 * @cleanup-smoke noArgsExit=1 helpExit=0
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlaywrightRuntime } from '../lib/playwright-runtime.mjs';

const args = process.argv.slice(2);
const USAGE = 'Usage: node apps/e2e/scripts/run-playwright.mjs <Playwright command> [options]';
if (args.length === 0) {
  console.error(USAGE);
  process.exit(1);
}
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
const validRootOptions = new Set(['--help', '-h', '--version', '-V']);
if (args[0]?.startsWith('-') && !validRootOptions.has(args[0])) {
  console.error(USAGE);
  console.error(`[run-playwright] unknown top-level option: ${args[0]}`);
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let runtime;
try {
  runtime = resolvePlaywrightRuntime({ requireFrom: path.join(ROOT, 'package.json') });
} catch (e) {
  console.error('[run-playwright] shared external @playwright/test runtime not resolvable:');
  console.error(e.message);
  process.exit(2);
}

// Prove the external instance is the one used: fail closed if the resolved CLI
// is not the file we asked for, and never silently fall back when an explicit
// runtime was requested but did not resolve (resolvePlaywrightRuntime throws).
if (process.env.PLAYWRIGHT_CLI || process.env.PLAYWRIGHT_RUNTIME_DIR) {
  if (runtime.source === 'implicit') {
    console.error('[run-playwright] explicit runtime requested but only implicit resolution succeeded');
    process.exit(2);
  }
}
console.error(`[run-playwright] runtime=${runtime.source} cli=${runtime.cli}`);

const child = spawn(process.execPath, [runtime.cli, ...args], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env },
});
child.on('exit', (code) => process.exit(code ?? 1));
