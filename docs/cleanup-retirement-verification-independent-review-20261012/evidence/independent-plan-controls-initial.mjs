import fs from 'node:fs';
import cp from 'node:child_process';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as phase3 from '../../../scripts/engagement-phase3-qualification-plan.mjs';
import * as outreach from '../../../scripts/outreach-v3-qualification-plan.mjs';
const require = createRequire(import.meta.url);
const ts = require('/workspace/capirov2/node_modules/typescript');
const base = '5470c6df029c9553dd49e531229c3c91b26275ef';
const source = 'b877e03c5710bfc347568c7bbd1197f7caedbcde';
const directory = 'docs/cleanup-retirement-verification-independent-review-20261012/evidence/';
const read = (pin, path) => cp.execFileSync('git', ['show', `${pin}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const results = [];
const check = (name, test) => { test(); results.push({ name, passed: true }); };
const p1Helper = 'apps/api/scripts/engagement-phase1-qualification-plan.ts';
const p1Js = ts.transpileModule(read(source, p1Helper), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
vm.runInNewContext(p1Js, { module, exports: module.exports }, { timeout: 1000 });
const phase1 = module.exports;
const before = JSON.parse(fs.readFileSync(directory + 'full-phase1-before-golden.json', 'utf8'));
assert.equal(before.source, base);
const targets = before.statements.find(step => step.args?.includes('jest')).args.slice(6);
assert.equal(targets.length, 16);
const clone = value => JSON.parse(JSON.stringify(value));
const normalized = steps => clone(steps.map(step => step.kind === 'command'
  ? { kind: 'run', label: step.label, command: step.command, args: step.args, cwd: '/repo', env: step.env ?? {} }
  : step.kind === 'required-file' ? { kind: 'assertFile', path: step.relativePath }
  : { kind: 'assertNoWebPreviewRouting' }));
check('Phase1 original immutable 24-step golden equals candidate full plan in order/argv/env/assertions', () => {
  assert.deepEqual(normalized(phase1.engagementPhase1QualificationPlan('full', 'git', targets)), before.statements);
});
const web = before.statements.filter(step => ['Web typecheck', 'Web regression suite'].includes(step.label) || step.kind === 'assertNoWebPreviewRouting');
check('Phase1 backend is original21 steps; frontend is original3 steps; no target/floor drift', () => {
  assert.deepEqual(normalized(phase1.engagementPhase1QualificationPlan('backend-only', 'git', targets)), before.statements.filter(step => !web.includes(step)));
  assert.deepEqual(normalized(phase1.engagementPhase1QualificationPlan('frontend-only', 'git', targets)), web);
});
const p1Path = 'apps/api/scripts/verify-engagement-phase1-runtime.ts';
const ast = (path, bytes) => ts.createSourceFile(path, bytes, ts.ScriptTarget.Latest, true);
const old1 = ast(p1Path, read(base, p1Path)), new1 = ast(p1Path, read(source, p1Path));
check('All eight existing non-main Phase1 function bodies remain byte exact', () => {
  const originals = old1.statements.filter(node => ts.isFunctionDeclaration(node) && node.name.text !== 'main');
  for (const original of originals) {
    const current = new1.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === original.name.text);
    assert.equal(current.getText(new1), original.getText(old1));
  }
  assert.equal(originals.length, 8);
});
check('Actual Phase1 ordered TEST_TARGETS declaration is byte exact', () => {
  const targetStatement = file => file.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(file) === 'TEST_TARGETS'));
  assert.equal(targetStatement(new1).getText(new1), targetStatement(old1).getText(old1));
});
for (const [name, parser] of [['Phase1', phase1.engagementPhase1Scope], ['Phase3', phase3.engagementPhase3Scope], ['Outreach', outreach.outreachV3Scope]]) {
  for (const args of [[], ['--run', '--run'], ['--backend-only'], ['--frontend-only'], ['--run', '--backend-only', '--frontend-only'], ['--run', '--backend-only', '--backend-only'], ['--run', '--frontend-only', '--frontend-only'], ['--run', '--unknown'], ['--run', '--help'], ['--run', '--backend-only=true'], ['--RUN'], ['--run', null]]) {
    check(`${name} refuses strict argv ${JSON.stringify(args)}`, () => assert.throws(() => parser(args)));
  }
  for (const [args, expected] of [[['--run'], 'full'], [['--run', '--backend-only'], 'backend-only'], [['--frontend-only', '--run'], 'frontend-only']]) {
    check(`${name} exact intended argv ${JSON.stringify(args)}`, () => assert.equal(parser(args), expected));
  }
}
for (const scope of ['backend-only', 'frontend-only']) {
  const policy = phase3.engagementPhase3Phase1Policy(scope);
  const foreign = ['full', 'backend-only', 'frontend-only'].filter(mode => mode !== scope).map(phase3.engagementPhase3Phase1Policy);
  for (const value of [policy.complete, policy.complete + '\n', policy.complete + '\r\n']) {
    check(`Phase3 ${scope} accepts exact selected line ${JSON.stringify(value)}`, () => assert.equal(phase3.engagementPhase3Phase1CompletionState(value, scope, 0), 'complete'));
  }
  check(`Phase3 ${scope} retains active-child completion`, () => assert.equal(phase3.engagementPhase3Phase1CompletionState(policy.complete, scope, null), 'complete'));
  const negative = [[policy.complete, 1], [policy.complete, 7], [policy.complete + '\n' + policy.failed, 0], [policy.failed + '\n' + policy.complete, 0], ['prefix ' + policy.complete, 0], [policy.complete + ' suffix', 0], [policy.complete + '\0', 0]];
  for (const other of foreign) negative.push([other.complete, 0], [policy.complete + '\n' + other.complete, 0], [policy.complete + '\n' + other.failed, 0]);
  for (const [output, exitCode] of negative) check(`Phase3 ${scope} refusal ${JSON.stringify([output, exitCode])}`, () => assert.equal(phase3.engagementPhase3Phase1CompletionState(output, scope, exitCode), 'failed'));
  check(`Phase3 ${scope} incomplete active child stays pending`, () => assert.equal(phase3.engagementPhase3Phase1CompletionState('partial output', scope, null), 'pending'));
}
check('Full Windows known original COMPLETE-before-FAILED/nonzero/substring weakness is preserved, not accepted as scoped behavior', () => {
  assert.equal(phase3.engagementPhase3Phase1CompletionState('prefix ENGAGEMENT_PHASE1_DB_FREE_COMPLETE suffix\nENGAGEMENT_PHASE1_DB_FREE_FAILED', 'full', 1), 'complete');
});
const sf3 = ast('phase3.mjs', read(base, 'scripts/verify-engagement-phase3-code.mjs'));
const oldStepNode = sf3.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(sf3) === 'steps')).declarationList.declarations[0].initializer;
const original3 = clone(vm.runInNewContext(oldStepNode.getText(sf3), { PHASE3_SCOPE_END: 'head', PHASE3_WHITESPACE_BASE: 'base', scopedOptions: { env: { ENGAGEMENT_PHASE3_SCOPE_END: 'head' } } }, { timeout: 1000 }));
check('Phase3 full returns original26 step array by reference', () => { assert.equal(original3.length, 26); assert.equal(phase3.engagementPhase3QualificationPlan('full', original3), original3); });
for (const scope of ['backend-only', 'frontend-only']) check(`Phase3 ${scope} nested exact aliases and source options remain`, () => {
  const planned = phase3.engagementPhase3QualificationPlan(scope, original3);
  for (const phase of [1, 2]) assert.deepEqual(planned.find(row => row[0] === `Phase ${phase} prerequisite`)[2], [`verify:engagement-phase-${phase}:${scope === 'backend-only' ? 'backend' : 'frontend'}`]);
  for (const label of ['Phase 3 UI inventory', 'Phase 3 preview route generation drift', 'Phase 3 V3/prototype boundary', 'Phase 3 scope and findings', 'Phase 3 committed-range whitespace']) assert.deepEqual(planned.find(row => row[0] === label), original3.find(row => row[0] === label));
});
const phases = ['phase1', 'phase3', 'phase4'];
const labels = { phase1: 'Phase 3 regression', phase3: 'Engagement Phase 3 current-product regression', phase4: 'Phase 3 reasoning regression' };
for (const phase of phases) {
  const full = [[labels[phase], phase === 'phase4' ? 'node' : 'pnpm', phase === 'phase4' ? ['scripts/verify-outreach-v3-phase3-code.mjs', '--run'] : ['verify:engagement-phase-3'], { env: { preserved: 'yes' } }], ['current extra owner check', 'node', ['new-existing-control'], { timeout: 91 }]];
  check(`${phase} full array unchanged reference, arbitrary current backend control retained`, () => { assert.equal(outreach.outreachV3QualificationPlan(phase, 'full', full), full); assert.equal(outreach.outreachV3QualificationPlan(phase, 'backend-only', full)[1], full[1]); });
  for (const scope of ['backend-only', 'frontend-only']) check(`${phase} ${scope} exact nested argv preserves options`, () => {
    const planned = outreach.outreachV3QualificationPlan(phase, scope, full);
    assert.deepEqual(planned[0][2], phase === 'phase4' ? ['scripts/verify-outreach-v3-phase3-code.mjs', '--run', '--' + scope] : ['verify:engagement-phase-3:' + (scope === 'backend-only' ? 'backend' : 'frontend')]);
    assert.equal(planned[0][3], full[0][3]);
  });
}
for (const args of [[], ['scripts/verify-outreach-v3-phase3-code.mjs'], ['wrong.mjs', '--run'], ['scripts/verify-outreach-v3-phase3-code.mjs', '--run', '--run'], ['scripts/verify-outreach-v3-phase3-code.mjs', '--run', '--frontend-only']]) check(`OutreachPhase4 rejects malformed nested args ${JSON.stringify(args)} before fake executor`, () => {
  const seen = [];
  assert.throws(() => outreach.executeOutreachV3Plan(outreach.outreachV3QualificationPlan('phase4', 'backend-only', [[labels.phase4, 'node', args]]), (...value) => seen.push(value)));
  assert.deepEqual(seen, []);
});
check('Nine Outreach full/backend/frontend completion markers are distinct and scoped failure cannot claim complete', () => {
  const markers = new Set();
  for (const phase of phases) for (const scope of ['full', 'backend-only', 'frontend-only']) {
    markers.add(outreach.outreachV3CompletionMarker(phase, scope));
    assert.equal(outreach.outreachV3FailureMarker(phase, scope), scope === 'full' ? undefined : outreach.outreachV3CompletionMarker(phase, scope).replace(/COMPLETE$/, 'FAILED'));
  }
  assert.equal(markers.size, 9);
});
fs.writeFileSync(directory + 'independent-plan-controls.json', JSON.stringify({ source, base, checks: results.length, results, actualQualifierCommands: 0, applicationGraphImported: false, sourceExecuted: 'pure helper functions and immutable array expression only; all command execution ports are fake/recorded', scopeLimits: ['Full Windows monitor baseline weakness deliberately remains', 'Outreach nested subprocess acceptance remains exit-only; no new stdout marker validation claimed', 'Phase3 mixed source controls still read retained frontend source'] }, null, 2) + '\n');
console.log(JSON.stringify({ source, passed: results.length, failed: 0, actualQualifierCommands: 0 }));
