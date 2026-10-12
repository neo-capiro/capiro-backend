/**
 * Explicit resolution of the SHARED EXTERNAL Playwright runtime (CleanUp1 §8).
 *
 * Playwright is NOT a dependency of this package or any monorepo manifest and a
 * local `playwright install` is never run. The runner lives in an external
 * prefix that is OUTSIDE every repository ancestor. Node/TypeScript's implicit
 * ancestor walk therefore cannot find it on a fresh CI checkout, so resolution
 * must be EXPLICIT and is proven fail-closed here.
 *
 * Precedence (first that resolves wins; every consideration is reported):
 *
 *   1. PLAYWRIGHT_CLI          direct path to @playwright/test/cli.js — or a
 *                              directory containing it (CI contract var).
 *   2. PLAYWRIGHT_RUNTIME_DIR  a runtime prefix whose
 *                              node_modules/@playwright/test/cli.js exists.
 *   3. implicit require.resolve (developer machines only — the shared
 *                              C:/dev/node_modules install). Reported as
 *                              `implicit` so a proof can assert it was NOT used.
 *
 * The resolver returns the concrete package directory so the launcher (CLI) and
 * the typecheck wrapper (index.d.ts) resolve from the SAME external instance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const PKG = ['node_modules', '@playwright', 'test'];
const CLI_BASENAME = 'cli.js';

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function resolveFromCli(rawValue) {
  const abs = path.resolve(rawValue);
  const st = statOrNull(abs);
  if (!st) throw new Error(`PLAYWRIGHT_CLI does not exist: ${abs}`);
  if (st.isFile()) {
    // Must be the CLI entry (…/@playwright/test/cli.js).
    if (path.basename(abs) !== CLI_BASENAME) {
      throw new Error(`PLAYWRIGHT_CLI must point at ${CLI_BASENAME}, got file ${abs}`);
    }
    return { packageDir: path.dirname(abs), cli: abs };
  }
  if (st.isDirectory()) {
    const direct = path.join(abs, CLI_BASENAME);
    if (statOrNull(direct)?.isFile()) return { packageDir: abs, cli: direct };
    const nested = path.join(abs, ...PKG, CLI_BASENAME);
    if (statOrNull(nested)?.isFile()) return { packageDir: path.dirname(nested), cli: nested };
    throw new Error(`PLAYWRIGHT_CLI directory has no @playwright/test/${CLI_BASENAME}: ${abs}`);
  }
  throw new Error(`PLAYWRIGHT_CLI is neither a file nor a directory: ${abs}`);
}

function resolveFromRuntimeDir(rawValue) {
  const abs = path.resolve(rawValue);
  const cli = path.join(abs, ...PKG, CLI_BASENAME);
  if (!statOrNull(cli)?.isFile()) {
    throw new Error(`PLAYWRIGHT_RUNTIME_DIR has no @playwright/test/${CLI_BASENAME}: ${abs}`);
  }
  return { packageDir: path.dirname(cli), cli };
}

/**
 * @param {{ requireFrom?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ packageDir: string, cli: string, source: string, attempts: object[] }}
 */
export function resolvePlaywrightRuntime(opts = {}) {
  const env = opts.env ?? process.env;
  const attempts = [];
  const tryOne = (source, value, fn) => {
    if (value == null || value === '') {
      attempts.push({ source, value: null, ok: false, reason: 'unset' });
      return null;
    }
    try {
      const r = fn(value);
      attempts.push({ source, value, ok: true, packageDir: r.packageDir, cli: r.cli });
      return { ...r, source, attempts };
    } catch (e) {
      attempts.push({ source, value, ok: false, reason: e.message });
      return null;
    }
  };

  const requestedExplicit = Boolean(env.PLAYWRIGHT_CLI) || Boolean(env.PLAYWRIGHT_RUNTIME_DIR);
  let hit = tryOne('PLAYWRIGHT_CLI', env.PLAYWRIGHT_CLI, resolveFromCli);
  if (!hit) hit = tryOne('PLAYWRIGHT_RUNTIME_DIR', env.PLAYWRIGHT_RUNTIME_DIR, resolveFromRuntimeDir);

  // An EXPLICIT runtime that failed to resolve is a hard failure — never fall
  // back to the incidental shared install. (Proven by a bogus-prefix control.)
  if (!hit && requestedExplicit) {
    const detail = attempts.map((a) => `  - ${a.source}: ${a.ok ? 'ok' : a.reason}`).join('\n');
    const err = new Error(
      'Explicit Playwright runtime requested but could not be resolved (no implicit fallback):\n' +
        `Considered:\n${detail}`,
    );
    err.attempts = attempts;
    throw err;
  }

  if (!hit) {
    // Implicit fallback: only valid where the shared install happens to be an
    // ancestor (developer machines). Never relied upon by CI proofs.
    try {
      const req = createRequire(opts.requireFrom ?? path.join(process.cwd(), 'package.json'));
      const pkgJson = req.resolve('@playwright/test/package.json');
      const packageDir = path.dirname(pkgJson);
      const cli = path.join(packageDir, CLI_BASENAME);
      if (statOrNull(cli)?.isFile()) {
        attempts.push({ source: 'implicit', value: packageDir, ok: true, packageDir, cli });
        return { packageDir, cli, source: 'implicit', attempts };
      }
      attempts.push({ source: 'implicit', value: packageDir, ok: false, reason: 'cli.js missing' });
    } catch (e) {
      attempts.push({ source: 'implicit', value: null, ok: false, reason: e.message });
    }
  }

  if (hit) return hit;
  const detail = attempts.map((a) => `  - ${a.source}: ${a.ok ? 'ok' : a.reason}`).join('\n');
  const err = new Error(
    'No SHARED EXTERNAL @playwright/test runtime could be resolved.\n' +
      'Set PLAYWRIGHT_CLI (path to @playwright/test/cli.js) or PLAYWRIGHT_RUNTIME_DIR\n' +
      '(a prefix containing node_modules/@playwright/test).\n' +
      `Considered:\n${detail}`,
  );
  err.attempts = attempts;
  throw err;
}
