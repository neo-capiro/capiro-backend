import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const ts = createRequire('/workspace/capirov2/package.json')('typescript');
const base = '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70';
const names = ['phase6-stage-cycle.ts', 'plan-defense-budget-promotion-v1.ts', 'status-defense-budget-promotion-v1.ts'];
const text = (file) => readFileSync(file, 'utf8');
const parse = (file) => ts.createSourceFile(file, text(file), ts.ScriptTarget.Latest, true);
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const rootPairs = names.map((name) => ({ name, canonical: 'apps/api/scripts/' + name, mirror: 'apps/defense-api/runtime-source/operators/' + name }));
const equalToFrozen = (source, mirror, canonical) => source === canonical && source === mirror;

for (const pair of rootPairs) {
  test(pair.name + ': exact canonical bytes, original history retained, one-byte drift refuses', () => {
    const source = text(pair.canonical);
    const canonical = execFileSync('git', ['show', base + ':' + pair.canonical], { encoding: 'utf8' });
    const originalMirror = execFileSync('git', ['show', base + ':' + pair.mirror], { encoding: 'utf8' });
    const repaired = text(pair.mirror);
    assert.notEqual(originalMirror, canonical);
    assert(equalToFrozen(source, repaired, canonical));
    assert(!equalToFrozen(source, originalMirror, canonical));
    assert(!equalToFrozen(source, repaired + '\n', canonical));
    assert(!equalToFrozen(source.replace('main()', 'otherMain()'), repaired, canonical));
    assert(!equalToFrozen(source + '\n', repaired + '\n', canonical));
  });
  test(pair.name + ': imports unchanged and syntax parses without loading imports', () => {
    const before = execFileSync('git', ['show', base + ':' + pair.mirror], { encoding: 'utf8' });
    const after = parse(pair.mirror);
    const old = ts.createSourceFile(pair.mirror, before, ts.ScriptTarget.Latest, true);
    assert.equal(after.parseDiagnostics.length, 0);
    assert.deepEqual(after.statements.filter(ts.isImportDeclaration).map((s) => s.getText(after)),
      old.statements.filter(ts.isImportDeclaration).map((s) => s.getText(old)));
  });
}

const runner = parse('apps/api/src/defense-budget/phase6/phase6-cycle-runner-v1.ts');
const commandDeclaration = runner.statements.find((statement) => ts.isVariableStatement(statement) &&
  statement.declarationList.declarations.some((declaration) => declaration.name.getText(runner) === 'PHASE6_OPERATOR_COMMAND_VALUES'));
assert(commandDeclaration);
const commandSource = commandDeclaration.getText(runner);
const commands = [];
vm.runInNewContext(compile(commandSource + '\ncommands.push(...PHASE6_OPERATOR_COMMAND_VALUES);'), { commands, exports: {} });

// Only actual operator function declarations are evaluated. All imports and
// top-level initialization are absent; fs/build/spawn are inert recording ports.
function phaseCase(file, argv, platform = 'linux') {
  const source = parse(file);
  const functions = source.statements.filter(ts.isFunctionDeclaration).map((node) => node.getText(source)).join('\n');
  const events = [];
  const processStub = { argv: ['node', 'inert-operator.ts', ...argv], platform, exitCode: 0, cwd: () => '/synthetic-only' };
  const context = { process: processStub, events, exports: {},
    console: { log: (value) => events.push(['log', value]), error: (value) => events.push(['error', value]) },
    fs: { readFileSync: (file, encoding) => { events.push(['read', file, encoding]); return '{}'; } },
    spawnSync: (executable, args, options) => { events.push(['spawn-port', executable, Array.from(args), { ...options }]); return { status: 0 }; },
    buildPhase6OperatorPlanV1: (command, input) => { events.push(['build-port', command, input]); return { syntheticPlan: true }; },
  };
  let thrown;
  try { vm.runInNewContext(compile(commandSource + '\n' + functions + '\nmain();'), context); }
  catch (error) { thrown = error.message; }
  return JSON.parse(JSON.stringify({ events, exitCode: processStub.exitCode, thrown }));
}

const phaseCases = [
  { label: 'no args refuses before IO', argv: [], exitCode: 1, io: 0 },
  { label: 'sole help succeeds before IO', argv: ['--help'], exitCode: 0, io: 0 },
  { label: 'help plus another token is not help', argv: ['--help', 'extra'], error: '--command must be one', io: 0 },
  { label: 'commit always refuses', argv: ['--command', 'extract_stage_document', '--commit'], error: 'do not support canonical', io: 0 },
  { label: 'promote always refuses', argv: ['--command', 'report_cycle_certification', '--promote'], error: 'do not support canonical', io: 0 },
  { label: 'unknown command refuses', argv: ['--command', 'unknown'], error: '--command must be one', io: 0 },
  { label: 'incomplete command refuses', argv: ['--command'], error: '--command must be one', io: 0 },
  { label: 'missing input refuses', argv: ['--command', 'report_cycle_certification'], error: '--input <cycle-input.json> is required', io: 0 },
  { label: 'incomplete input refuses', argv: ['--command', 'report_cycle_certification', '--input'], error: 'Unsupported or incomplete', io: 0 },
  { label: 'input value that begins flag refuses', argv: ['--command', 'report_cycle_certification', '--input', '--help'], error: 'Unsupported or incomplete', io: 0 },
  { label: 'extra inspect flag refuses', argv: ['--command', 'report_cycle_certification', '--input', 'synthetic.json', '--other'], error: 'Unsupported or incomplete', io: 0 },
  { label: 'extract cannot receive cycle-input flag', argv: ['--command', 'extract_stage_document', '--input', 'synthetic.json'], error: 'uses Phase 3 extraction flags', io: 0 },
];
for (const command of commands.filter((value) => value !== 'extract_stage_document')) phaseCases.push({
  label: command + ' reaches only inert inspect ports', argv: ['--command', command, '--input', 'synthetic.json'], exitCode: 0, io: 2, command,
});
phaseCases.push({ label: 'extraction delegates exact argv to inert port', argv: ['--command', 'extract_stage_document', '--manifest', 'synthetic.json', '--out', 'synthetic.out'], exitCode: 0, io: 1, spawn: 'pnpm' });
phaseCases.push({ label: 'Windows retains pnpm.cmd delegation', argv: ['--command', 'extract_stage_document', '--manifest', 'synthetic.json', '--out', 'synthetic.out'], platform: 'win32', exitCode: 0, io: 1, spawn: 'pnpm.cmd' });
for (const item of phaseCases) test('phase6: ' + item.label + ' (both exact owners)', () => {
  const observations = [rootPairs[0].canonical, rootPairs[0].mirror].map((file) => phaseCase(file, item.argv, item.platform));
  assert.deepEqual(observations[0], observations[1]);
  const observed = observations[0];
  if (item.error) assert(observed.thrown?.includes(item.error));
  else { assert.equal(observed.thrown, undefined); assert.equal(observed.exitCode, item.exitCode); }
  assert.equal(observed.events.filter((event) => ['read', 'build-port', 'spawn-port'].includes(event[0])).length, item.io);
  if (item.command) assert.equal(observed.events.find((event) => event[0] === 'build-port')[1], item.command);
  if (item.spawn) {
    const event = observed.events.find((entry) => entry[0] === 'spawn-port');
    assert.equal(event[1], item.spawn);
    assert.deepEqual(event[2], ['exec', 'tsx', 'scripts/extract-defense-budget-cycle.ts', '--manifest', 'synthetic.json', '--out', 'synthetic.out']);
    assert.deepEqual(event[3], { cwd: '/synthetic-only', stdio: 'inherit' });
  }
});

// Promotion/status checks extract exactly the original CLI validation prefix
// before the first Prisma constructor. They cannot load/create/query a client.
async function validationCase(file, argv, environment) {
  const source = parse(file);
  const main = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'main');
  const constructor = main.body.statements.findIndex((node) => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) => declaration.initializer && ts.isNewExpression(declaration.initializer) && declaration.initializer.expression.getText(source) === 'PrismaClient'));
  assert(constructor > 0);
  const prefix = main.body.statements.slice(0, constructor).map((node) => node.getText(source)).join('\n');
  const helpers = source.statements.filter((node) => ts.isFunctionDeclaration(node) && ['argValue', 'usage'].includes(node.name.text)).map((node) => node.getText(source)).join('\n');
  const constants = `const DEFAULT_DOMAIN='defense_budget'; const PROMOTION_MODES=['baseline_hydration','new_cycle','correction','rollback'];`;
  const familiesDeclaration = parse('apps/api/src/defense-budget/contracts/extraction-artifact-v1.ts');
  const familiesNode = familiesDeclaration.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(familiesDeclaration) === 'BUDGET_FAMILY_V1_VALUES'));
  assert(familiesNode);
  const events = [];
  const context = { exports: {}, process: { argv: ['node', 'inert-prefix.ts', ...argv], env: { ...environment }, exit(code) { throw { syntheticExit: code }; } },
    console: { error: (message) => events.push(['error', message]) }, result: null,
    PrismaClient: class { constructor() { throw new Error('FORBIDDEN constructor reached'); } } };
  vm.runInNewContext(compile(constants + '\n' + familiesNode.getText(familiesDeclaration) + '\n' + helpers + '\nasync function main(){' + prefix + '\nreturn {validated:true};}\nresult=main();'), context);
  try { return { returned: JSON.parse(JSON.stringify(await context.result)), events }; }
  catch (error) { assert.equal(typeof error.syntheticExit, 'number'); return { exited: error.syntheticExit, events }; }
}
const common = ['--environment', 'synthetic', '--cycle-id', 'cycle', '--fiscal-year', '2027', '--families', 'rdte', '--eligibility-hash', 'a'.repeat(64)];
function replace(flag, value) { const args = [...common]; args[args.indexOf(flag) + 1] = value; return args; }
const planCases = [
  { label: 'database config missing before all other validation', args: common, env: {}, exit: 2, message: 'requires DATABASE_URL' },
  { label: 'environment missing', args: [], exit: 2, message: '--environment is required' },
  { label: 'cycle missing', args: ['--environment', 'synthetic'], exit: 2, message: '--cycle-id is required' },
  { label: 'fiscal year missing', args: common.slice(0, 4), exit: 2, message: '--fiscal-year is required' },
  { label: 'families missing', args: common.slice(0, 6), exit: 2, message: '--families is required' },
  { label: 'eligibility missing', args: common.slice(0, 8), exit: 2, message: '--eligibility-hash is required' },
  { label: 'uppercase eligibility refuses', args: replace('--eligibility-hash', 'A'.repeat(64)), exit: 2, message: '64 lowercase hex' },
  { label: 'short eligibility refuses', args: replace('--eligibility-hash', 'a'.repeat(63)), exit: 2, message: '64 lowercase hex' },
  { label: 'fractional fiscal year refuses', args: replace('--fiscal-year', '2027.5'), exit: 2, message: 'integer between' },
  { label: 'low fiscal year refuses', args: replace('--fiscal-year', '1899'), exit: 2, message: 'integer between' },
  { label: 'high fiscal year refuses', args: replace('--fiscal-year', '2201'), exit: 2, message: 'integer between' },
  { label: 'empty families refuses', args: replace('--families', ', ,'), exit: 2, message: 'at least one family' },
  { label: 'unlisted family refuses', args: replace('--families', 'review_not_a_family'), exit: 2, message: 'unknown budget family' },
  { label: 'existing unknown family remains allowed', args: replace('--families', 'unknown') },
  { label: 'unknown mode refuses', args: [...common, '--mode', 'execute'], exit: 2, message: '--mode must be one' },
  { label: 'valid scope stops before Prisma', args: common },
];
for (const mode of ['baseline_hydration', 'correction', 'rollback']) planCases.push({ label: mode + ' mode stops before Prisma', args: [...common, '--mode', mode] });
for (const item of planCases) test('promotion plan validation: ' + item.label + ' (both exact owners)', async () => {
  const values = await Promise.all([rootPairs[1].canonical, rootPairs[1].mirror].map((file) => validationCase(file, item.args, item.env ?? { DATABASE_URL: 'synthetic-present-only' })));
  assert.deepEqual(values[0], values[1]);
  if (item.exit) { assert.equal(values[0].exited, item.exit); assert(values[0].events[0][1].includes(item.message)); }
  else assert.equal(values[0].returned.validated, true);
});
for (const item of [
  { label: 'missing database refuses first', args: ['--environment','synthetic'], env: {}, exit: 2, message: 'requires DATABASE_URL' },
  { label: 'missing environment refuses', args: [], env: { DATABASE_URL: 'synthetic-present-only' }, exit: 2, message: '--environment is required' },
  { label: 'valid environment stops before Prisma', args: ['--environment','synthetic'], env: { DATABASE_URL: 'synthetic-present-only' } },
]) test('promotion status validation: ' + item.label + ' (both exact owners)', async () => {
  const values = await Promise.all([rootPairs[2].canonical, rootPairs[2].mirror].map((file) => validationCase(file, item.args, item.env)));
  assert.deepEqual(values[0], values[1]);
  if (item.exit) { assert.equal(values[0].exited, item.exit); assert(values[0].events[0][1].includes(item.message)); }
  else assert.equal(values[0].returned.validated, true);
});

for (const pair of rootPairs.slice(1)) test(pair.name + ': import guard encloses main and Prisma remains function-local', () => {
  const source = parse(pair.mirror);
  const guard = source.statements.find((node) => ts.isIfStatement(node) && node.expression.getText(source) === 'require.main === module');
  assert(guard?.thenStatement.getText(source).includes('void main().catch'));
  const topLevel = source.statements.filter((node) => !ts.isFunctionDeclaration(node)).map((node) => node.getText(source)).join('\n');
  assert(!topLevel.includes('new PrismaClient'));
  assert(topLevel.includes('dotenvConfig()')); // unchanged source initialization, never executed here
});
test('plan refused/blocked returns retain finally disconnect source', () => {
  const source = parse(rootPairs[1].mirror);
  const main = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'main');
  const guarded = main.body.statements.find(ts.isTryStatement);
  assert(guarded.finallyBlock.getText(source).includes('await prisma.$disconnect()'));
  const body = guarded.tryBlock.getText(source);
  assert.equal(body.match(/process\.exitCode = 3; return;/g)?.length, 2);
  assert(!body.includes('process.exit(3)'));
});
