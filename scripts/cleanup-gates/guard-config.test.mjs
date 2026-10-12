/**
 * Guard-config validation test (CleanUp1 plan §5.3.4 / §9).
 *
 * A small, fast, dependency-free `node --test` suite that fails if the gate
 * config drifts from live source: a guard file removed, a fifth guard added and
 * left unwired, a package whose runner can no longer be discovered, an
 * unregistered bespoke runner, or the root `gate:cleanup1` script disappearing.
 *
 * Run: `node --test scripts/cleanup-gates/guard-config.test.mjs`
 * (no workspace dependencies, no credentials — safe on a bare checkout).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSyscallTrace } from '../cleanup-script-smoke/attempt-audit.mjs';

import { ARCHITECTURE_GUARDS, MIRROR_VERIFIER, E2E_PACKAGE_DIR, PYTHON_APP_DIR, PLAN_MAPPING, REQUIRED_EVIDENCE, resolveRequiredCoverageScope, RELEVANT_SOURCE_EXT_RE, UNTRACKED_SOURCE_EXCLUSIONS } from './gate-config.mjs';
import { UNCLASSIFIED_RUNNER_QUIRKS } from './lib/quirks.mjs';
import { buildScope } from './lib/scope.mjs';
import { guardRef, UsageError } from './lib/cli.mjs';
import { validateMetrics } from './lib/metrics.mjs';
import { resultsHash } from './verify-baseline.mjs';
import { parsePorcelainZ, trackedDirtyFiles, relevantUntrackedFiles } from './lib/worktree.mjs';
import { provenancePaths } from './lib/provenance.mjs';
import { classifyChild } from '../test-proof/lib/native-child.mjs';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './lib/script-contract.mjs';
import { transformConfigGuard, countEnvReads, countDatabaseUrlTokens } from '../cleanup-script-smoke/config-guard-codemod.mjs';
import { classifyTopLevel, tokenizeCommand, analyzeCommand, resolveDeclaredTargets, discoverEntrypoints, classifyDisposition } from '../cleanup-script-smoke/discover.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

test('onboarding diagnostics do not dirty the gate while adjacent source remains relevant', () => {
  const paths = [
    'apps/e2e/smoke-onboard/test-results/.last-run.json',
    'apps/e2e/smoke-onboard/test-results/trace.json',
    'apps/e2e/smoke-onboard/onboard-smoke.spec.ts',
    'apps/e2e/smoke-onboard/playwright.onboard.config.ts',
    'apps/e2e/smoke-onboard/test-results-extra/probe.json',
    'apps/onboard-web/src/probe.ts',
  ];
  const records = parsePorcelainZ(paths.map((p) => `?? ${p}\0`).join(''));
  assert.deepEqual(relevantUntrackedFiles(records, {
    exclusions: UNTRACKED_SOURCE_EXCLUSIONS,
    extRe: RELEVANT_SOURCE_EXT_RE,
  }), paths.slice(2));
});

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('all four architecture guards exist and are exactly the four expected', () => {
  assert.equal(ARCHITECTURE_GUARDS.length, 4, 'the plan requires exactly four guards');
  const expected = [
    'scripts/check-context-plane-new-bypasses.mjs',
    'scripts/check-evaluation-new-bypasses.mjs',
    'scripts/check-learning-signal-new-bypasses.mjs',
    'scripts/check-quality-telemetry-new-bypasses.mjs',
  ];
  assert.deepEqual([...ARCHITECTURE_GUARDS].sort(), [...expected].sort());
  for (const g of ARCHITECTURE_GUARDS) {
    assert.ok(fs.existsSync(path.join(ROOT, g)), `guard missing: ${g}`);
  }
});

test('the structural mirror verifier exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, MIRROR_VERIFIER)), `mirror verifier missing: ${MIRROR_VERIFIER}`);
});

test('the plan-command mapping covers every named CleanUp1 gate requirement', () => {
  const blob = PLAN_MAPPING.map((m) => `${m.plan} ${m.gate}`).join('\n');
  for (const needle of ['turbo run test', 'turbo run typecheck', 'e2e', 'ruff', 'mypy', 'pytest', 'mirror', 'guard']) {
    assert.ok(blob.toLowerCase().includes(needle.toLowerCase()), `plan mapping is missing a clause for "${needle}"`);
  }
});

test('root package.json exposes the gate:cleanup1 scripts pointing at the driver', () => {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const scripts = pkg.scripts || {};
  for (const name of ['gate:cleanup1', 'gate:cleanup1:core', 'gate:cleanup1:guards', 'gate:cleanup1:python', 'gate:cleanup1:test']) {
    assert.ok(scripts[name], `root script missing: ${name}`);
    assert.match(scripts[name], /cleanup-gates/, `${name} must invoke scripts/cleanup-gates`);
  }
  assert.match(scripts['gate:cleanup1'], /--phase[= ]all/, 'gate:cleanup1 must run the full phase');
});

test('discovery finds packages and every test-bearing package has a classified runner', () => {
  const scope = buildScope(ROOT);
  assert.ok(scope.packages.length > 0, 'no packages discovered');
  assert.ok(scope.testBearingPackages.length >= 10, `unexpectedly few test-bearing packages: ${scope.testBearingPackages.length}`);
  // Every package with a test script must appear in the package map.
  const mapped = new Set(scope.packages.map((p) => p.package));
  for (const p of scope.testBearingPackages) {
    assert.ok(mapped.has(p), `test-bearing package not mapped: ${p}`);
  }
});

test('no unclassified runner segment is left unexplained (fail-closed registry)', () => {
  const scope = buildScope(ROOT);
  assert.deepEqual(
    scope.unexplainedUnsupported.map((u) => `${u.package}:${u.tier}`),
    [],
    'a bespoke runner exists that is not in the quirk registry — triage it explicitly',
  );
  assert.ok(scope.ok, `scope problems: ${scope.problems.join('; ')}`);
});

test('each registered quirk references a live package whose script matches', () => {
  for (const q of UNCLASSIFIED_RUNNER_QUIRKS) {
    const pkgPath = path.join(ROOT, q.packageDir, 'package.json');
    assert.ok(fs.existsSync(pkgPath), `quirk package dir missing: ${q.packageDir}`);
    const pkg = readJson(pkgPath);
    assert.equal(pkg.name, q.package, `quirk package name mismatch for ${q.packageDir}`);
    assert.ok((pkg.scripts || {})[q.script], `quirk script ${q.script} not present on ${q.package}`);
    assert.ok(
      String(pkg.scripts[q.script]).includes(q.command) || String(pkg.scripts.test || '').includes(q.script),
      `quirk command ${q.command} no longer matches ${q.package}#${q.script}`,
    );
  }
});

test('e2e and python app paths are configured (presence validated at gate time, not hidden)', () => {
  assert.ok(E2E_PACKAGE_DIR && E2E_PACKAGE_DIR.startsWith('apps/'));
  assert.ok(PYTHON_APP_DIR && fs.existsSync(path.join(ROOT, PYTHON_APP_DIR, 'pyproject.toml')));
});

// --- Fail-closed corrections (independent review round 2) -------------------

test('guardRef rejects a leading-dash ref and unsafe characters', () => {
  assert.throws(() => guardRef('--output=/tmp/x', { name: '--base' }), UsageError);
  assert.throws(() => guardRef('-D', { name: '--base' }), UsageError);
  assert.throws(() => guardRef('origin/main; rm -rf /', { name: '--base' }), UsageError);
  assert.equal(guardRef('origin/main', { name: '--base' }), 'origin/main');
  assert.equal(guardRef('HEAD~2', { name: '--base' }), 'HEAD~2');
});

test('required coverage scope resolves to exactly the five measured targets', () => {
  const scope = resolveRequiredCoverageScope(ROOT);
  assert.deepEqual(scope.problems, [], `scope problems: ${scope.problems.join('; ')}`);
  const names = scope.required.map((r) => r.package).sort();
  assert.deepEqual(names, [
    '@capiro/api',
    '@capiro/onboard-web',
    '@capiro/web',
    '@capiro/workspace',
    'capiro-defense-budget-parser',
  ]);
});

test('validateMetrics rejects empty/partial metric blocks and accepts a complete one', () => {
  const complete = {
    statements: { total: 100, covered: 80, skipped: 0, pct: 80 },
    branches: { total: 20, covered: 10, skipped: 0, pct: 50 },
    functions: { total: 10, covered: 5, skipped: 0, pct: 50 },
    lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
  };
  assert.deepEqual(validateMetrics('m', complete, { runner: 'jest' }), []);
  assert.ok(validateMetrics('m', undefined, { runner: 'jest' }).length > 0, 'missing metrics must fail');
  assert.ok(validateMetrics('m', { statements: complete.statements }, { runner: 'jest' }).length > 0, 'partial metrics must fail');
  assert.ok(
    validateMetrics('m', { ...complete, statements: { total: 0, covered: 0, skipped: 0, pct: 0 } }, { runner: 'jest' }).some((p) => /empty coverage/.test(p)),
    'zero-total statement coverage must fail',
  );
  assert.ok(
    validateMetrics('m', { ...complete, branches: null }, { runner: 'jest' }).some((p) => /branches/.test(p)),
    'missing branches must fail',
  );
  // Python legitimately has no function totals but MUST have branches.
  const py = {
    statements: { total: 100, covered: 80, skipped: null, pct: 80 },
    branches: { total: 20, covered: 10, skipped: null, pct: 50 },
    functions: null,
    lines: { total: 100, covered: 80, skipped: null, pct: 80 },
  };
  assert.deepEqual(validateMetrics('m', py, { runner: 'pytest-cov' }), []);
  assert.ok(validateMetrics('m', { ...py, branches: null }, { runner: 'pytest-cov' }).length > 0, 'python branch coverage is required');
});

test('script-smoke evidence validator (v4) rejects fabricated evidence and accepts the complete contract', () => {
  const ev = REQUIRED_EVIDENCE.find((e) => e.id === 'script-smoke');
  assert.ok(ev && typeof ev.validate === 'function');
  const A = 'a'.repeat(64);
  const F = 'f'.repeat(64);
  const UNK = '--cleanup-smoke-unknown-flag';
  const CTXKEY = 'invctx::scripts/x.mjs::.';
  const NATIVE_CWD = '/src';
  const NATIVE_SUBJECT = '/src/scripts/x.mjs';
  const BASE = 'docs/plans/cleanup1-smoke-logs/';
  const LOG_REL = `${BASE}x.log`;
  const AUDIT_REL = `${BASE}x.audit.json`;
  const INV_REL = `${BASE}x.invocations.json`;
  const ST_REL = `${BASE}selftest.json`;
  // UNIQUE owned identities per invocation: a shared CID/run/raw path across modes
  // is exactly the reuse the verifier now refuses.
  const MODE_CID = { noArgs: '1'.repeat(64), help: '2'.repeat(64), unknown: '3'.repeat(64) };
  const MODE_RUN = { noArgs: 'run-1-noargs', help: 'run-1-help', unknown: 'run-1-unknown' };
  const OUT = { noArgs: `${BASE}x.noargs.stdout`, help: `${BASE}x.help.stdout`, unknown: `${BASE}x.unknown.stdout` };
  const ERR = { noArgs: `${BASE}x.noargs.stderr`, help: `${BASE}x.help.stderr`, unknown: `${BASE}x.unknown.stderr` };
  const TRACEJ = { noArgs: `${BASE}x.noargs.trace.json`, help: `${BASE}x.help.trace.json`, unknown: `${BASE}x.unknown.trace.json` };
  // The canonical context the CALLER binds (from a synthetic `smokeContexts()`
  // seam) with an independently controlled frozen-volume topology. Every receipt
  // and invocation must carry this COMPLETE context.
  const CANON_CTX = { contextKey: CTXKEY, rel: 'scripts/x.mjs', cwdRel: '.', kind: 'entrypoint', declarationRefs: [], manifestInputs: [], fingerprint: A, valid: true };
  const sha = (s) => createHash('sha256').update(Buffer.from(String(s), 'utf8')).digest('hex');
  const WD_RAW = JSON.stringify(NATIVE_CWD) + '\n';
  const WD_SHA = sha(WD_RAW);
  const WD_BYTES = Buffer.byteLength(WD_RAW, 'utf8');
  const E_SHA = sha('');
  const wdInspectFor = (cid) => ({
    inspectExit: 0, inspectSignal: null, inspectError: null,
    stdoutRaw: WD_RAW, stderrRaw: '',
    stdoutSha256: WD_SHA, stderrSha256: E_SHA, stdoutBytes: WD_BYTES, stderrBytes: 0,
    // The ACTUAL producer shape: `raw` is the EXACT `stdoutRaw.trim()` JSON literal
    // (`"/src"`, quotes included), NOT the decoded native cwd.
    raw: WD_RAW.trim(), parsed: NATIVE_CWD, expected: NATIVE_CWD, verified: true, parseOk: true,
    exactContainerId: cid, contextKey: CTXKEY, reason: null,
  });
  const execLine = (args) => `1234 execve("/usr/bin/node", [${['node', NATIVE_SUBJECT, ...args].map((t) => `"${t}"`).join(', ')}], 0x0) = 0\n`;
  const TEXTS = { noArgs: execLine([]), help: execLine(['--help']), unknown: execLine([UNK]) };
  const M_ARGS = { noArgs: [], help: ['--help'], unknown: [UNK] };
  const TRACE_TEXT = {
    noArgs: `${BASE}x.noargs.trace.txt`,
    help: `${BASE}x.help.trace.txt`,
    unknown: `${BASE}x.unknown.trace.txt`,
  };
  const PRE = { noArgs: `${BASE}x.noargs.prestart.json`, help: `${BASE}x.help.prestart.json`, unknown: `${BASE}x.unknown.prestart.json` };
  const FIN = { noArgs: `${BASE}x.noargs.final.json`, help: `${BASE}x.help.final.json`, unknown: `${BASE}x.unknown.final.json` };
  const auditRecord = { attemptedNetwork: [], attemptedWrites: [], attemptedOther: [] };
  const receipt = (mode, final) => {
    const cid = MODE_CID[mode];
    const runId = MODE_RUN[mode];
    // The ACTUAL producer prestart shape (isolation.mjs prestart): schemaVersion,
    // runId, containerName, containerId, label, subject, modeArgs, image, source,
    // evidenceDir, runtimeConfig/runtimeConfigRel/tsxLoader, invocationContext,
    // contextKey, nativeCwd, nativeSubject, workingDirInspect, createdAt, ownership.
    const base = {
      schemaVersion: 1, runId, containerName: `cleanup-smoke-${runId}`, containerId: cid,
      label: `cleanup-smoke.run=${runId}`, subject: 'scripts/x.mjs', modeArgs: M_ARGS[mode],
      image: 'node:22-alpine', source: { path: 'scripts/x.mjs', sha256: A }, evidenceDir: '/evidence',
      runtimeConfig: null, runtimeConfigRel: null, tsxLoader: null,
      invocationContext: CANON_CTX, contextKey: CTXKEY, nativeCwd: NATIVE_CWD, nativeSubject: NATIVE_SUBJECT,
      workingDirInspect: wdInspectFor(cid), createdAt: '2026-10-10T00:00:00.000Z',
      ownership: { verified: true, inspectExit: 0, raw: `${cid}|${runId}` },
    };
    // The ACTUAL producer final-receipt shape (isolation.mjs finalRec): the prestart
    // fields spread, then startExit/waitExit/logsExit/startFailed/logsUnavailable/
    // waitUnavailable/waitDeadline/containerExit/timedOut/removal/finishedAt. There
    // is NO `started` boolean — a successful start is proven by the finite, explicit
    // transport facts plus a finite containerExit matching this invocation.
    return final
      ? { ...base, startExit: 0, waitExit: 0, logsExit: 0, startFailed: false, logsUnavailable: false, waitUnavailable: false, waitDeadline: false, containerExit: mode === 'help' ? 0 : 2, timedOut: false, removal: { removed: true, unknown: false, detail: 'removed' }, finishedAt: '2026-10-10T00:00:01.000Z' }
      : base;
  };
  const mkInv = (mode, exit) => ({
    argv: ['node', NATIVE_SUBJECT, ...M_ARGS[mode]], exit, signal: null, spawnError: null, timedOut: false,
    usagePrinted: true, entrypointExecuted: true, traceName: `${mode}.trace`, args: M_ARGS[mode], out: 'usage\n', err: '',
    runtimeConfig: null, runtimeConfigRel: null, tsxLoader: null, runtimeContext: 'none',
    contextKey: CTXKEY, cwdRel: '.', nativeCwd: NATIVE_CWD, nativeSubject: NATIVE_SUBJECT, containerId: MODE_CID[mode],
    workingDirInspect: wdInspectFor(MODE_CID[mode]), audit: auditRecord,
    stdoutRawPath: OUT[mode], stdoutRawSha256: A, stderrRawPath: ERR[mode], stderrRawSha256: A,
    traceRawPath: TRACEJ[mode], traceRawSha256: A, traceTextRawPath: TRACE_TEXT[mode], traceTextRawSha256: A,
    prestartRawPath: PRE[mode], prestartRawSha256: A, finalRawPath: FIN[mode], finalRawSha256: A,
  });
  const contextRecord = {
    contextKey: CTXKEY, rel: 'scripts/x.mjs', cwdRel: '.', kind: 'entrypoint',
    declarationRefs: [], declarations: [], manifestInputs: [], fingerprint: A, status: 'ok', reasons: [],
    invocations: { noArgs: mkInv('noArgs', 2), help: mkInv('help', 0), unknown: mkInv('unknown', 2) },
  };
  const invRecord = {
    subject: 'scripts/x.mjs',
    sourceSha256: A,
    contexts: [contextRecord],
    invocations: contextRecord.invocations,
  };
  const selfTest = { subject: 'containment-selftest', network: { target: '1.1.1.1:80', denied: true }, write: { target: '/probe-write-selftest', denied: true } };
  const RAW = {
    [LOG_REL]: '$ node scripts/x.mjs\n--- stdout ---\nusage: x <file>\n--- exit 2 ---\n',
    [AUDIT_REL]: JSON.stringify(auditRecord),
    [INV_REL]: JSON.stringify(invRecord),
    [ST_REL]: JSON.stringify(selfTest),
    [OUT.noArgs]: 'usage: x <file>\n', [OUT.help]: 'usage: x <file>\n', [OUT.unknown]: 'usage: x <file>\n',
    [ERR.noArgs]: '', [ERR.help]: '', [ERR.unknown]: '',
    [TRACEJ.noArgs]: JSON.stringify(auditRecord), [TRACEJ.help]: JSON.stringify(auditRecord), [TRACEJ.unknown]: JSON.stringify(auditRecord),
    [TRACE_TEXT.noArgs]: TEXTS.noArgs,
    [TRACE_TEXT.help]: TEXTS.help,
    [TRACE_TEXT.unknown]: TEXTS.unknown,
    [PRE.noArgs]: JSON.stringify(receipt('noArgs', false)), [FIN.noArgs]: JSON.stringify(receipt('noArgs', true)),
    [PRE.help]: JSON.stringify(receipt('help', false)), [FIN.help]: JSON.stringify(receipt('help', true)),
    [PRE.unknown]: JSON.stringify(receipt('unknown', false)), [FIN.unknown]: JSON.stringify(receipt('unknown', true)),
  };
  const SPECS = ['scripts/cleanup-script-smoke', 'scripts/x.mjs', 'package.json', 'pnpm-workspace.yaml'];
  const good = {
    schema: 'capiro.cleanup1-script-smoke-evidence',
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    run: { complete: true, partial: false },
    source: { commitSha: 'HEAD', fingerprintAlgorithm: 'sha256-ls-tree-v2', fingerprint: F, specs: SPECS },
    discovery: { subjects: [{ path: 'scripts/x.mjs', source: 'root scripts/*.mjs' }], count: 1 },
    isolation: {
      networkDenied: true,
      hostWriteDenied: true,
      mechanism: 'docker node:22-alpine --network none --read-only (+/tmp tmpfs, owned evidence rw)',
      proof: {
        exercised: true,
        networkAttempts: [{ subject: 'containment-selftest', kind: 'net.connect', target: '1.1.1.1:80', denied: true }],
        writeAttempts: [{ subject: 'containment-selftest', kind: 'fs.write', target: '/probe-write-selftest', denied: true }],
      },
      selfTestRawPath: ST_REL,
      selfTestRawSha256: A,
    },
    results: [
      {
        path: 'scripts/x.mjs',
        status: 'ok',
        sourceSha256: A,
        contract: { noArgs: { exit: 2, usagePrinted: true }, help: { supported: true, exit: 0, usagePrinted: true } },
        noArgs: { exit: 2, usagePrinted: true, timedOut: false },
        help: { supported: true, exit: 0, usagePrinted: true, timedOut: false },
        audit: { attemptedNetwork: [], attemptedWrites: [], attemptedOther: [] },
        native: { argv: ['node', NATIVE_SUBJECT], exit: 2, signal: null, spawnError: null },
        rawLogPath: LOG_REL,
        rawLogSha256: A,
        auditRawPath: AUDIT_REL,
        auditRawSha256: A,
        invocationsRawPath: INV_REL,
        invocationsRawSha256: A,
        contexts: [{ contextKey: CTXKEY, rel: 'scripts/x.mjs', cwdRel: '.', kind: 'entrypoint', declarationRefs: [], manifestInputs: [], fingerprint: A }],
      },
    ],
    rawLogHashes: { 'scripts/x.mjs': A },
  };
  const ctx = {
    root: '/',
    resolve: (p) => p,
    existsSync: () => true,
    sha256File: () => A,
    readFile: (p) => (p in RAW ? RAW[p] : ''),
    // v5 streaming trace capability: hash + parse the trace text in bounded reads.
    readAndParseTraceFileSync: (abs) => {
      const text = abs in RAW ? RAW[abs] : '';
      return { sha256: A, bytes: Buffer.byteLength(text, 'utf8'), ...parseSyscallTrace(text) };
    },
    commitExists: () => true,
    isAncestorOfHead: () => true,
    fingerprintAlgorithm: 'sha256-ls-tree-v2',
    fingerprintAt: () => ({ ok: true, fingerprint: F }),
    // Synthetic-root seams: the exact {subjects, specs} and canonical context set a
    // real canonical discovery/context derivation would return for this fixture.
    smokeScope: () => ({
      subjects: [{ path: 'scripts/x.mjs', source: 'root scripts/*.mjs' }],
      specs: SPECS,
    }),
    smokeContexts: () => [CANON_CTX],
    specExistsAtCommit: () => true,
    contractFor: () => ({ noArgs: { exit: 2, usagePrinted: true }, help: { supported: true, exit: 0, usagePrinted: true }, evidence: 'mock' }),
    sourceShaAt: () => A,
    trackedAndClean: () => ({ tracked: true, clean: true }),
    contained: () => true,
    // The INDEPENDENTLY CONTROLLED caller-bound native topology: a frozen-volume
    // subject-deps run mounts the read-only `/src` volume, so the absolute native
    // subject/cwd (`/src/...`) are DERIVED from current source — never taken from
    // the untrusted invocation self-report.
    nativeTopology: { mode: 'frozen-volume' },
  };
  const withResult = (r) => ({ ...good, results: [{ ...good.results[0], ...r }] });
  const withInv = (mut) => ({ ...ctx, readFile: (p) => (p === INV_REL ? JSON.stringify(mut(invRecord)) : p in RAW ? RAW[p] : '') });

  assert.deepEqual(ev.validate(good, ctx), [], 'a complete v5 context-bound contract must pass');
  assert.ok(ev.validate({}).length > 0, 'an empty object must fail');
  assert.ok(ev.validate(null).length > 0, 'null must fail');
  // partial run / incomplete declaration
  assert.ok(ev.validate({ ...good, run: { complete: true, partial: true } }, ctx).some((p) => /partial/.test(p)));
  assert.ok(ev.validate({ ...good, run: { complete: false, partial: false } }, ctx).some((p) => /complete must be true/.test(p)));
  // invented source fingerprint algorithm / digest
  assert.ok(ev.validate({ ...good, source: { ...good.source, fingerprintAlgorithm: 'invented' } }, ctx).some((p) => /supported algorithm/.test(p)));
  assert.ok(ev.validate({ ...good, source: { ...good.source, fingerprint: 'b'.repeat(64) } }, ctx).some((p) => /does not match the actual measured source/.test(p)));
  // failed status
  assert.ok(ev.validate(withResult({ status: 'failed' }), ctx).some((p) => /not "ok"/.test(p)));
  // documented exit codes, silence is not usage, definite timedOut
  assert.ok(ev.validate(withResult({ noArgs: { exit: 99, usagePrinted: true, timedOut: false } }), ctx).some((p) => /documented 2/.test(p)));
  assert.ok(ev.validate(withResult({ noArgs: { exit: 2, usagePrinted: false, timedOut: false } }), ctx).some((p) => /silence is not usage/.test(p)));
  assert.ok(ev.validate(withResult({ noArgs: { exit: 2, usagePrinted: true } }), ctx).some((p) => /DEFINITE false/.test(p)));
  // recorded forbidden attempt
  assert.ok(ev.validate(withResult({ audit: { attemptedNetwork: [{ attempt: 'x' }], attemptedWrites: [], attemptedOther: [] } }), ctx).some((p) => /forbidden access/.test(p)));
  // unproven help.supported:false while source has help
  assert.ok(ev.validate(withResult({ help: { supported: false } }), ctx).some((p) => /HAS a help\/usage handler/.test(p)));
  // unexercised isolation proof
  assert.ok(ev.validate({ ...good, isolation: { ...good.isolation, proof: { exercised: true, networkAttempts: [], writeAttempts: [] } } }, ctx).some((p) => /networkAttempts/.test(p)));
  // absent raw log / forged hash / untracked raw
  assert.ok(ev.validate(good, { ...ctx, existsSync: () => false }).some((p) => /not found/.test(p)));
  assert.ok(ev.validate(good, { ...ctx, sha256File: () => 'b'.repeat(64) }).some((p) => /mutated or fabricated/.test(p)));
  assert.ok(ev.validate(good, { ...ctx, trackedAndClean: () => ({ tracked: false, clean: false }) }).some((p) => /not a committed \(tracked\) file/.test(p)));
  // outside/absolute raw path
  assert.ok(ev.validate(withResult({ rawLogPath: 'C:/x/y.log' }), ctx).some((p) => /repo-relative path inside the repository/.test(p)));
  // incomplete discovery
  assert.ok(ev.validate({ ...good, discovery: { subjects: [{ path: 'scripts/y.mjs', source: 'root' }], count: 1 } }, ctx).some((p) => /INCOMPLETE|not a current-source entrypoint/.test(p)));
  // native binding
  assert.ok(ev.validate(withResult({ native: { argv: ['node', 'other.mjs'], exit: 2, signal: null, spawnError: null } }), ctx).some((p) => /does not end with the entrypoint path/.test(p)));

  // ---- round-5 forgery cases: raw records must be PARSED and bound ----------
  assert.ok(ev.validate(good, { ...ctx, readFile: (p) => (p === INV_REL ? 'no invocation here' : p in RAW ? RAW[p] : '') }).some((p) => /not valid JSON/.test(p)));
  assert.ok(ev.validate(good, { ...ctx, readFile: (p) => (p === AUDIT_REL ? 'not an audit' : p in RAW ? RAW[p] : '') }).some((p) => /not valid JSON/.test(p)));
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { ...rec.invocations, help: { ...rec.invocations.help, entrypointExecuted: false } } }))).some((p) => /entry point did NOT execute|unexecuted help|entrypointExecuted must be true/.test(p)));
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { noArgs: rec.invocations.noArgs } }))).some((p) => /missing execution must fail|help\) is required/.test(p)));
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { ...rec.invocations, noArgs: { ...rec.invocations.noArgs, entrypointExecuted: false } } }))).some((p) => /entrypointExecuted must be true/.test(p)));
  assert.ok(ev.validate(withResult({ native: { argv: ['node', NATIVE_SUBJECT], exit: 99, signal: null, spawnError: null } }), ctx).some((p) => /inconsistent native exit/.test(p)));
  assert.ok(ev.validate(withResult({ audit: { attemptedNetwork: [{ kind: 'invented' }], attemptedWrites: [], attemptedOther: [] } }), ctx).some((p) => /parsed raw audit record|forbidden access/.test(p)));
  assert.ok(ev.validate(withResult({ auditRawPath: undefined, auditRawSha256: undefined }), ctx).some((p) => /auditRawPath is required/.test(p)));
  assert.ok(ev.validate({ ...good, isolation: { ...good.isolation, selfTestRawPath: undefined, selfTestRawSha256: undefined } }, ctx).some((p) => /selfTestRawPath is required/.test(p)));
  assert.ok(ev.validate(good, { ...ctx, readFile: (p) => (p === ST_REL ? 'denied: true' : p in RAW ? RAW[p] : '') }).some((p) => /not valid JSON/.test(p)));

  // ---- round-6 forgery cases: raw binding + bidirectional cross-checks ------
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { ...rec.invocations, help: { ...rec.invocations.help, argv: ['node', '--help'] } } }))).some((p) => /does not reference the entrypoint/.test(p)));
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { ...rec.invocations, noArgs: { ...rec.invocations.noArgs, usagePrinted: false } } }))).some((p) => /raw no-args record/.test(p)));
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { ...rec.invocations, noArgs: { ...rec.invocations.noArgs, traceRawPath: undefined, traceRawSha256: undefined } } }))).some((p) => /traceRawPath is required/.test(p)));

  // ---- round-11 cases: explicit smoke scope + per-invocation audit binding ---
  assert.ok(ev.validate({ ...good, source: { ...good.source, specs: ['scripts/cleanup-script-smoke'] } }, ctx).some((p) => /source\.specs|independently-derived smoke scope/.test(p)));
  assert.ok(ev.validate({ ...good, source: { commitSha: 'HEAD', fingerprintAlgorithm: 'sha256-ls-tree-v2', fingerprint: F } }, ctx).some((p) => /source\.specs must be a non-empty array/.test(p)));
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { ...rec.invocations, help: { ...rec.invocations.help, audit: { attemptedNetwork: [{ kind: 'invented' }], attemptedWrites: [], attemptedOther: [] } } } }))).some((p) => /own audit/.test(p)));
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { ...rec.invocations, noArgs: { ...rec.invocations.noArgs, audit: { attemptedNetwork: [{ kind: 'x' }], attemptedWrites: [], attemptedOther: [] } } } }))).some((p) => /noArgs invocation audit/.test(p)));

  // ---- round-12 cases: raw syscall TEXT (streamed) + per-invocation audit ----
  const drop = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { ...rec.invocations, noArgs: drop(rec.invocations.noArgs, 'audit') } }))).some((p) => /\.audit is required/.test(p)));
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, invocations: { ...rec.invocations, noArgs: drop(rec.invocations.noArgs, 'traceTextRawPath', 'traceTextRawSha256') } }))).some((p) => /traceTextRawPath is required/.test(p)));
  // an EMPTY streamed trace is not evidence (bytes:0).
  const emptyStream = { ...ctx, readAndParseTraceFileSync: (abs) => (abs === TRACE_TEXT.noArgs ? { sha256: A, bytes: 0, ...parseSyscallTrace('') } : ctx.readAndParseTraceFileSync(abs)) };
  assert.ok(ev.validate(good, emptyStream).some((p) => /is empty/.test(p)));
  // a trace with NO subject entrypoint execve (bootstrap only) is rejected.
  const bootstrap = { ...ctx, readAndParseTraceFileSync: (abs) => (abs === TRACE_TEXT.noArgs ? { sha256: A, bytes: 40, ...parseSyscallTrace('1 execve("/usr/bin/docker-init", ["docker-init"], 0x0) = 0\n') } : ctx.readAndParseTraceFileSync(abs)) };
  assert.ok(ev.validate(good, bootstrap).some((p) => /no subject entrypoint execve/.test(p)));
  // a FORGED clean audit is caught: the raw text shows a denied network attempt.
  const forgedText = '1 connect(3, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr("1.1.1.1")}, 16) = -1 ENETUNREACH\n' + TEXTS.noArgs;
  const forged = { ...ctx, readAndParseTraceFileSync: (abs) => (abs === TRACE_TEXT.noArgs ? { sha256: A, bytes: Buffer.byteLength(forgedText), ...parseSyscallTrace(forgedText) } : ctx.readAndParseTraceFileSync(abs)) };
  assert.ok(ev.validate(good, forged).some((p) => /do not match the invocation audit/.test(p)));

  // ---- v5 cases: the complete canonical CONTEXT SET is required -------------
  // a result missing its declared context set is rejected (no context-free evidence).
  assert.ok(ev.validate(withResult({ contexts: undefined }), ctx).some((p) => /\.contexts is required/.test(p)));
  // a result whose declared context set differs from the canonical set is rejected.
  assert.ok(ev.validate(withResult({ contexts: [] }), ctx).some((p) => /canonical current-source context set/.test(p)));
  // an extra/foreign context in the raw invocation record is rejected.
  const foreignCtx = { contextKey: 'invctx::scripts/x.mjs::apps/api', rel: 'scripts/x.mjs', cwdRel: 'apps/api', kind: 'entrypoint', declarationRefs: [], declarations: [], manifestInputs: [], fingerprint: A, status: 'ok', reasons: [], invocations: contextRecord.invocations };
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [...rec.contexts, foreignCtx] }))).some((p) => /not a canonical current-source context|duplicate|canonical current-source context set/.test(p)));
  // a MISSING canonical context in the raw invocation record is rejected.
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [] }))).some((p) => /MISSING from the raw invocation record/.test(p)));
  // a wrong-cwd context is rejected.
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [{ ...rec.contexts[0], cwdRel: 'apps/api' }] }))).some((p) => /cwdRel|canonical current-source context set/.test(p)));
  // a stale/forged context fingerprint is rejected.
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [{ ...rec.contexts[0], fingerprint: 'b'.repeat(64) }] }))).some((p) => /canonical current-source provenance|fingerprint/.test(p)));

  // ---- v5 cases: real returned CID + lossless WorkingDir + lifecycle --------
  // a missing returned container CID is REFUSED (no missing-CID fallback).
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [{ ...rec.contexts[0], invocations: { ...rec.contexts[0].invocations, noArgs: { ...rec.contexts[0].invocations.noArgs, containerId: null } } }] }))).some((p) => /REAL returned 64-hex container id|workingDirInspect.exactContainerId/.test(p)));
  // a mismatched WorkingDir (parsed != expected) is REFUSED.
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [{ ...rec.contexts[0], invocations: { ...rec.contexts[0].invocations, noArgs: { ...rec.contexts[0].invocations.noArgs, workingDirInspect: { ...wdInspectFor(MODE_CID.noArgs), parsed: '/src/other', expected: '/src/other', verified: false } } } }] }))).some((p) => /workingDirInspect expected\/parsed|workingDirInspect.verified/.test(p)));
  // a lifecycle receipt whose bytes do NOT hash to the recorded digest is REFUSED.
  assert.ok(ev.validate(good, { ...ctx, sha256File: (p) => (p === PRE.noArgs ? 'd'.repeat(64) : A) }).some((p) => /mutated or fabricated/.test(p)));
  // a missing final lifecycle receipt is REFUSED.
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [{ ...rec.contexts[0], invocations: { ...rec.contexts[0].invocations, noArgs: { ...rec.contexts[0].invocations.noArgs, finalRawPath: undefined, finalRawSha256: undefined } } }] }))).some((p) => /finalRawPath is required|final lifecycle receipt/.test(p)));
  // a lifecycle receipt that does not prove removal is REFUSED.
  assert.ok(ev.validate(good, { ...ctx, readFile: (p) => (p === FIN.noArgs ? JSON.stringify({ ...receipt('noArgs', true), removal: { removed: false, unknown: false, detail: 'still-present' } }) : p in RAW ? RAW[p] : '') }).some((p) => /actually removed|removal/.test(p)));

  // ---- v5 cases: a missing streaming trace capability fails closed ----------
  const noStream = { ...ctx };
  delete noStream.readAndParseTraceFileSync;
  assert.ok(ev.validate(good, noStream).some((p) => /no streaming trace capability/.test(p)));

  // ---- ONE global raw-file identity + duplicate owned CID/run ---------------
  // Cross-MODE raw path reuse: a file identity serving two different invocations.
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [{ ...rec.contexts[0], invocations: { ...rec.contexts[0].invocations, help: { ...rec.contexts[0].invocations.help, stdoutRawPath: OUT.noArgs } } }] }))).some((p) => /reuses an owned raw file identity/.test(p)));
  // Cross-ROLE reuse WITHIN one invocation (its stdout path reused for the trace).
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [{ ...rec.contexts[0], invocations: { ...rec.contexts[0].invocations, noArgs: { ...rec.contexts[0].invocations.noArgs, traceRawPath: OUT.noArgs } } }] }))).some((p) => /reuses an owned raw file identity/.test(p)));
  // An ALIAS spelling of an already-owned path still collides (normalised identity).
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [{ ...rec.contexts[0], invocations: { ...rec.contexts[0].invocations, help: { ...rec.contexts[0].invocations.help, stdoutRawPath: `./${OUT.noArgs}` } } }] }))).some((p) => /reuses an owned raw file identity/.test(p)));
  // Duplicate owned container id across modes: a GENUINELY REUSED owned identity.
  // The help invocation AND both of its lifecycle receipts are mutated/re-hashed to
  // the noArgs CID/run/ownership/WorkingDir (retaining the exact expected
  // mode/context/source and every other valid fact), so the ONLY violation is the
  // reuse itself — NOT a receipt-vs-returned-CID mismatch. This asserts the actual
  // duplicate-identity rejection (`reuses the containerId`).
  {
    const reusedCid = MODE_CID.noArgs;
    const reusedRun = MODE_RUN.noArgs;
    const reusedWd = wdInspectFor(reusedCid);
    const reusedHelpInv = { ...contextRecord.invocations.help, containerId: reusedCid, workingDirInspect: reusedWd };
    const reusedReceipt = (final) => ({
      ...receipt('help', final),
      runId: reusedRun,
      containerName: `cleanup-smoke-${reusedRun}`,
      containerId: reusedCid,
      label: `cleanup-smoke.run=${reusedRun}`,
      workingDirInspect: reusedWd,
      ownership: { verified: true, inspectExit: 0, raw: `${reusedCid}|${reusedRun}` },
    });
    const reusedCtx = {
      ...ctx,
      readFile: (p) =>
        p === INV_REL
          ? JSON.stringify({ ...invRecord, contexts: [{ ...contextRecord, invocations: { ...contextRecord.invocations, help: reusedHelpInv } }], invocations: { ...contextRecord.invocations, help: reusedHelpInv } })
          : p === PRE.help
            ? JSON.stringify(reusedReceipt(false))
            : p === FIN.help
              ? JSON.stringify(reusedReceipt(true))
              : p in RAW
                ? RAW[p]
                : '',
    };
    assert.ok(
      ev.validate(good, reusedCtx).some((p) => /reuses the containerId/.test(p)),
      'a genuinely reused owned container identity must be rejected as a duplicate identity',
    );
  }
  // SEPARATE negative: a returned CID that DISAGREES with the immutable receipt CID
  // (scalar fields kept self-consistent on the invocation only) is a receipt-vs-
  // returned-CID mismatch — distinct from the genuine reuse above.
  assert.ok(ev.validate(good, withInv((rec) => ({ ...rec, contexts: [{ ...rec.contexts[0], invocations: { ...rec.contexts[0].invocations, help: { ...rec.contexts[0].invocations.help, containerId: MODE_CID.noArgs, workingDirInspect: wdInspectFor(MODE_CID.noArgs) } } }] }))).some((p) => /lifecycle receipt containerId|REAL returned 64-hex/.test(p)));
});

test('isSafeRelPath rejects absolute/traversal/outside evidence paths', async () => {
  const { isSafeRelPath } = await import('./lib/smoke-evidence.mjs');
  for (const bad of ['/etc/passwd', 'C:/x', '\\\\server\\share', '../x', 'a/../../b', 'a//b', '']) assert.equal(isSafeRelPath(bad), false, `must reject ${JSON.stringify(bad)}`);
  for (const okp of ['docs/plans/x.log', 'scripts/x.mjs', 'a/b/c.json']) assert.equal(isSafeRelPath(okp), true, `must accept ${okp}`);
});

test('untracked source inside a NEW directory is detected (porcelain -z -uall)', () => {
  // Default porcelain collapses this to "?? apps/api/src/newdir/" and the old
  // extension regex missed it; -z -uall expands to the real file.
  const z = '?? apps/api/src/cleanup-orchestrator-untracked-probe-20261007/probe.ts\0?? scratch.notes.txt\0';
  const recs = parsePorcelainZ(z);
  const rel = relevantUntrackedFiles(recs, { exclusions: [], extRe: RELEVANT_SOURCE_EXT_RE });
  assert.deepEqual(rel, ['apps/api/src/cleanup-orchestrator-untracked-probe-20261007/probe.ts']);
});

test('worktree parsing separates tracked changes, untracked source and exclusions', () => {
  const z = ' M apps/web/src/a.ts\0?? apps/api/src/probe/probe.ts\0?? .artifacts/cleanup1/x.json\0R  new.ts\0old.ts\0';
  const recs = parsePorcelainZ(z);
  assert.deepEqual(trackedDirtyFiles(recs), [' M apps/web/src/a.ts', 'R  new.ts']);
  assert.deepEqual(relevantUntrackedFiles(recs, { exclusions: ['.artifacts/'], extRe: RELEVANT_SOURCE_EXT_RE }), ['apps/api/src/probe/probe.ts']);
});

test('classifyChild requires a definite integer 0 status (no null/signal success)', () => {
  assert.equal(classifyChild({ status: 0, signal: null }).definiteZero, true);
  assert.equal(classifyChild({ status: null, signal: 'SIGKILL' }).definiteZero, false, 'a signalled child is not success');
  assert.equal(classifyChild({ status: null, signal: null, error: new Error('spawn ENOENT') }).definiteZero, false, 'a spawn error is not success');
  assert.equal(classifyChild({ status: null, signal: null }).definiteZero, false, 'a null status is not success');
  assert.equal(classifyChild({ status: 1 }).definiteZero, false);
});

test('measured-source fingerprint covers production source, not just manifests', () => {
  const specs = provenancePaths(ROOT);
  for (const required of ['apps', 'packages', 'infra', 'pnpm-lock.yaml', 'turbo.json', 'scripts/cleanup-gates', 'scripts/test-proof', '.github/workflows']) {
    assert.ok(specs.includes(required), `measured-source spec set must include ${required}`);
  }
});

test('resultsHash is deterministic and content-sensitive', () => {
  const a = [{ package: 'x', suiteExitCode: 0 }];
  assert.equal(resultsHash(a), resultsHash([{ package: 'x', suiteExitCode: 0 }]));
  assert.notEqual(resultsHash(a), resultsHash([{ package: 'x', suiteExitCode: 1 }]));
});

// --- Review round 7: conservative AST side-effect fixtures (pos + neg) ------

test('AST entrypoint classification: side-effecting declarations are entrypoints, pure declarations are helpers', () => {
  const isEntry = (src, name = 'probe.mjs') => classifyTopLevel(src, name).executable === true;
  const isHelper = (src, name = 'probe.mjs') => classifyTopLevel(src, name).executable === false;

  // NEGATIVE fixtures — genuinely pure declaration-only files must stay helpers
  // (never over-promoted to executed smoke subjects). TS-only constructs use a
  // .ts probe so they are parsed as TypeScript, not rejected as a JS parse error.
  assert.ok(isHelper('import fs from "node:fs";\nexport function f() { return 1; }\nclass C { m() {} }\n'), 'imports / function / pure class are declarations-only');
  assert.ok(isHelper('export default { a: 1, b: 2 };\n'), 'a pure export-assignment object is declarations-only');
  assert.ok(isHelper('enum E { A, B }\n', 'probe.ts'), 'a constant enum is declarations-only');
  assert.ok(isHelper('namespace N { export const x = 1; }\n', 'probe.ts'), 'a namespace of pure const declarations is declarations-only');

  // POSITIVE fixtures — each performs work at load/definition time and must be
  // treated as an entrypoint (review round 7: class / static / enum / namespace
  // / computed / export assignment).
  assert.ok(isEntry('export default main();\n'), 'export default <call> evaluates work');
  assert.ok(isEntry('export default class { static x = work(); }\n'), 'export default class with a static initializer evaluates work');
  assert.ok(isEntry('class C { static x = compute(); }\n'), 'static property initializer evaluates work');
  assert.ok(isEntry('class C { static { run(); } }\n'), 'static block evaluates work');
  assert.ok(isEntry('enum E { A = sideEffect(), B }\n', 'probe.ts'), 'non-constant enum member initializer evaluates work');
  assert.ok(isEntry('namespace N { run(); }\n', 'probe.ts'), 'namespace body execution is an entrypoint');
  assert.ok(isEntry('const o = { [key()]: 1 };\n'), 'a computed object key evaluates work');
});

test('documented CLI contract derivation is source-bound, reachability-aware and fails closed', () => {
  // POSITIVE fixture — a real sliced-argv no-args branch, plus a positive
  // --help include test, both emitting an actual usage literal.
  const good = [
    'const args = process.argv.slice(2);',
    "if (args.length === 0) { console.error('usage: x <file>'); process.exit(2); }",
    "if (args.includes('--help')) { console.log('usage: x <file>'); process.exit(0); }",
  ].join('\n');
  const c = deriveContract(good, 'probe.mjs');
  assert.equal(c.noArgs.documented, true, 'a real sliced-argv length branch is documented usage');
  assert.equal(c.noArgs.exit, 2, 'the explicit process.exit(2) is the documented exit');
  assert.equal(c.help.supported, true, 'a positive --help include test is help support');
  assert.equal(c.help.exit, 0, 'the explicit process.exit(0) is the documented help exit');

  const slicedGuard = "if (args.length === 0) { console.error('usage: x <file>'); process.exit(2); }";
  for (const before of [
    'args.push("fake");',
    'args.length = 1;',
    'consume(args);',
  ]) {
    const mutated = `const args = process.argv.slice(2); ${before} ${slicedGuard}`;
    assert.equal(deriveContract(mutated, 'probe.mjs').noArgs.documented, false,
      `a sliced argv alias changed or escaped by ${before} does not prove zero length`);
  }
  const captured = `const args = process.argv.slice(2); function main() { ${slicedGuard} } main();`;
  assert.equal(deriveContract(captured, 'probe.mjs').noArgs.documented, false,
    'a sliced argv alias captured across function scopes is not proven initialized');

  // POSITIVE fixture — a REACHABLE called main: its process.argv branches count
  // because `main()` is invoked at the top level (canonical reachability).
  const mainSrc = [
    'function main() {',
    "  if (process.argv.length <= 2) { console.error('usage: main'); process.exit(2); }",
    "  if (process.argv.includes('--help')) { console.log('usage: main'); process.exit(0); }",
    '}',
    'main();',
  ].join('\n');
  const mc = deriveContract(mainSrc, 'probe.mjs');
  assert.equal(mc.noArgs.documented, true, 'a reachable called main is documented');
  assert.equal(mc.noArgs.exit, 2);
  assert.equal(mc.help.supported, true);
  assert.equal(mc.help.exit, 0);

  // ROUND-8 NEGATIVE 1 — ordinary console output is NOT usage text.
  const ordinary = "const args=process.argv.slice(2); if(args.length===0){console.log('ordinary progress');process.exit(7);}";
  assert.equal(deriveContract(ordinary, 'probe.mjs').noArgs.documented, false, 'a console default call is not usage');

  // ROUND-8 NEGATIVE 2 — naming a variable args/argv is NOT binding it to process.argv.
  const unbound = "const args=[]; if(args.length===0){console.log('usage: unrelated');process.exit(7);} if(args.includes('--help')){console.log('usage: unrelated');process.exit(0);}";
  const ub = deriveContract(unbound, 'probe.mjs');
  assert.equal(ub.noArgs.documented, false, 'an unbound args array is not argv');
  assert.equal(ub.help.supported, false, 'an unbound args array is not help argv');

  // ROUND-8 NEGATIVE 3 — a help branch inside an UNCALLED function is not reachable.
  const unreachable = "function unused(){ if(process.argv.includes('--help')){ console.log('usage: unused'); process.exit(0); } } console.log('actual entrypoint');";
  assert.equal(deriveContract(unreachable, 'probe.mjs').help.supported, false, 'an uncalled function branch is not reachable help');

  // ROUND-8 NEGATIVE 4 — a constant '--help' comparison is not an argv operand.
  const constant = "if('constant'==='--help'){console.log('usage: never');process.exit(0);}";
  assert.equal(deriveContract(constant, 'probe.mjs').help.supported, false, 'a constant comparison is not an argv help test');

  // PRESERVED NEGATIVES — an unrelated collection length and a NEGATED --help.
  const neg = [
    'const files = [];',
    "if (files.length === 0) { console.log('usage: y'); }",
    "if (!process.argv.includes('--help')) { console.log('not help'); }",
  ].join('\n');
  const n = deriveContract(neg, 'probe.mjs');
  assert.equal(n.noArgs.documented, false, 'an unrelated .length is not a no-args argv branch');
  assert.equal(n.help.supported, false, 'a negated --help test is not help support');

  // AMBIGUOUS fixture — a correct RAW-argv emptiness branch that prints usage but
  // names no exit is UNKNOWN, never invented (`<=2` is the raw argv-empty form).
  const amb = "if (process.argv.length <= 2) { console.error('usage: z'); }";
  const a = deriveContract(amb, 'probe.mjs');
  assert.equal(a.noArgs.documented, true, 'a real raw-argv length branch is documented usage');
  assert.equal(a.noArgs.exit, null, 'a usage branch with no process.exit is UNKNOWN, never invented');
});

// --- discovery715: command-aware declared-target resolver (bounded) --------

test('command-aware resolver: option values, pnpm cwd, dispositions and mandatory-target refusal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-resolver-gate-'));
  const w = (rel, content = 'export const x = 1;\n') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  fs.mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'capiro',
    scripts: {
      lint: 'eslint src --ext .ts',
      'filtered-cwd': 'pnpm --filter @capiro/defense-api exec tsx scripts/run.ts',
      'dir-cwd': 'pnpm -C apps/api exec tsx scripts/z.ts',
      glob: 'tsx --test src/**/*.spec.ts',
      nested: 'node packages/meriv2-core/scripts/canary.ts',
      gen: 'node dist/main.js',
      dep: 'node node_modules/jest/bin/jest.js',
      srv: 'tsx src/server.ts',
      dataarg: 'tsx scripts/parse.ts --artifact scripts/__data__/x.json',
      'unknown-filter': 'pnpm --filter @missing exec tsx scripts/check.ts',
      'cd-cwd': 'cd apps/api && tsx scripts/z.ts',
      'tsnode-cli': 'ts-node tools/migrate.ts',
      'start-migrate': 'tsx tools/migrate.ts',
      'jest-arbitrary': 'jest src/arbitrary.ts',
      'cdk-app': 'cdk synth --app "ts-node bin/app.ts"',
    },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'apps', 'api', 'package.json'), JSON.stringify({
    name: '@capiro/api',
    scripts: {
      'run-cli': 'tsx scripts/cli.ts',
      missing: 'tsx scripts/gone.ts',
      'jest-one': 'jest --runInBand src/feature.spec.ts',
      // language-owned Python CLI: ONE file, TWO exact command references.
      'extract:florida-legislative-directories': 'python scripts/extract-florida-legislative-directories.py',
      'verify:florida-legislative-directories': 'python scripts/extract-florida-legislative-directories.py --check',
    },
  }, null, 2));
  w('apps/api/scripts/cli.ts', "const a = process.argv.slice(2);\nif (a.length === 0) { console.error('usage'); process.exit(2); }\n");
  w('apps/api/scripts/z.ts', 'run();\n');
  // A real Python source launched by an actual interpreter — NOT parsed as TS/JS.
  w('apps/api/scripts/extract-florida-legislative-directories.py', 'import argparse\nprint("hi")\n');
  w('apps/api/src/feature.spec.ts', 'it("x", () => {});\n');
  w('apps/defense-api/package.json', JSON.stringify({ name: '@capiro/defense-api' }));
  w('apps/defense-api/scripts/run.ts', 'run();\n');
  w('packages/meriv2-core/scripts/canary.ts', 'run();\n');
  w('scripts/parse.ts', 'run();\n');
  w('scripts/check.ts', 'run();\n');
  w('tools/migrate.ts', 'run();\n');
  w('src/arbitrary.ts', 'run();\n');
  w('bin/app.ts', 'run();\n');
  w('dist/main.js', 'run();\n');

  // Quote-aware tokenisation never executes command text.
  const toks = tokenizeCommand('node "a b.ts" && tsx c.ts');
  assert.deepEqual(toks.filter((t) => t.type === 'word').map((t) => t.value), ['node', 'a b.ts', 'tsx', 'c.ts']);
  assert.deepEqual(toks.filter((t) => t.type === 'op').map((t) => t.value), ['&&']);

  // A bare extension OPTION VALUE is not a file target.
  const a = analyzeCommand({ command: 'eslint src --ext .ts', packageName: 'capiro', packageDir: root, root, cwdDir: root });
  assert.equal(a.targets.length, 0, 'an extension option value must not become a target');
  const { records } = resolveDeclaredTargets(root);
  assert.equal(records.some((r) => r.token === '.ts' || r.rel === 'apps/api/.ts'), false, 'no fictitious .ts target');

  // Correct pnpm --filter / -C cwd context.
  const filtered = records.find((r) => r.reference === 'capiro#filtered-cwd');
  assert.equal(filtered.rel, 'apps/defense-api/scripts/run.ts');
  assert.equal(filtered.cwdSource, 'filter');
  const dirCwd = records.find((r) => r.reference === 'capiro#dir-cwd');
  assert.equal(dirCwd.rel, 'apps/api/scripts/z.ts');
  assert.equal(dirCwd.cwdSource, 'dir');

  // Glob stays unresolved with its test owner.
  const glob = records.find((r) => r.reference === 'capiro#glob');
  assert.equal(glob.resolution, 'dynamic');
  assert.equal(glob.disposition, 'test-runner-target');

  // A data-file argument is not a code entrypoint.
  const dataArg = records.find((r) => r.reference === 'capiro#dataarg');
  assert.equal(dataArg.rel, 'scripts/parse.ts');
  assert.equal(records.some((r) => String(r.token).includes('__data__')), false);

  // Pure disposition table.
  assert.equal(classifyDisposition({ rel: 'apps/api/dist/main.js', runner: 'node' }).disposition, 'generated-build-output');
  assert.equal(classifyDisposition({ rel: 'apps/api/node_modules/jest/bin/jest.js', runner: 'node' }).disposition, 'dependency-runner');
  assert.equal(classifyDisposition({ rel: 'apps/api/src/main.ts', runner: 'node' }).disposition, 'runtime-server');
  assert.equal(classifyDisposition({ rel: 'apps/api/scripts/x.ts', runner: 'tsx', resolution: 'missing' }).disposition, 'missing-cli');
  assert.equal(classifyDisposition({ rel: 'apps/e2e/scripts/x.ts', runner: 'tsx', resolution: 'missing' }).disposition, 'unresolved-missing');

  // ts-node is a general TS executable, not a build tool; cdk's --app context owns
  // its nested ts-node operand; a `start:*` label is not server evidence; a test
  // runner's positional source operand is test-owned.
  assert.equal(classifyDisposition({ rel: 'infra/cdk/bin/x.ts', runner: 'ts-node' }).disposition, 'operational-cli');
  assert.equal(classifyDisposition({ rel: 'infra/cdk/bin/x.ts', runner: 'ts-node', contextRunner: 'cdk' }).disposition, 'build-artifact');
  assert.equal(classifyDisposition({ rel: 'tools/migrate.ts', runner: 'tsx', scriptName: 'start:migrate' }).disposition, 'operational-cli');
  assert.equal(classifyDisposition({ rel: 'src/arbitrary.ts', runner: 'jest' }).disposition, 'test-runner-target');

  // An unknown --filter selector leaves the cwd context UNRESOLVED (never wrong-cwd).
  const unknownFilter = records.find((r) => r.reference === 'capiro#unknown-filter');
  assert.equal(unknownFilter.resolution, 'unresolved-context');
  assert.equal(unknownFilter.disposition, 'operational-cli');

  // A real `cd <dir>` segment propagates its cwd to the following segment.
  const cdCwd = records.find((r) => r.reference === 'capiro#cd-cwd');
  assert.equal(cdCwd.rel, 'apps/api/scripts/z.ts');
  assert.equal(cdCwd.cwdSource, 'cd');

  // ts-node CLI is operational; a start:* label stays operational; a cdk --app
  // nested ts-node is build-owned; a jest positional source is test-owned.
  assert.equal(records.find((r) => r.reference === 'capiro#tsnode-cli').disposition, 'operational-cli');
  assert.equal(records.find((r) => r.reference === 'capiro#start-migrate').disposition, 'operational-cli');
  assert.equal(records.find((r) => r.reference === 'capiro#jest-arbitrary').disposition, 'test-runner-target');
  assert.equal(records.find((r) => r.reference === 'capiro#cdk-app').disposition, 'build-artifact');

  // Discovery reconciliation: mandatory roots, nested CLI inclusion, test-owner
  // accounting and genuinely-missing mandatory-target refusal.
  const found = discoverEntrypoints(root);
  const by = (rel) => found.find((x) => x.rel === rel);
  assert.equal(by('apps/api/scripts/cli.ts').kind, 'entrypoint', 'walked §6.2 CLI stays mandatory');
  const nested = by('apps/defense-api/scripts/run.ts');
  assert.equal(nested.kind, 'entrypoint');
  assert.match(String(nested.subject), /^declared:/);
  const test = by('apps/api/src/feature.spec.ts');
  assert.equal(test.kind, 'declared-non-smoke');
  assert.equal(test.disposition, 'test-runner-target');
  const missing = by('apps/api/scripts/gone.ts');
  assert.equal(missing.kind, 'undiscovered-declared');
  assert.equal(missing.subject, 'declared-missing');
  assert.equal(by('dist/main.js').kind, 'declared-non-smoke');
  assert.equal(found.some((x) => x.disposition === 'dependency-runner' && x.kind === 'declared-non-smoke'), true);
  assert.equal(found.some((x) => x.disposition === 'runtime-server' && x.kind === 'declared-non-smoke'), true);
  // An unknown --filter selector operand FAILS CLOSED regardless of root.
  assert.equal(found.some((x) => Array.isArray(x.declaredBy) && x.declaredBy.includes('capiro#unknown-filter') && x.kind === 'undiscovered-declared'), true);

  // language-owned Python CLI: a resolved .py launched by an actual python
  // interpreter is an explicit declared-non-smoke python-script record, NEVER an
  // executed JS/TS smoke subject. A .py SUFFIX ALONE is never enough — a
  // non-python launcher stays conservative operational and a missing target fails
  // closed (no laundering of unknown contexts).
  assert.equal(classifyDisposition({ rel: 'apps/api/scripts/extract-florida-legislative-directories.py', runner: 'python', resolution: 'resolved' }).disposition, 'python-script');
  assert.equal(classifyDisposition({ rel: 'apps/api/scripts/x.py', runner: 'tsx', resolution: 'resolved' }).disposition, 'operational-cli');
  assert.equal(classifyDisposition({ rel: 'apps/api/scripts/x.py', runner: 'python', resolution: 'missing' }).disposition, 'missing-cli');
  const pyRecs = found.filter((x) => String(x.rel).endsWith('extract-florida-legislative-directories.py'));
  assert.equal(pyRecs.length, 2, 'both python command references are retained (one file / two records)');
  assert.equal(pyRecs.every((x) => x.kind === 'declared-non-smoke' && x.disposition === 'python-script'), true);
  assert.equal(found.some((x) => x.kind === 'entrypoint' && String(x.rel).endsWith('.py')), false, 'a python CLI is never an executed entrypoint');
});

// --- gateusage1094: the gate's OWN zero-argument usage fast path -------------

const GATE = path.join(HERE, 'gate.mjs');
const GATE_REL = 'scripts/cleanup-gates/gate.mjs';

// Child-owned Node preload: trap EVERY child_process operation inside the
// spawned gate (spawn/spawnSync/exec/execFile/fork, sync + async) and re-sync
// the builtin ESM named exports so the gate's `import { spawnSync }` binding —
// and lib/runner.mjs's — resolve to the trap. A trapped call records a marker
// file then throws, so an accidental head()/version probe or a full-gate launch
// can neither proceed nor go unnoticed. `syncBuiltinESMExports()` is the
// required runtime seam: gate.mjs binds the named export at module evaluation.
const TRAP_PRELOAD = [
  "import childProcess from 'node:child_process';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "import fs from 'node:fs';",
  'const MARKER = process.env.GATE_SPAWN_MARKER;',
  "const NAMES = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];",
  'const trip = (name) => {',
  "  try { if (MARKER) fs.writeFileSync(MARKER, 'child_process.' + name + '\\n'); } catch {}",
  "  throw new Error('GATE_TRAP: child_process.' + name + ' invoked before a clean exit');",
  '};',
  'for (const name of NAMES) {',
  "  if (typeof childProcess[name] === 'function') childProcess[name] = () => trip(name);",
  '}',
  'syncBuiltinESMExports();',
  '',
].join('\n');

/**
 * Spawn the CURRENT gate source with argv. When `trap` is set the child runs
 * under the child-owned preload above (passed via `--import`, so it executes in
 * the CHILD, not here), and DATABASE_URL is dropped from the child env. The hard
 * timeout plus the throw-on-any-spawn trap make an accidental full-gate launch
 * impossible: no package build/test, Docker, uv or network work can start.
 */
function spawnGate(argv, { trap = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateusage1094-'));
  const env = { ...process.env };
  delete env.DATABASE_URL; // child must not inherit a live database URL
  const launch = [GATE, ...argv];
  let marker = null;
  if (trap) {
    const preload = path.join(dir, 'child-trap.mjs');
    fs.writeFileSync(preload, TRAP_PRELOAD);
    marker = path.join(dir, 'spawn-marker.txt');
    env.GATE_SPAWN_MARKER = marker;
    launch.unshift('--import', pathToFileURL(preload).href);
  }
  const res = spawnSync(process.execPath, launch, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  return { res, marker };
}

test('gate bare invocation prints Usage, exits 2 and performs NO child process', () => {
  const { res, marker } = spawnGate([], { trap: true });
  assert.ifError(res.error);
  assert.equal(res.signal, null, 'the gate must not be killed by the timeout/signal');
  assert.equal(res.status, 2, `bare invocation must exit 2 (got ${res.status}); stderr=${res.stderr}`);
  assert.match(res.stdout, /usage:\s+node scripts\/cleanup-gates\/gate\.mjs/);
  assert.equal(
    fs.existsSync(marker),
    false,
    'no child_process operation (version/metadata probe or full-gate launch) may occur before the no-args exit',
  );
});

test('gate --help prints Usage, exits 0 and performs NO child process', () => {
  const { res, marker } = spawnGate(['--help'], { trap: true });
  assert.ifError(res.error);
  assert.equal(res.status, 0, `--help must exit 0 (got ${res.status}); stderr=${res.stderr}`);
  assert.match(res.stdout, /usage:\s+node scripts\/cleanup-gates\/gate\.mjs/);
  assert.equal(fs.existsSync(marker), false, '--help must not spawn any child process');
});

test('gate unknown flag prints Usage, exits 2 and performs NO child process', () => {
  const { res, marker } = spawnGate(['--definitely-not-a-gate-flag'], { trap: true });
  assert.ifError(res.error);
  assert.equal(res.status, 2, `an unknown flag must exit 2 (got ${res.status}); stdout=${res.stdout}`);
  assert.match(res.stderr, /usage:\s+node scripts\/cleanup-gates\/gate\.mjs/);
  assert.equal(fs.existsSync(marker), false, 'an unknown flag must not spawn any child process');
});

test('gate source derives a documented no-args usage exit and keeps explicit --phase defaults/aliases', () => {
  const src = fs.readFileSync(GATE, 'utf8');
  // The ONE canonical scanner must derive the literal documented no-args exit
  // (2) from the ACTUAL gate source — a top-level zero-argv branch, never a
  // wrapper inference.
  const c = deriveContract(src, GATE_REL);
  assert.equal(c.noArgs.documented, true, c.evidence);
  assert.equal(c.noArgs.exit, 2, c.evidence);
  assert.equal(c.noArgs.usagePrinted, true, c.evidence);
  // The branch is top-level and PRECEDES the real main entry statement. Both
  // positions are anchored to their own source LINE so a same-text occurrence
  // inside a comment (e.g. the fast-path comment names the entry) can never be
  // mistaken for the executable statement.
  const fast = src.search(/^if \(process\.argv\.length <= 2\) \{$/m);
  assert.ok(fast > -1, 'the zero-argument fast path must exist in gate source');
  const entry = src.search(/^withUsage\(main, USAGE\)\(\);$/m);
  assert.ok(entry > -1, 'the top-level main entry statement must exist in gate source');
  assert.ok(fast < entry, 'the fast path must precede the main entry');
  // The full-acceptance phase default is unchanged (explicit --phase is opt-in).
  assert.match(src, /phase:\s*\{\s*flag:\s*'phase',\s*type:\s*'string',\s*default:\s*'all'/);
  // All five root aliases pass an EXPLICIT --phase; none invokes the gate bare.
  const scripts = readJson(path.join(ROOT, 'package.json')).scripts || {};
  for (const name of ['gate:cleanup1', 'gate:cleanup1:core', 'gate:cleanup1:guards', 'gate:cleanup1:python', 'gate:cleanup1:e2e']) {
    assert.ok(scripts[name], `root script missing: ${name}`);
    assert.match(scripts[name], /cleanup-gates\/gate\.mjs --phase (all|core|guards|python|e2e)\b/, `${name} must pass an explicit --phase`);
  }
});

// --- configguard1179: missing-DATABASE_URL smoke context + reviewed codemod ---

test('the named missing-DATABASE_URL smoke context is immutable; generic stays conservative', () => {
  assert.equal(Object.isFrozen(MISSING_DATABASE_URL_SMOKE_CONTEXT), true, 'the shared context must be frozen');
  assert.equal(typeof MISSING_DATABASE_URL_SMOKE_CONTEXT.id, 'string');
  const src = [
    "import { PrismaClient } from '@prisma/client';",
    'async function main(): Promise<void> {',
    '  const prisma = new PrismaClient();',
    '  if (!process.env.DATABASE_URL) {',
    "    console.error('Usage: x requires DATABASE_URL');",
    '    process.exit(2);',
    '  }',
    '}',
    'if (require.main === module) { void main().catch(() => process.exit(1)); }',
    '',
  ].join('\n');
  // Generic (no context): the env-only guard is NOT recognized.
  const generic = deriveContract(src, 'probe.ts');
  assert.equal(generic.noArgs.documented, false, 'the generic deriver must stay conservative');
  // Named smoke context: the configuration-conditioned contract IS recognized.
  const smoke = deriveContract(src, 'probe.ts', MISSING_DATABASE_URL_SMOKE_CONTEXT);
  assert.equal(smoke.noArgs.documented, true, smoke.evidence);
  assert.equal(smoke.noArgs.exit, 2, smoke.evidence);
  assert.equal(smoke.noArgs.conditioned, 'missing-database-url');
});

test('the reviewed codemod inserts a main-owned guard and wraps an unconditional main behind a direct-invocation boundary', () => {
  const src = [
    "import { config as dotenvConfig } from 'dotenv';",
    "import { PrismaClient } from '@prisma/client';",
    'dotenvConfig();',
    'async function main(): Promise<void> {',
    '  const prisma = new PrismaClient();',
    '  await prisma.$disconnect();',
    '}',
    'void main().catch((err) => { console.error(err); process.exit(1); });',
    '',
  ].join('\n');
  const t = transformConfigGuard(src, 'apps/api/scripts/probe.ts');
  assert.equal(t.ok, true, JSON.stringify(t.reasons));
  assert.equal(t.placement.boundary, 'wrapped');
  // The EXACT existing unconditional call is preserved verbatim inside the boundary.
  assert.ok(t.output.includes('if (require.main === module) {'));
  assert.ok(t.output.includes('void main().catch((err) => { console.error(err); process.exit(1); });'));
  // The guard contributes exactly ONE environment READ plus exactly ONE
  // diagnostic Usage MENTION of the variable name (Failure-1: the old raw token
  // count conflated the two and always refused the codemod's own valid output).
  assert.equal(countEnvReads(t.output), 1, 'the guard must be the only DATABASE_URL code read');
  assert.equal(countDatabaseUrlTokens(t.output), 2, 'one code read plus one diagnostic Usage mention');
  // The transformed output derives the configuration-conditioned contract only
  // under the named smoke context.
  assert.equal(deriveContract(t.output, 'apps/api/scripts/probe.ts').noArgs.documented, false);
  assert.equal(deriveContract(t.output, 'apps/api/scripts/probe.ts', MISSING_DATABASE_URL_SMOKE_CONTEXT).noArgs.exit, 2);
  // Idempotency: a source that already references DATABASE_URL is refused.
  const again = transformConfigGuard(t.output, 'apps/api/scripts/probe.ts');
  assert.equal(again.ok, false);
});

test('the codemod refuses a changed/ambiguous placement rather than guessing', () => {
  // main invoked from a NAMED helper (not an IIFE, not a boundary) — refused.
  const viaHelper = [
    "import { PrismaClient } from '@prisma/client';",
    'async function main() { const p = new PrismaClient(); }',
    'function run() { void main(); }',
    'run();',
    '',
  ].join('\n');
  const t = transformConfigGuard(viaHelper, 'apps/api/scripts/probe.ts');
  assert.equal(t.ok, false);
  assert.ok(t.reasons.some((r) => /named helper/.test(r)), JSON.stringify(t.reasons));
});

test('the config-guard-codemod CLI is import-safe and bounded: noargs usage/2, --help/0, unknown/2', () => {
  const CODEMOD = path.join(HERE, '..', 'cleanup-script-smoke', 'config-guard-codemod.mjs');
  const run = (argv) => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    return spawnSync(process.execPath, [CODEMOD, ...argv], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  };
  const bare = run([]);
  assert.ifError(bare.error);
  assert.equal(bare.status, 2, `bare invocation must exit 2 (got ${bare.status}); stderr=${bare.stderr}`);
  assert.match(bare.stderr, /usage:\s+node scripts\/cleanup-script-smoke\/config-guard-codemod\.mjs/);
  const help = run(['--help']);
  assert.equal(help.status, 0, `--help must exit 0 (got ${help.status})`);
  assert.match(help.stdout, /usage:\s+node scripts\/cleanup-script-smoke\/config-guard-codemod\.mjs/);
  const unknown = run(['--definitely-not-a-codemod-flag']);
  assert.equal(unknown.status, 2, `an unknown flag must exit 2 (got ${unknown.status})`);
  assert.match(unknown.stderr, /usage:\s+node scripts\/cleanup-script-smoke\/config-guard-codemod\.mjs/);
});

// --- configguard1193: codemod CLI correctness repairs -----------------------

test('the config-guard-codemod CLI is import-safe for a same-basename importer and rejects unknown+--help', () => {
  const CODEMOD = path.join(HERE, '..', 'cleanup-script-smoke', 'config-guard-codemod.mjs');
  const env = { ...process.env };
  delete env.DATABASE_URL;
  // A DIFFERENT file that shares the codemod's BASENAME and IMPORTS it must run
  // WITHOUT triggering the codemod CLI (exact resolved own-file identity, never a
  // `process.argv[1].endsWith(basename)` guess).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-import-'));
  const importer = path.join(dir, 'config-guard-codemod.mjs');
  fs.writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(CODEMOD).href)};\nconsole.log('IMPORTER-OK');\n`);
  const runImporter = spawnSync(process.execPath, [importer], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ifError(runImporter.error);
  assert.equal(runImporter.status, 0, `a same-basename importer must stay import-safe (got ${runImporter.status}); stderr=${runImporter.stderr}`);
  assert.match(runImporter.stdout, /IMPORTER-OK/);
  assert.doesNotMatch(runImporter.stderr, /usage:\s+node scripts\/cleanup-script-smoke\/config-guard-codemod\.mjs/, 'the codemod CLI must NOT run on import');
  // An unknown option is rejected even alongside --help.
  const run = (argv) => spawnSync(process.execPath, [CODEMOD, ...argv], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const helpUnknown = run(['--help', '--definitely-not-a-codemod-flag']);
  assert.equal(helpUnknown.status, 2, `--help combined with an unknown flag must exit 2 (got ${helpUnknown.status})`);
  assert.match(helpUnknown.stderr, /usage:\s+node scripts\/cleanup-script-smoke\/config-guard-codemod\.mjs/);
  assert.doesNotMatch(helpUnknown.stdout, /usage:/, '--help must NOT succeed when an unknown flag is present');
});

test('the codemod refuses an unknown --subject and a malformed/duplicate manifest rather than a silent empty ledger', () => {
  const CODEMOD = path.join(HERE, '..', 'cleanup-script-smoke', 'config-guard-codemod.mjs');
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-manifest-'));
  const H = 'a'.repeat(64);
  let seq = 0;
  const run = (manifestPath, args = []) =>
    spawnSync(
      process.execPath,
      [CODEMOD, '--root', root, '--manifest', manifestPath, '--out-ledger', path.join(root, `ledger-${seq++}.json`), ...args],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
  const good = path.join(root, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ selected: [{ rel: 'apps/api/scripts/probe.ts', sourceSha256: H }] }));
  const unknownSubject = run(good, ['--subject', 'apps/api/scripts/not-in-manifest.ts']);
  assert.equal(unknownSubject.status, 2, `an unknown --subject must exit 2 (got ${unknownSubject.status}); stderr=${unknownSubject.stderr}`);
  assert.match(unknownSubject.stderr, /unknown --subject/);
  const empty = path.join(root, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ selected: [] }));
  const emptyRun = run(empty);
  assert.equal(emptyRun.status, 2, `an empty manifest must exit 2 (got ${emptyRun.status})`);
  assert.match(emptyRun.stderr, /non-empty|selected/);
  const dup = path.join(root, 'dup.json');
  fs.writeFileSync(dup, JSON.stringify({ selected: [{ rel: 'apps/api/scripts/probe.ts', sourceSha256: H }, { rel: 'apps/api/scripts/probe.ts', sourceSha256: H }] }));
  const dupRun = run(dup);
  assert.equal(dupRun.status, 2, `a duplicate manifest subject must exit 2 (got ${dupRun.status})`);
  assert.match(dupRun.stderr, /duplicate/);
  const notSource = path.join(root, 'notsource.json');
  fs.writeFileSync(notSource, JSON.stringify({ selected: [{ rel: 'apps/api/scripts/probe.txt', sourceSha256: H }] }));
  const notSourceRun = run(notSource);
  assert.equal(notSourceRun.status, 2, `a non-source manifest subject must exit 2 (got ${notSourceRun.status})`);
  assert.match(notSourceRun.stderr, /ordinary source file|confined/);
});

test('the actual codemod CLI plans and applies a hash-bound source without executing it', () => {
  const codemod = path.join(HERE, '..', 'cleanup-script-smoke', 'config-guard-codemod.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-positive-'));
  const rel = 'apps/api/scripts/probe.ts', file = path.join(root, rel);
  const source = "import { PrismaClient } from '@prisma/client';\nasync function main() {\n  const prisma = new PrismaClient();\n  await prisma.$disconnect();\n}\nvoid main();\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  const hash = text => createHash('sha256').update(text).digest('hex');
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ selected: [{ rel, sourceSha256: hash(source) }] }));
  const run = (ledger, apply = false) => spawnSync(process.execPath,
    [codemod, '--root', root, '--manifest', manifest, '--out-ledger', ledger, ...(apply ? ['--apply'] : [])],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const planned = path.join(root, 'planned.json'), planRun = run(planned);
  assert.ifError(planRun.error);
  assert.equal(planRun.status, 0, planRun.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(planned, 'utf8')).counts, { planned: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), source, 'planning must preserve the subject bytes');
  const applied = path.join(root, 'applied.json'), applyRun = run(applied, true);
  assert.ifError(applyRun.error);
  assert.equal(applyRun.status, 0, applyRun.stderr);
  const ledger = JSON.parse(fs.readFileSync(applied, 'utf8')), after = fs.readFileSync(file, 'utf8');
  assert.deepEqual(ledger.counts, { applied: 1 });
  assert.equal(ledger.entries[0].beforeSha256, hash(source));
  assert.equal(ledger.entries[0].afterSha256, hash(after));
  assert.equal(deriveContract(after, rel, MISSING_DATABASE_URL_SMOKE_CONTEXT).noArgs.exit, 2);
  const repeated = run(applied, true);
  assert.equal(repeated.status, 2, 'an existing ledger must refuse before any write');
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('new config controls have a bounded standalone CLI and a same-basename import stays inert', () => {
  const controls = path.join(HERE, '..', 'cleanup-script-smoke', 'config-guard-controls.mjs');
  const run = args => spawnSync(process.execPath, [controls, ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true });
  for (const [args, status] of [[[], 2], [['--help'], 0], [['--unknown'], 2], [['--help', '--unknown'], 2]]) {
    const result = run(args);
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stdout + result.stderr, /Usage:/);
  }
  const tested = run(['--self-test']);
  assert.equal(tested.status, 0, tested.stderr);
  assert.equal(JSON.parse(tested.stdout).ok, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-import-')), importer = path.join(dir, 'config-guard-controls.mjs');
  fs.writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(controls).href)}; console.log('import-ok');\n`);
  const imported = spawnSync(process.execPath, [importer], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ifError(imported.error);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), 'import-ok');
});
