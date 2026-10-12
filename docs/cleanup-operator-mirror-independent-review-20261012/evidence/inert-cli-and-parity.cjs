// Independent source-only review. No production module is required: target
// source is transpiled with all imports replaced by explicit synthetic callbacks.
// Only this script's source reads and read-only Git subprocesses are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript');
const base = '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70';
const head = 'aaea904f9d16df38ef57bc1d668a2b06f8d0fd14';
const tree = '41b8827051bac6d2c1ef4650798c8cdc330d5353';
const baseline = process.argv.includes('--baseline');
const git = (...args) => execFileSync('git', args);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const read = (file) => fs.readFileSync(file, 'utf8');
const names = ['phase6-stage-cycle.ts', 'plan-defense-budget-promotion-v1.ts', 'status-defense-budget-promotion-v1.ts'];
const oldBlobs = ['9bd1bb63da4397b35f347af2ea945b1bcb3c8df5', '94fef129178ecfd4c5118e6ae17a7bab5ac23e55', 'de5426ebfa605340f52334003f18ad691f1df2df'];
const newBlobs = ['d9a82728dc01bd0b48a92580ab581b13ff19bec8', 'c5be25e428397dcf41c10a6cadba0bd6ca3ae2df', 'd36871ae5ce879f59b941f6ab5eb1c944ab0dec8'];
const imports = (name, text) => {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  assert.equal(sf.parseDiagnostics.length, 0);
  return sf.statements.filter(ts.isImportDeclaration).map((n) => n.getText(sf));
};
const pairs = names.map((name, index) => {
  const source = 'apps/api/scripts/' + name;
  const mirror = 'apps/defense-api/runtime-source/operators/' + name;
  const canonical = git('show', base + ':' + source).toString();
  const original = git('show', base + ':' + mirror).toString();
  const repaired = git('show', head + ':' + mirror).toString();
  assert.equal(read(source), canonical);
  assert.equal(read(mirror), repaired);
  assert.equal(git('rev-parse', base + ':' + source).toString().trim(), newBlobs[index]);
  assert.equal(git('rev-parse', base + ':' + mirror).toString().trim(), oldBlobs[index]);
  assert.equal(git('rev-parse', head + ':' + mirror).toString().trim(), newBlobs[index]);
  assert.deepEqual(imports(name, original), imports(name, repaired));
  assert.deepEqual(imports(name, repaired), imports(name, canonical));
  return { name, source, mirror, canonical, original, tested: baseline ? original : repaired,
    oldBlob: oldBlobs[index], newBlob: newBlobs[index], originalSha256: hash(original),
    newSha256: hash(repaired), exactCanonicalEquality: (baseline ? original : repaired) === canonical };
});
assert.equal(git('rev-parse', head + '^{tree}').toString().trim(), tree);
const changed = git('diff', '--name-only', base, head).toString().trim().split('\n');
assert.deepEqual(changed.sort(), pairs.map((p) => p.mirror).sort());
function literalArray(file, variable) {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const declaration = sf.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations]).find((d) => d.name.getText(sf) === variable);
  assert(declaration);
  let value = declaration.initializer;
  while (ts.isAsExpression(value)) value = value.expression;
  assert(ts.isArrayLiteralExpression(value));
  return value.elements.map((v) => { assert(ts.isStringLiteral(v)); return v.text; });
}
const commands = literalArray('apps/api/src/defense-budget/phase6/phase6-cycle-runner-v1.ts', 'PHASE6_OPERATOR_COMMAND_VALUES');
const families = literalArray('apps/api/src/defense-budget/contracts/extraction-artifact-v1.ts', 'BUDGET_FAMILY_V1_VALUES');
assert.equal(commands.length, 6);
assert(families.includes('rdte'));
class SyntheticExit extends Error { constructor(code) { super('synthetic exit ' + code); this.code = code; } }
async function execute(name, text, fixture) {
  const events = { imports: [], dotenv: 0, fileReads: [], childCallbacks: [], plannerCallbacks: [], prismaConstructors: 0, stdout: [], stderr: [] };
  const environment = fixture.database ? { DATABASE_URL: 'postgresql://synthetic.invalid/fixture' } : {};
  const fakeProcess = { argv: ['node', name, ...fixture.args], env: environment,
    platform: fixture.windows ? 'win32' : 'linux', cwd: () => '/synthetic-cwd',
    exitCode: 0, exit(code) {
      this.exitCode = code;
      // Import-only baseline fixtures have already stopped at the synthetic
      // Prisma barrier, so their outer catch's exit can return harmlessly.
      if (!fixture.importOnly) throw new SyntheticExit(code);
    } };
  const runner = {
    PHASE6_OPERATOR_COMMAND_VALUES: commands,
    buildPhase6OperatorPlanV1(command, input) { events.plannerCallbacks.push({ command, input }); return { synthetic: true, command, input }; },
  };
  const modules = {
    'node:child_process': { spawnSync(executable, argv, options) {
      events.childCallbacks.push({ executable, argv, options });
      return fixture.childError ? { error: new Error('synthetic child failure'), status: null }
        : { status: fixture.childStatus === undefined ? 0 : fixture.childStatus };
    } },
    'node:fs': { readFileSync(file, encoding) { events.fileReads.push({ file, encoding }); return fixture.badJson ? '{broken' : '{"synthetic":true}'; } },
    'node:crypto': { createHash() { throw new Error('unexpected synthetic crypto invocation'); } },
    dotenv: { config() { events.dotenv++; return {}; } },
    '@prisma/client': { PrismaClient: class { constructor() { events.prismaConstructors++; throw new Error('synthetic Prisma constructor barrier'); } } },
    '../src/defense-budget/phase6/phase6-cycle-runner-v1.js': runner,
    '../src/defense-budget/promotion/promotion-planner-v1.js': {},
    '../src/defense-budget/promotion/canonical-mapping-registry-v1.js': {},
    '../src/defense-budget/promotion/eligibility-bound-projection-source-prisma-v1.js': {},
    '../src/defense-budget/contracts/extraction-artifact-v1.js': { BUDGET_FAMILY_V1_VALUES: families },
    '../src/defense-budget/contracts/canonical-json.js': {},
    '../src/defense-budget/promotion/promotion-eligibility-v1.js': {},
    '../src/defense-budget/promotion/slo-metrics-v1.js': {},
  };
  const module = { exports: {} };
  const syntheticRequire = (specifier) => {
    events.imports.push(specifier);
    assert(Object.hasOwn(modules, specifier), 'unexpected require ' + specifier);
    return modules[specifier];
  };
  syntheticRequire.main = fixture.importOnly ? {} : module;
  let evaluatedSource = text;
  // For async CLI guard probes, preserve the exact main function and imports
  // but invoke it ourselves. A synthetic process.exit throws; running the real
  // outer .catch would incorrectly turn that artificial throw into exit 1.
  // Import-only probes evaluate the entire unmodified module and guarded tail.
  const isolatedAsyncMain = !fixture.importOnly && !name.startsWith('phase6');
  if (isolatedAsyncMain) {
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const last = sf.statements.at(-1);
    assert(ts.isIfStatement(last) || ts.isExpressionStatement(last));
    assert(last.getText(sf).includes('main().catch('));
    evaluatedSource = text.slice(0, last.getStart(sf)) + '\nexport { main };\n';
  }
  const compiled = ts.transpileModule(evaluatedSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } });
  assert.equal((compiled.diagnostics ?? []).length, 0);
  const console = { log: (...args) => events.stdout.push(args.map(String).join(' ')), error: (...args) => events.stderr.push(args.map(String).join(' ')) };
  const context = { module, exports: module.exports, require: syntheticRequire, process: fakeProcess, console, Error, URL };
  let thrown;
  try {
    vm.runInNewContext(compiled.outputText, context, { timeout: 1000 });
    if (isolatedAsyncMain) await module.exports.main();
    // For baseline unguarded import tails, wait only for their synthetic catch.
    await Promise.resolve();
  } catch (error) {
    if (!(error instanceof SyntheticExit)) thrown = { name: error.name, message: error.message };
  }
  return { exitCode: fakeProcess.exitCode, thrown, isolatedAsyncMain, events };
}
const ordinary = commands[1];
const phase = (name, args, expected, extra = {}) => ({ file: names[0], name, args, expected, ...extra });
const plan = (name, args, expected, extra = {}) => ({ file: names[1], name, args, expected, ...extra });
const status = (name, args, expected, extra = {}) => ({ file: names[2], name, args, expected, ...extra });
const inert = (exitCode) => ({ exitCode, fileReads: 0, childCallbacks: 0, plannerCallbacks: 0, prismaConstructors: 0 });
const guards = [
  phase('no args prints usage before resources', [], { ...inert(1), usage: true }),
  phase('help stops before resources', ['--help'], { ...inert(0), usage: true }),
  phase('unknown command refuses before resources', ['--command', 'unknown'], inert(1)),
  phase('incomplete command refuses', ['--command'], inert(1)),
  phase('unknown bare flag refuses', ['--unknown'], inert(1)),
  phase('commit forbidden before delegated extraction', ['--command', commands[0], '--commit'], inert(1)),
  phase('promotion forbidden before input read', ['--command', ordinary, '--input', 'fixture.json', '--promote'], inert(1)),
  phase('missing input refuses', ['--command', ordinary], inert(1)),
  phase('input option without value refuses', ['--command', ordinary, '--input'], inert(1)),
  phase('option-looking input refuses', ['--command', ordinary, '--input', '--unknown'], inert(1)),
  phase('unknown option in inspect mode refuses before file', ['--command', ordinary, '--input', 'fixture.json', '--unknown'], inert(1)),
  phase('help mixed with inspect options refuses before file', ['--command', ordinary, '--input', 'fixture.json', '--help'], inert(1)),
  ...commands.slice(1).map((command) => phase('configured inspect ' + command, ['--command', command, '--input', 'fixture.json'], { ...inert(0), fileReads: 1, plannerCallbacks: 1 })),
  phase('malformed JSON preserved failure', ['--command', ordinary, '--input', 'fixture.json'], { ...inert(1), fileReads: 1 }, { badJson: true }),
  phase('extraction forwards Phase3 flags', ['--command', commands[0], '--manifest', 'fixture.json', '--out', 'synthetic.json'], { ...inert(0), childCallbacks: 1 }),
  phase('extraction delegates unknown flag validation', ['--command', commands[0], '--unknown'], { ...inert(0), childCallbacks: 1 }),
  phase('extraction forbids inspect input before child', ['--command', commands[0], '--input', 'fixture.json'], inert(1)),
  phase('extraction Windows executable preserved', ['--command', commands[0]], { ...inert(0), childCallbacks: 1 }, { windows: true }),
  phase('extraction child status preserved', ['--command', commands[0]], { ...inert(7), childCallbacks: 1 }, { childStatus: 7 }),
  phase('extraction missing child status becomes 1', ['--command', commands[0]], { ...inert(1), childCallbacks: 1 }, { childStatus: null }),
  phase('extraction child error caught', ['--command', commands[0]], { ...inert(1), childCallbacks: 1 }, { childError: true }),
  phase('Phase6 existing eager import tail preserved', [], { ...inert(1), usage: true }, { importOnly: true }),
];
const validPlan = ['--environment', 'synthetic', '--cycle-id', 'fixture', '--fiscal-year', '2027', '--families', 'rdte', '--eligibility-hash', 'a'.repeat(64)];
const withReplacement = (flag, value) => { const args = [...validPlan]; args[args.indexOf(flag) + 1] = value; return args; };
guards.push(
  plan('missing DATABASE_URL no args refuses before Prisma', [], inert(2)),
  plan('unsupported help missing DB preserves configuration refusal', ['--help'], inert(2)),
  plan('missing DB fully configured args refuse before Prisma', validPlan, inert(2)),
  ...['--environment', '--cycle-id', '--fiscal-year', '--families', '--eligibility-hash'].map((flag) => plan('missing required ' + flag, withReplacement(flag, ''), inert(2), { database: true })),
  ...[['--eligibility-hash', 'A'.repeat(64)], ['--eligibility-hash', 'a'.repeat(63)], ['--fiscal-year', 'not-number'], ['--fiscal-year', '2027.5'], ['--fiscal-year', '2201'], ['--families', ', ,'], ['--families', 'not-family']].map(([flag, value]) => plan('invalid ' + flag + '=' + value, withReplacement(flag, value), inert(2), { database: true })),
  plan('invalid promotion mode refuses before Prisma', [...validPlan, '--mode', 'invalid'], inert(2), { database: true }),
  plan('configured main reaches synthetic owner barrier', validPlan, { ...inert(0), prismaConstructors: 1, thrown: 'synthetic Prisma constructor barrier' }, { database: true }),
  plan('configured unknown flag remains inherited non-universal guard', [...validPlan, '--unknown'], { ...inert(0), prismaConstructors: 1, thrown: 'synthetic Prisma constructor barrier' }, { database: true }),
  plan('import-only main guard stops configured owner', validPlan, inert(0), { database: true, importOnly: true }),
  status('missing DATABASE_URL no args refuses before Prisma', [], inert(2)),
  status('unsupported help missing DB preserves configuration refusal', ['--help'], inert(2)),
  status('missing DB with environment refuses before Prisma', ['--environment', 'synthetic'], inert(2)),
  status('configured missing environment refuses', [], inert(2), { database: true }),
  status('configured main reaches synthetic owner barrier', ['--environment', 'synthetic'], { ...inert(0), prismaConstructors: 1, thrown: 'synthetic Prisma constructor barrier' }, { database: true }),
  status('configured unknown flag remains inherited non-universal guard', ['--environment', 'synthetic', '--unknown'], { ...inert(0), prismaConstructors: 1, thrown: 'synthetic Prisma constructor barrier' }, { database: true }),
  status('import-only main guard stops configured owner', ['--environment', 'synthetic'], inert(0), { database: true, importOnly: true }),
);
function violations(observed, expected) {
  const failures = [];
  if (observed.exitCode !== expected.exitCode) failures.push('exitCode');
  for (const field of ['fileReads', 'childCallbacks', 'plannerCallbacks']) if (observed.events[field].length !== expected[field]) failures.push(field);
  if (observed.events.prismaConstructors !== expected.prismaConstructors) failures.push('prismaConstructors');
  if ((observed.thrown?.message) !== expected.thrown) failures.push('thrown');
  if (expected.usage && ![...observed.events.stdout, ...observed.events.stderr].some((v) => v.startsWith('Usage:'))) failures.push('usage');
  return failures;
}
(async () => {
  const results = [];
  for (const fixture of guards) {
    const pair = pairs.find((p) => p.name === fixture.file);
    const canonical = await execute(pair.name, pair.canonical, fixture);
    assert.deepEqual(violations(canonical, fixture.expected), [], 'canonical probe ' + fixture.name);
    const actual = await execute(pair.name, pair.tested, fixture);
    results.push({ name: fixture.name, file: fixture.file, args: fixture.args,
      databaseFixture: !!fixture.database, importOnly: !!fixture.importOnly,
      expected: fixture.expected, canonical, observedMirror: actual,
      violations: violations(actual, fixture.expected),
      canonicalTraceEqual: JSON.stringify(actual) === JSON.stringify(canonical),
    });
  }
  const drift = pairs.filter((p) => !p.exactCanonicalEquality).length;
  const failed = results.filter((r) => r.violations.length || !r.canonicalTraceEqual);
  const configured = results.filter((r) => r.name === 'configured main reaches synthetic owner barrier');
  assert(configured.every((r) => r.canonical.events.prismaConstructors === 1));
  console.log(JSON.stringify({ head, tree, base, baseline, node: process.version, cachedTypeScript: ts.version,
    changedProductionPaths: changed, pairs: pairs.map(({ canonical, original, tested, ...p }) => p),
    canonicalSourceUnchanged: true, importsUnchanged: true, driftCount: drift,
    sourceProbeCases: results.length, sourceFragmentExecutions: results.length * 2,
    failedMirrorProbeCases: failed.length, results,
    allDependenciesSynthetic: true, productionDependenciesLoaded: false,
    actualDatabaseFileChildProviderNativeOperations: false,
    asyncGuardProbeQualification: 'Exact original main/import source evaluated without outer CLI catch to emulate process.exit without synthetic catch contamination; full unmodified modules used for import-only probes. Configured paths stop at a synthetic Prisma constructor barrier.',
    phase6UnknownFlagQualification: 'Inspect options reject unknown tokens; extraction delegates Phase3 flag validation. Plan/status retain original non-universal flag handling and unsupported help.',
    dotenvQualification: 'Planner/status retain top-level dotenvConfig; synthetic config callback runs on import. No claim of completely side-effect-free real imports.',
    nativeRlsOrFullVerifierAccepted: false,
  }, null, 2));
  if (drift || failed.length) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 2; });
