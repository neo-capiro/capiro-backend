import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  executeOutreachV3Plan,
  outreachV3CompletionMarker,
  outreachV3FailureMarker,
  outreachV3QualificationPlan,
  outreachV3RunsLocalContracts,
  outreachV3Scope,
} from './outreach-v3-qualification-plan.mjs';

const source = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const before = (phase) => readFileSync(new URL(
  `../docs/cleanup-retirement-outreach-verification-integration-20261012/evidence/original-${phase}.mjs`,
  import.meta.url,
), 'utf8');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const inherited = {
  phase1: 'Phase 3 regression',
  phase3: 'Engagement Phase 3 current-product regression',
  phase4: 'Phase 3 reasoning regression',
};
const fixtures = {
  phase1: [
    ['current backend control', 'node', ['current-control.mjs']],
    ['Phase 3 regression', 'pnpm', ['verify:engagement-phase-3']],
    ['Phase 1 whitespace', 'git', ['diff', '--check', 'current-base..HEAD']],
  ],
  phase3: [
    ['current backend case', 'pnpm', ['exec', 'jest', 'new-current.spec.ts'], { NODE_OPTIONS: 'current-heap' }],
    ['Engagement Phase 3 current-product regression', 'pnpm', ['verify:engagement-phase-3'], { ENGAGEMENT_PHASE3_SCOPE_END: 'current-scope' }],
    ['Phase 3 committed-diff whitespace', 'git', ['diff', '--check', 'current-base..HEAD']],
  ],
  phase4: [
    ['Phase 3 reasoning regression', 'node', ['scripts/verify-outreach-v3-phase3-code.mjs', '--run'], { env: { ENGAGEMENT_PHASE3_SCOPE_END: 'current-scope' } }],
    ['current backend case', 'pnpm', ['exec', 'jest', 'new-current.spec.ts']],
    ['Diff whitespace', 'git', ['diff', '--check', 'closed-base...closed-end']],
    ['Current PR whitespace', 'git', ['diff', '--check', 'origin/main...HEAD']],
  ],
};
const phases = Object.keys(fixtures);

class InertExit extends Error {
  constructor(status) { super(`Inert exit ${status}`); this.status = status; }
}

// Runs source only in a VM with injected refusing/fake I/O. No ESM verifier,
// child, API, Prisma, application or provider module is imported/executed.
function inspectWrapper(phase, args, options = {}) {
  const body = options.original ? before(phase) : source(`verify-outreach-v3-${phase}-code.mjs`);
  const code = body.replace(/^#!.*\n/, '').replace(/^import\s+[\s\S]*?;\s*$/gm, '')
    .replaceAll('import.meta.url', `'file:///synthetic/root/scripts/verify-outreach-v3-${phase}-code.mjs'`);
  const commands = [], reads = [], stdout = [], stderr = [];
  const fakeProcess = {
    argv: ['node', `verify-outreach-v3-${phase}-code.mjs`, ...args],
    env: { CURRENT_SENTINEL: 'synthetic', ...(options.env ?? {}) },
    platform: options.platform ?? 'linux', cwd: () => '/synthetic/root',
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
    exit: (status) => { throw new InertExit(status); },
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const spawnSync = (command, argv, childOptions) => {
    commands.push(clone({ command, argv, options: childOptions }));
    let output = 'synthetic-base';
    if (command === 'git' && argv.includes('--name-only')) output = 'apps/api/src/outreach-v3/targets/synthetic.ts';
    return { status: options.failCommand === command ? options.failStatus ?? 7 : 0, stdout: output, stderr: '' };
  };
  const execFileSync = (command, argv, childOptions) => {
    commands.push(clone({ command, argv, options: childOptions, execFile: true }));
    return 'synthetic-base';
  };
  const existsSync = (file) => { reads.push({ kind: 'exists', file }); return !options.missingFile; };
  const fakeRead = (file) => {
    reads.push({ kind: 'read', file });
    if (file.endsWith('capiro-capability-catalog.v1.json')) return JSON.stringify(
      ['search_targets', 'get_target_profile', 'analyze_relationships'].map((name) => ({
        name, status: 'implemented', meriConsumer: true, outreachConsumer: true,
      })),
    );
    if (file.endsWith('outreach-v3-target-route-manifest.v1.json')) return JSON.stringify({
      runtime: 'engagement-api', featureFlag: 'OUTREACH_V3_TARGETS_ENABLED', disabledBehavior: 404, routes: [1, 2, 3, 4],
    });
    return options.sourceText ?? '// synthetic permitted source';
  };
  const sandbox = {
    process: fakeProcess,
    console: { log: (...items) => stdout.push(items.join(' ')), error: (...items) => stderr.push(items.join(' ')) },
    spawnSync, execFileSync, existsSync, readFileSync: fakeRead,
    path, resolve: path.resolve, fileURLToPath: () => `/synthetic/root/scripts/verify-outreach-v3-${phase}-code.mjs`,
    executeOutreachV3Plan, outreachV3Scope, outreachV3QualificationPlan,
    outreachV3CompletionMarker, outreachV3FailureMarker, outreachV3RunsLocalContracts,
  };
  let status = 0, unhandled;
  try { new vm.Script(code, { filename: `inert-${phase}.js` }).runInNewContext(sandbox, { timeout: 1000 }); }
  catch (error) {
    if (error instanceof InertExit) status = error.status;
    else { status = 'uncaught'; unhandled = String(error); }
  }
  return { status, commands, reads, stdout, stderr, unhandled, env: clone(fakeProcess.env) };
}

test('scope requires exactly one explicit run and at most one known scope', () => {
  for (const args of [['--run'], ['--run', '--backend-only'], ['--backend-only', '--run'], ['--run', '--frontend-only'], ['--frontend-only', '--run']]) {
    assert.equal(outreachV3Scope(args), args.find((arg) => arg !== '--run')?.slice(2) ?? 'full');
  }
  for (const args of [[], ['--backend-only'], ['--frontend-only'], ['--help'], ['--run', '--help'], ['--help', '--run'], ['--run', '--run'], ['--run', '--backend-only', '--backend-only'], ['--run', '--frontend-only', '--frontend-only'], ['--run', '--backend-only', '--frontend-only'], ['--backend-only', '--frontend-only'], ['--run', '--unknown'], ['--run', 'legacy-ignored'], ['--run', '--backend-only=true'], ['--RUN'], ['--run', null]]) {
    assert.throws(() => outreachV3Scope(args), /explicit --run/);
  }
});

test('full plans preserve current caller arrays and arbitrary newer steps', () => {
  for (const phase of phases) assert.equal(outreachV3QualificationPlan(phase, 'full', fixtures[phase]), fixtures[phase]);
});

test('backend scopes retain every current step/options/order and scope only the inherited prerequisite', () => {
  for (const phase of phases) {
    const planned = outreachV3QualificationPlan(phase, 'backend-only', fixtures[phase]);
    assert.equal(planned.length, fixtures[phase].length);
    for (let i = 0; i < planned.length; i += 1) {
      const [label, command, args, ...options] = fixtures[phase][i];
      if (label !== inherited[phase]) assert.equal(planned[i], fixtures[phase][i]);
      else {
        assert.deepEqual(planned[i], [label, command, phase === 'phase4' ? [...args, '--backend-only'] : ['verify:engagement-phase-3:backend'], ...options]);
        if (options.length) assert.equal(planned[i][3], fixtures[phase][i][3]);
      }
    }
  }
});

test('frontend scopes retain matching inherited qualification and whitespace, with no local API command', () => {
  for (const phase of phases) {
    const planned = outreachV3QualificationPlan(phase, 'frontend-only', fixtures[phase]);
    assert(planned.every(([label]) => label === inherited[phase] || /whitespace/.test(label)));
    const nested = planned.find(([label]) => label === inherited[phase]);
    assert.deepEqual(nested[2], phase === 'phase4'
      ? ['scripts/verify-outreach-v3-phase3-code.mjs', '--run', '--frontend-only']
      : ['verify:engagement-phase-3:frontend']);
  }
});

test('nested scope selection refuses duplicate/missing run or pre-scoped and wrong aliases before callback', () => {
  for (const args of [['scripts/verify-outreach-v3-phase3-code.mjs'], ['scripts/verify-outreach-v3-phase3-code.mjs', '--run', '--run'], ['scripts/verify-outreach-v3-phase3-code.mjs', '--run', '--frontend-only'], ['wrong-child.mjs', '--run']]) {
    const seen = [];
    assert.throws(() => executeOutreachV3Plan(outreachV3QualificationPlan('phase4', 'backend-only', [[inherited.phase4, 'node', args]]), (...step) => seen.push(step)), /exactly one --run/);
    assert.deepEqual(seen, []);
  }
  for (const phase of ['phase1', 'phase3']) for (const args of [['verify:engagement-phase-3:frontend'], ['verify:engagement-phase-3', '--run']]) {
    assert.throws(() => outreachV3QualificationPlan(phase, 'backend-only', [[inherited[phase], 'pnpm', args]]), /current full alias/);
  }
});

test('all nine completion values are distinct and scoped failures cannot emit a full completion', () => {
  const complete = new Set();
  for (const phase of phases) for (const scope of ['full', 'backend-only', 'frontend-only']) {
    const marker = outreachV3CompletionMarker(phase, scope);
    assert(!complete.has(marker)); complete.add(marker);
    if (scope === 'full') { assert.equal(marker, `OUTREACH_V3_${phase.toUpperCase()}_DB_FREE_COMPLETE`); assert.equal(outreachV3FailureMarker(phase, scope), undefined); }
    else assert.equal(outreachV3FailureMarker(phase, scope), marker.replace(/COMPLETE$/, 'FAILED'));
  }
  assert.equal(complete.size, 9);
});

test('invalid plan identities fail before injected runner, callback errors stop immediately', () => {
  const seen = [];
  assert.throws(() => executeOutreachV3Plan(outreachV3QualificationPlan('phase6', 'full', []), (...step) => seen.push(step)), /Unknown.*phase/);
  assert.throws(() => executeOutreachV3Plan(outreachV3QualificationPlan('phase1', 'typo', []), (...step) => seen.push(step)), /Unknown.*scope/);
  assert.deepEqual(seen, []);
  assert.throws(() => executeOutreachV3Plan(fixtures.phase4, (...step) => { seen.push(step); throw new Error('synthetic refusal'); }), /synthetic refusal/);
  assert.deepEqual(seen, [fixtures.phase4[0]]);
});

for (const phase of phases) {
  test(`${phase} noargs/help/invalid flags stop before every fake file/command/env effect`, () => {
    for (const args of [[], ['--backend-only'], ['--frontend-only'], ['--run', '--run'], ['--run', '--backend-only', '--backend-only'], ['--run', '--backend-only', '--frontend-only'], ['--run', '--unknown'], ['--help', '--run']]) {
      const actual = inspectWrapper(phase, args);
      assert.equal(actual.status, 2, actual.unhandled);
      assert.deepEqual(actual.commands, []); assert.deepEqual(actual.reads, []);
      assert.deepEqual(actual.env, { CURRENT_SENTINEL: 'synthetic' });
      assert.equal(actual.stdout.length, 0); assert.match(actual.stderr.join('\n'), /^Usage:/);
    }
    const help = inspectWrapper(phase, ['--help']);
    assert.equal(help.status, 0, help.unhandled); assert.match(help.stdout.join('\n'), /^Usage:/);
    assert.deepEqual(help.commands, []); assert.deepEqual(help.reads, []); assert.deepEqual(help.stderr, []);
  });

  test(`${phase} current full command/read/env/exit trace equals the frozen original under both platforms`, () => {
    for (const platform of ['linux', 'win32']) {
      const original = inspectWrapper(phase, ['--run'], { original: true, platform });
      const current = inspectWrapper(phase, ['--run'], { platform });
      assert.equal(current.status, 0, current.unhandled); assert.equal(original.status, 0, original.unhandled);
      assert.deepEqual(current, original);
    }
  });

  test(`${phase} scoped actual wrapper selects matching nested alias/argv and marks only that scope`, () => {
    for (const scope of ['backend-only', 'frontend-only']) {
      const actual = inspectWrapper(phase, ['--run', `--${scope}`]);
      assert.equal(actual.status, 0, actual.unhandled);
      const nested = actual.commands.find((x) => x.argv[0] === (phase === 'phase4' ? 'scripts/verify-outreach-v3-phase3-code.mjs' : `verify:engagement-phase-3:${scope === 'backend-only' ? 'backend' : 'frontend'}`));
      assert(nested);
      if (phase === 'phase4') assert.deepEqual(nested.argv, ['scripts/verify-outreach-v3-phase3-code.mjs', '--run', `--${scope}`]);
      else assert.deepEqual(nested.argv, [`verify:engagement-phase-3:${scope === 'backend-only' ? 'backend' : 'frontend'}`]);
      const markers = actual.stdout.join('\n').match(/OUTREACH_V3_PHASE[134](?:_BACKEND|_FRONTEND)?_DB_FREE_COMPLETE/g);
      assert.deepEqual(markers, [outreachV3CompletionMarker(phase, scope)]);
      if (scope === 'frontend-only') {
        assert(!actual.commands.some((x) => x.argv.includes('apps/api') || x.argv.includes('@capiro/api') || x.argv.includes('prisma') || x.argv.includes('jest')));
        if (phase === 'phase4') assert.deepEqual(actual.reads, []);
      }
    }
  });

  test(`${phase} full and scoped subprocess failures retain original actual-exit policy and stop`, () => {
    const original = inspectWrapper(phase, ['--run'], { original: true, failCommand: 'pnpm', failStatus: 7 });
    const current = inspectWrapper(phase, ['--run'], { failCommand: 'pnpm', failStatus: 7 });
    assert.deepEqual(current, original);
    assert.equal(current.status, phase === 'phase4' ? 7 : 1);
    for (const scope of ['backend-only', 'frontend-only']) {
      const actual = inspectWrapper(phase, ['--run', `--${scope}`], { failCommand: phase === 'phase4' && scope === 'frontend-only' ? 'node' : 'pnpm', failStatus: 7 });
      assert.equal(actual.status, phase === 'phase4' ? 7 : 1, actual.unhandled);
      assert(actual.stderr.join('\n').includes(outreachV3FailureMarker(phase, scope)));
      assert(!actual.stdout.join('\n').includes('_DB_FREE_COMPLETE'));
    }
  });
}

test('Phase1/3 full source arrays retain every current operand/environment expression byte-exact', () => {
  for (const [phase, expected] of [['phase1', 'b0c39d060abb7a2eac00f7c4ac9e50ac9ed5f26a59b8950ccc69488a3672290c'], ['phase3', 'ce18a248bf436df37fade8d8d33e0f6e09ef6a58ffe3a9ad7432f747ff184797']]) {
    const body = source(`verify-outreach-v3-${phase}-code.mjs`), start = body.indexOf('const steps = ['), end = body.indexOf('\n];', start) + 4;
    assert.equal(sha(body.slice(start, end)), expected);
  }
});

test('Phase4 all original source/catalog/route/scope predicates remain, frontend alone skips the backend envelope', () => {
  const body = source('verify-outreach-v3-phase4-code.mjs'), start = body.indexOf('  const required = ['), final = "  assert(manifest.routes.length === 4, 'target-route-count');", end = body.indexOf(final, start) + final.length;
  const contract = body.slice(start, end).split('\n').map((line) => line.startsWith('  ') ? line.slice(2) : line).join('\n');
  assert.equal(sha(contract), 'cd0ac63e5489b8c30e1715559efdb68c43b3dcc967316e693c4c901eba609297');
  for (const args of [['--run'], ['--run', '--backend-only']]) {
    const missing = inspectWrapper('phase4', args, { missingFile: true });
    assert.equal(missing.status, 1); assert(missing.stderr.join('\n').includes('missing:'));
    assert.deepEqual(missing.commands, []);
    const forbidden = inspectWrapper('phase4', args, { sourceText: '@langchain/langgraph' });
    assert.equal(forbidden.status, 1); assert(forbidden.stderr.join('\n').includes('langgraph-or-langsmith'));
  }
});
