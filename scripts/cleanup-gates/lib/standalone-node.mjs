/**
 * Source-driven discovery of standalone Node test suites for the CleanUp1 gate.
 *
 * Some applications in this repo deliberately have NO `package.json` (they keep
 * a runtime/isolation boundary and are not workspace packages), so
 * `pnpm turbo run test` and the gate's dynamic workspace scope never see them.
 * The canonical example is `apps/defense-parser-orchestrator`, whose suite the
 * Phase 8 Session 5 workflow runs natively as
 * `node --test apps/defense-parser-orchestrator/test/*.test.mjs`.
 *
 * This helper re-derives those suites from CURRENT source — there is no
 * checked-in list of file names — so the gate can execute them in `core`/`all`
 * without repackaging the app or folding it into another package. It is
 * intentionally minimal and uses Node builtins only. The Python parser app stays
 * with its existing dedicated owner; this helper is for standalone Node suites.
 *
 * Rules:
 *   - Only directories directly under `apps/` that LACK a `package.json` are
 *     considered: a manifest-bearing app belongs to the existing Turbo owner
 *     and is deliberately left alone here.
 *   - A supported suite is one or more REGULAR files named `*.test.mjs` directly
 *     under the app's `test/` directory (matching the workflow glob).
 *   - Discovery is fail-closed on every boundary: a missing, non-directory,
 *     symlinked/junctioned, root-escaping or unreadable `apps/` root is a
 *     problem; a candidate test that is a symlink, is not a regular file, or
 *     whose resolved real path escapes the owned root is REFUSED (reported as a
 *     problem), never silently followed; a linked/junctioned app directory or
 *     `test/` directory is refused rather than skipped. None of these can be
 *     expressed as an empty success.
 *   - A `test/` directory that declares no supported `*.test.mjs` suite is
 *     reported as unsupported scope — never an invented passing skip and never
 *     zero-test evidence of success.
 *
 * The `lstat`/`realpath` boundary functions are injectable so file-level
 * provenance refusals can also be exercised without a real symlink; directory
 * boundaries in the controls use real directory junctions (`fs.symlinkSync(…,
 * 'junction')`, no admin needed on Windows) / directory symlinks elsewhere. The
 * production defaults stay the real `fs.lstatSync` / `fs.realpathSync`.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Workspace directory whose manifest-less children are standalone apps. */
export const STANDALONE_APPS_DIR = 'apps';
/** Test directory inside a standalone app. */
export const STANDALONE_TEST_DIR = 'test';
/** Supported standalone Node test-suite file convention. */
export const STANDALONE_TEST_FILE_RE = /\.test\.mjs$/;

function listDirents(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Discover standalone Node test suites under the owned root.
 *
 * @param {string} root absolute (or resolvable) repository root
 * @param {{ lstat?: (p:string) => fs.Stats, realpath?: (p:string) => string }} [options]
 *   injectable fs boundary; defaults to `fs.lstatSync` / `fs.realpathSync`.
 * @returns {{
 *   suites: Array<{ packageDir: string, files: string[], argv: string[] }>,
 *   problems: Array<{ app: string, message: string }>,
 * }}
 *   `suites` contain only non-empty, in-root, regular-file suites. `problems`
 *   names every malformed/unsupported/refused scope so the gate can fail closed.
 */
export function discoverStandaloneNodeSuites(root, options = {}) {
  const lstat = options.lstat ?? ((p) => fs.lstatSync(p));
  const realpath = options.realpath ?? ((p) => fs.realpathSync(p));
  const rootAbs = path.resolve(root);
  const suites = [];
  const problems = [];

  let realRoot;
  try {
    realRoot = path.resolve(realpath(rootAbs));
  } catch (err) {
    return {
      suites,
      problems: [{ app: STANDALONE_APPS_DIR, message: `cannot resolve owned root ${rootAbs}: ${err.message}` }],
    };
  }

  const appsRoot = path.join(rootAbs, STANDALONE_APPS_DIR);

  // The owned `apps/` root is itself a discovery boundary. A missing,
  // non-directory, symlinked/junctioned, root-escaping or unreadable apps root
  // must fail closed with a problem — never an empty (success-looking) result.
  let appsStat;
  try {
    appsStat = lstat(appsRoot);
  } catch (err) {
    problems.push({ app: STANDALONE_APPS_DIR, message: `cannot stat standalone apps root ${STANDALONE_APPS_DIR}: ${err.message}` });
    return { suites, problems };
  }
  if (appsStat.isSymbolicLink()) {
    problems.push({ app: STANDALONE_APPS_DIR, message: `standalone apps root ${STANDALONE_APPS_DIR} is a symlink/junction — refused (must be a real directory inside the owned root)` });
    return { suites, problems };
  }
  if (!appsStat.isDirectory()) {
    problems.push({ app: STANDALONE_APPS_DIR, message: `standalone apps root ${STANDALONE_APPS_DIR} is not a directory — refused` });
    return { suites, problems };
  }

  let realAppsRoot;
  try {
    realAppsRoot = path.resolve(realpath(appsRoot));
  } catch (err) {
    problems.push({ app: STANDALONE_APPS_DIR, message: `cannot resolve standalone apps root ${STANDALONE_APPS_DIR}: ${err.message}` });
    return { suites, problems };
  }
  if (realAppsRoot !== realRoot && !realAppsRoot.startsWith(realRoot + path.sep)) {
    problems.push({ app: STANDALONE_APPS_DIR, message: `standalone apps root ${STANDALONE_APPS_DIR} resolves outside the owned root (${realAppsRoot}) — refused` });
    return { suites, problems };
  }

  const appEntries = listDirents(appsRoot);
  if (appEntries === null) {
    problems.push({ app: STANDALONE_APPS_DIR, message: `unreadable standalone apps root ${STANDALONE_APPS_DIR}` });
    return { suites, problems };
  }

  for (const ent of appEntries.slice().sort(byName)) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const appDir = path.join(appsRoot, ent.name);
    const appRel = `${STANDALONE_APPS_DIR}/${ent.name}`;

    // A symlinked/junctioned app directory is a discovery boundary that would
    // bypass (link to another app's suite) or escape ownership. Refuse it
    // explicitly instead of letting `!isDirectory()` silently drop it.
    if (ent.isSymbolicLink()) {
      problems.push({ app: appRel, message: `standalone app ${appRel} is a symlink/junction — refused (supported standalone apps must be real directories inside the owned root)` });
      continue;
    }
    if (!ent.isDirectory()) continue;

    // Real dedicated directory + root containment are checked BEFORE any test
    // scope is considered.
    let realAppDir;
    try {
      realAppDir = path.resolve(realpath(appDir));
    } catch (err) {
      problems.push({ app: appRel, message: `cannot resolve standalone app ${appRel}: ${err.message}` });
      continue;
    }
    if (realAppDir !== realRoot && !realAppDir.startsWith(realRoot + path.sep)) {
      problems.push({ app: appRel, message: `standalone app ${appRel} resolves outside the owned root (${realAppDir}) — refused` });
      continue;
    }

    // A manifest-bearing app is owned by the existing Turbo discovery, not here.
    if (fs.existsSync(path.join(appDir, 'package.json'))) continue;

    const testDir = path.join(appDir, STANDALONE_TEST_DIR);
    let testStat;
    try {
      testStat = lstat(testDir);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      problems.push({ app: appRel, message: `cannot stat standalone test directory ${appRel}/${STANDALONE_TEST_DIR}: ${err.message}` });
      continue;
    }
    if (testStat.isSymbolicLink()) {
      problems.push({ app: appRel, message: `standalone test directory ${appRel}/${STANDALONE_TEST_DIR} is a symlink/junction — refused (must be a real directory inside the owned root)` });
      continue;
    }
    if (!testStat.isDirectory()) {
      problems.push({ app: appRel, message: `standalone test directory ${appRel}/${STANDALONE_TEST_DIR} is not a directory — refused` });
      continue;
    }

    const entries = listDirents(testDir);
    if (entries === null) {
      problems.push({ app: appRel, message: `unreadable standalone test directory ${appRel}/${STANDALONE_TEST_DIR}` });
      continue;
    }

    const files = [];
    for (const testEnt of entries.slice().sort(byName)) {
      if (!STANDALONE_TEST_FILE_RE.test(testEnt.name)) continue;
      const abs = path.join(testDir, testEnt.name);
      const rel = `${appRel}/${STANDALONE_TEST_DIR}/${testEnt.name}`;

      let stat;
      try {
        stat = lstat(abs);
      } catch (err) {
        problems.push({ app: appRel, message: `cannot stat standalone test ${rel}: ${err.message}` });
        continue;
      }
      if (stat.isSymbolicLink()) {
        problems.push({
          app: appRel,
          message: `standalone test ${rel} is a symlink — refused (supported standalone tests must be real regular files inside the owned root)`,
        });
        continue;
      }
      if (!stat.isFile()) {
        problems.push({ app: appRel, message: `standalone test ${rel} is not a regular file — refused` });
        continue;
      }

      let real;
      try {
        real = path.resolve(realpath(abs));
      } catch (err) {
        problems.push({ app: appRel, message: `cannot resolve standalone test ${rel}: ${err.message}` });
        continue;
      }
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        problems.push({
          app: appRel,
          message: `standalone test ${rel} resolves outside the owned root (${real}) — refused`,
        });
        continue;
      }

      files.push(abs);
    }

    if (files.length === 0) {
      problems.push({
        app: appRel,
        message: `standalone test scope ${appRel}/${STANDALONE_TEST_DIR} declares no supported *.test.mjs suite — reported rather than silently skipped`,
      });
      continue;
    }

    suites.push({ packageDir: appRel, files, argv: ['--test', ...files] });
  }

  return { suites, problems };
}