/**
 * Runner adapters: one per supported runner, one shared output shape.
 *
 * Five runners (CleanUp3 §7): jest, vitest, node:test, pytest, playwright.
 * Each adapter has two halves:
 *
 *   buildRun(target, ctx)  -> how to invoke the runner so it writes a report
 *   parseReport(payload)   -> turn that report into canonical test records
 *
 * The parse half is pure and fixture-testable: it never spawns a process, so
 * the fixture tests can prove the acceptance behaviour without running a
 * monorepo suite. The build half decides the command and, critically, REUSES
 * the package's existing test command so a config tier is never silently
 * swapped for a different suite.
 */

import path from 'node:path';
import { normalizeSuitePath } from './paths.mjs';
import { makeTest, countTests } from './schema.mjs';

function q(p) {
  const s = String(p);
  return /\s/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/* ------------------------------------------------------------------ jest */

function mapJestLikeStatus(status) {
  switch (status) {
    case 'passed':
    case 'focused':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'skipped':
    case 'disabled':
      return 'skipped';
    case 'todo':
      return 'todo';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'other';
  }
}

/**
 * jest and vitest both emit the same `testResults[].assertionResults[]` JSON
 * shape. Every assertion is pushed as its own occurrence — duplicates are kept.
 */
export function parseJestLike(report, { target, packageDirAbs, packageDirRel, reportPath, nativeRunner }) {
  const tests = [];
  const warnings = [];
  const results = Array.isArray(report.testResults) ? report.testResults : [];
  for (const file of results) {
    const suite = normalizeSuitePath(file.name || file.testFilePath || '', packageDirAbs, packageDirRel);
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    if (assertions.length === 0 && file.status === 'failed') {
      warnings.push({ kind: 'collection-failure', suite, message: 'suite failed without assertions (collection error)' });
    }
    for (const a of assertions) {
      const ancestors = Array.isArray(a.ancestorTitles) ? a.ancestorTitles.slice() : [];
      const fullName = a.fullName || [...ancestors, a.title].filter(Boolean).join(' ');
      tests.push(
        makeTest({
          package: target.package,
          runner: target.runner,
          suite,
          fullName,
          status: mapJestLikeStatus(a.status),
          ancestors,
          file: suite,
          project: a.projectName,
        }),
      );
    }
  }
  return { tests, warnings, nativeRunner: nativeRunner || target.runner, reportPath };
}

/* ---------------------------------------------------------------- vitest */

export function parseVitest(report, ctx) {
  return parseJestLike(report, { ...ctx, nativeRunner: 'vitest' });
}

/* -------------------------------------------------------------- node:test */

/**
 * Canonical node:test report (produced by node-test-reporter.mjs via
 * run-node-test.mjs). Two accepted shapes:
 *   { tests: [ {suite, fullName, status, ancestors?} ] }
 *   { files: [ {suite, tests:[...]} ] }
 */
export function parseNodeTestReport(report, { target, packageDirAbs, packageDirRel, reportPath }) {
  const tests = [];
  const push = (suiteRaw, list) => {
    const suite = normalizeSuitePath(suiteRaw, packageDirAbs, packageDirRel);
    for (const t of list || []) {
      tests.push(
        makeTest({
          package: target.package,
          runner: target.runner,
          suite,
          fullName: t.fullName,
          status: t.status,
          ancestors: t.ancestors,
          file: suite,
        }),
      );
    }
  };
  if (Array.isArray(report.files)) {
    for (const f of report.files) push(f.suite, f.tests);
  } else if (Array.isArray(report.tests)) {
    for (const t of report.tests) {
      push(t.suite ?? '', [t]);
    }
  }
  return { tests, warnings: [], nativeRunner: 'node:test', reportPath };
}

/* ---------------------------------------------------------------- pytest */

/**
 * Parse `pytest --collect-only -q` output. The node ids are COLLECTED tests,
 * not execution pass results — so the canonical status is `collected` and must
 * never be read as "passed".
 */
export function parsePytestCollect(stdout, { target, packageDirAbs, packageDirRel, reportPath }) {
  const tests = [];
  const warnings = [];
  const lines = String(stdout).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^=+.*=+$/.test(line)) continue; // "===== 283 tests collected in 0.20s ====="
    if (/^no tests ran/.test(line)) continue;
    if (line.includes('<Module ') || line.startsWith('<')) continue;
    if (line.includes('::')) {
      const idx = line.indexOf('::');
      const file = normalizeSuitePath(line.slice(0, idx).trim(), packageDirAbs, packageDirRel);
      const name = line.slice(idx + 2).trim();
      if (!file.endsWith('.py')) continue; // guard against warning lines
      tests.push(
        makeTest({
          package: target.package,
          runner: target.runner,
          suite: file,
          fullName: name,
          status: 'collected',
          file,
        }),
      );
    } else if (/\.py$/.test(line)) {
      // A module collected with no test functions: no occurrences, but note it.
      warnings.push({ kind: 'module-without-tests', suite: normalizeSuitePath(line, packageDirAbs, packageDirRel) });
    }
  }
  return { tests, warnings, nativeRunner: 'pytest', reportPath };
}

/* ------------------------------------------------------------- playwright */

function mapPlaywrightStatus(status) {
  switch (status) {
    case 'expected':
    case 'flaky':
      return 'passed';
    case 'unexpected':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'other';
  }
}

/**
 * Parse `playwright test --list --reporter=json`. Suites nest arbitrarily; the
 * spec FILE is carried down onto each spec, and the test fullName is the chain
 * of suite titles beneath the file joined with " > ".
 */
export function parsePlaywrightList(report, { target, packageDirAbs, packageDirRel, reportPath }) {
  const tests = [];
  const walk = (suites, ancestors, file) => {
    for (const s of suites || []) {
      const title = s.title ?? '';
      const nextFile = s.file ? normalizeSuitePath(s.file, packageDirAbs, packageDirRel) : file;
      const isFileNode = Boolean(s.file);
      const nextAncestors = isFileNode ? [] : [...ancestors, title];
      for (const spec of s.specs || []) {
        const firstTest = (spec.tests && spec.tests[0]) || {};
        tests.push(
          makeTest({
            package: target.package,
            runner: target.runner,
            suite: nextFile || '',
            fullName: [...nextAncestors, spec.title ?? ''].filter(Boolean).join(' > '),
            status: mapPlaywrightStatus(firstTest.status || spec.status),
            ancestors: nextAncestors,
            file: nextFile || '',
            project: firstTest.projectName,
          }),
        );
      }
      if (Array.isArray(s.suites)) walk(s.suites, nextAncestors, nextFile);
    }
  };
  walk(report.suites, [], null);
  return { tests, warnings: [], nativeRunner: 'playwright', reportPath };
}

/* ------------------------------------------------------------- buildRun */

/**
 * node:test targets are run one file per process by run-node-test.mjs so each
 * report carries a definite file (suite) identity. `extractNodeTestGlob`
 * recovers the glob from the package's own command.
 */
export function extractNodeTestGlob(command) {
  const m = String(command).match(/(\S*[*?][^\s]*|\S+\.spec\.[cm]?tsx?|\S+\.test\.[cm]?tsx?)/);
  return m ? m[1] : 'src/**/*.spec.ts';
}

export function buildRun(target, ctx) {
  const { root, packageDirAbs, outFile } = ctx;
  const wrapper = path.join(root, 'scripts', 'test-proof', 'run-node-test.mjs');
  const reporter = path.join(root, 'scripts', 'test-proof', 'node-test-reporter.mjs');
  switch (target.runner) {
    case 'jest':
      return {
        cmd: `pnpm exec ${target.command} --json --outputFile=${q(outFile)}`,
        cwd: packageDirAbs,
        reportFile: outFile,
        capture: 'file',
      };
    case 'vitest':
      return {
        cmd: `pnpm exec ${target.command} --reporter=json --outputFile=${q(outFile)}`,
        cwd: packageDirAbs,
        reportFile: outFile,
        capture: 'file',
      };
    case 'node:test':
      if (target.adapter === 'cdk-constructs') {
        // Native infra/cdk adaptation: reuse the driver's own node:test
        // partition (run-construct-tests.cjs --list) and the canonical node:test
        // reporter, so the real spec classification and every identity survive.
        const cdkWrapper = path.join(root, 'scripts', 'test-proof', 'run-cdk-constructs.mjs');
        return {
          cmd: `node ${q(cdkWrapper)} --package-dir ${q(packageDirAbs)} --out ${q(outFile)} --reporter ${q(reporter)}`,
          cwd: packageDirAbs,
          reportFile: outFile,
          capture: 'file',
        };
      }
      return {
        cmd: `node ${q(wrapper)} --package-dir ${q(packageDirAbs)} --out ${q(outFile)} --reporter ${q(reporter)} --glob ${q(extractNodeTestGlob(target.command))}`,
        cwd: packageDirAbs,
        reportFile: outFile,
        capture: 'file',
      };
    case 'pytest':
      return {
        cmd: `${target.command} --collect-only -q`,
        cwd: packageDirAbs,
        reportFile: null,
        capture: 'stdout',
      };
    case 'playwright': {
      if (target.adapter === 'e2e-playwright-wrapper') {
        // @capiro/e2e runs its own source-bound launcher
        // (apps/e2e/scripts/run-playwright.mjs), which resolves the SHARED
        // EXTERNAL pinned Playwright runtime fail-closed. Re-invoke that SAME
        // launcher (never a second copy of the runner, never the raw external
        // CLI path) with --list so collection identity — including project
        // multiplicity — is preserved by the package's own Playwright config.
        const launcher = path.join(packageDirAbs, 'scripts', 'run-playwright.mjs');
        return {
          cmd: `node ${q(launcher)} test --list --reporter=json`,
          cwd: packageDirAbs,
          reportFile: null,
          capture: 'stdout',
        };
      }
      const cli = ctx.playwrightCli || 'C:/dev/node_modules/@playwright/test/cli.js';
      return {
        cmd: `node ${q(cli)} test --list --reporter=json`,
        cwd: packageDirAbs,
        reportFile: null,
        capture: 'stdout',
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: outFile },
      };
    }
    default:
      throw new Error(`no adapter for runner ${target.runner}`);
  }
}

export function parseReport(target, payload, ctx) {
  const meta = {
    target,
    packageDirAbs: ctx.packageDirAbs,
    packageDirRel: ctx.packageDirRel,
    reportPath: ctx.reportPath,
  };
  let result;
  switch (target.runner) {
    case 'jest':
      result = parseJestLike(JSON.parse(payload.text), { ...meta, nativeRunner: 'jest' });
      break;
    case 'vitest':
      result = parseVitest(JSON.parse(payload.text), meta);
      break;
    case 'node:test':
      result = parseNodeTestReport(JSON.parse(payload.text), meta);
      break;
    case 'pytest':
      result = parsePytestCollect(payload.text, meta);
      break;
    case 'playwright':
      result = parsePlaywrightList(JSON.parse(payload.text), meta);
      break;
    default:
      throw new Error(`no parser for runner ${target.runner}`);
  }
  result.counts = countTests(result.tests);
  return result;
}
