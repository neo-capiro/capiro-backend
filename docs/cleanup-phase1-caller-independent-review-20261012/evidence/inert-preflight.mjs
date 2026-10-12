import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ts = createRequire(import.meta.url)('typescript');
const OUT = 'docs/cleanup-phase1-caller-independent-review-20261012/evidence/';
const helperPath = 'apps/api/scripts/verify-engagement-phase1-runtime.ts';
const source = readFileSync(helperPath, 'utf8');
const sf = ts.createSourceFile(helperPath, source, ts.ScriptTarget.Latest, true);
assert.equal(sf.parseDiagnostics.length, 0);
const usage = sf.statements.findIndex(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'USAGE'));
assert(usage >= 0);
const statements = sf.statements.slice(usage, usage + 3);
assert(ts.isVariableStatement(statements[0]) && ts.isIfStatement(statements[1]) && ts.isIfStatement(statements[2]));
const preflight = statements.map(n => n.getText(sf)).join('\n');
assert(!preflight.includes('spawn') && !preflight.includes('require('));
const results = [];
function check(name, text, argv, expectedExit, expectedRun, expression = undefined) {
  const stdout = [], stderr = [];
  const token = {};
  let actualExit = null;
  const context = vm.createContext({
    process: { argv: ['node', 'helper.ts', ...argv], exit(code) { actualExit = code; throw token; } },
    console: { log: value => stdout.push(value), error: value => stderr.push(value) },
    inputArgs: argv,
  });
  try { vm.runInContext(text + '\n' + (expression ?? 'globalThis.runSelected = true;'), context, { timeout: 500 }); }
  catch (error) { if (error !== token) throw error; }
  assert.equal(actualExit, expectedExit, name);
  assert.equal(context.runSelected === true, expectedRun, name);
  results.push({ name, argv, exit: actualExit, runSelected: context.runSelected === true, stdout, stderr });
  return context;
}
for (const [name, argv, exit] of [
  ['helper no arguments', [], 2], ['helper help', ['--help'], 0],
  ['helper unknown', ['--unknown'], 2], ['helper run plus unknown', ['--run', '--unknown'], 2],
  ['helper help plus run', ['--help', '--run'], 2], ['helper repeated run', ['--run', '--run'], 2],
  ['helper extra option refused', ['--run', '--sha', 'synthetic'], 2], ['helper exact run selected', ['--run'], null],
]) check(name, preflight, argv, exit, exit === null);

const localPath = 'scripts/lib/engagement-local-cli.mjs';
const localSource = readFileSync(localPath, 'utf8');
const localSf = ts.createSourceFile(localPath, localSource, ts.ScriptTarget.Latest, true);
const localFunction = localSf.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'requireLocalRun');
const localOptions = localSf.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(localSf) === 'PHASE1_LOCAL_OPTIONS'));
assert(localFunction && localOptions);
const localText = [localOptions, localFunction].map(n => n.getText(localSf).replace(/^export\s+/, '')).join('\n');
const invokeLocal = 'globalThis.forwarded = requireLocalRun(inputArgs, "synthetic usage", PHASE1_LOCAL_OPTIONS); globalThis.runSelected = true;';
for (const [name, argv, exit] of [
  ['local no arguments', [], 2], ['local help', ['--help'], 0],
  ['local run help', ['--run', '--help'], 0], ['local unknown', ['--unknown'], 2],
  ['local run unknown', ['--run', '--unknown'], 2], ['local duplicate run', ['--run', '--run'], 2],
  ['local valid run stripped', ['--run'], null],
  ['local options preserve order', ['--run', '--sha', 'synthetic', '--evidence-dir=synthetic-directory'], null],
]) {
  const c = check(name, localText, argv, exit, exit === null, invokeLocal);
  if (exit === null) {
    const forwarded = Array.from(c.forwarded);
    assert.deepEqual(forwarded, argv.slice(1));
    assert.equal(['--run', ...forwarded].filter(a => a === '--run').length, 1);
    results.at(-1).forwarded = forwarded;
  }
}

const runnerPath = 'scripts/run-engagement-phase1-local.mjs';
const runner = ts.createSourceFile(runnerPath, readFileSync(runnerPath, 'utf8'), ts.ScriptTarget.Latest, true);
const calls = [];
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(runner) === 'run' && node.arguments[0]?.getText(runner) === "'DB-free exact-head closeout'") calls.push(node);
  ts.forEachChild(node, walk);
}
walk(runner);
assert.equal(calls.length, 1);
const operands = calls[0].arguments[2];
assert(ts.isArrayLiteralExpression(operands));
const localArgv = operands.elements.map(n => { assert(ts.isStringLiteral(n)); return n.text; });
assert.deepEqual(localArgv, ['--filter', '@capiro/api', 'exec', 'tsx', 'scripts/verify-engagement-phase1-runtime.ts', '--run']);
const phase2 = readFileSync('scripts/verify-engagement-phase2-code.sh', 'utf8');
assert(phase2.includes('phase1_gate "$p1_log" 2700 pnpm verify:engagement-phase-1'));
assert(phase2.includes('"$TIMEOUT_BIN" --signal=TERM --kill-after=10s "$deadline" "$@" 2>&1 | tee "$log"'));
assert(phase2.includes('[ "${statuses[0]}" -eq 0 ] && [ "${statuses[1]}" -eq 0 ]'));
assert(phase2.includes("grep -q '^ENGAGEMENT_PHASE1_DB_FREE_COMPLETE$' \"$log\""));
assert(phase2.includes("! grep -q 'ENGAGEMENT_PHASE1_DB_FREE_FAILED' \"$log\""));
const result = {
  source: '2496e57b4193cdd4d004232711a77ef707ae6b98', tree: 'ed4f162b3b59dbc27b3757170073e88be0181f35',
  inertPreflightCases: results, cases: results.length, localHelperArgv: localArgv,
  phase2CallsCanonicalRootAliasWithoutChangingForwardedArgv: true,
  phase2DeadlineExitAndCompletionFailurePredicatesPreserved: true,
  operationalFunctionsExecuted: false, realChildOrResourceCalls: 0,
};
writeFileSync(OUT + 'inert-preflight.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
