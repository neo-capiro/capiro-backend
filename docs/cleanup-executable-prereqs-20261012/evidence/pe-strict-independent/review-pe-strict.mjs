import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ts = createRequire('/workspace/capirov2/apps/api/package.json')('typescript');
const SOURCE = 'de623f0e6dd1e34e24435bb93dd3851c615f7be1';
const BASE = 'f1e83a3f194a8ebd972e370ff6e5b5f559888b29';
const PRIOR = '5db091dac54bc05f4a97a1495c8e6df238547c4d';
const wrappers = ['lint-pe-scripts.ts', 'verify-pe-migration-guards.ts', 'verify-pe-phase-e-exact-sha.ts']
  .map(name => `apps/api/scripts/${name}`);
const digest = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const blobs = new Map();
function blob(ref, rel) {
  const key = `${ref}:${rel}`;
  if (!blobs.has(key)) blobs.set(key, git('show', key));
  return blobs.get(key);
}
const parse = (rel, source) => ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const print = (node, sf) => printer.printNode(ts.EmitHint.Unspecified, node, sf);
function originalStatements(rel, source) {
  const sf = parse(rel, source);
  const firstFunction = sf.statements.findIndex(ts.isFunctionDeclaration);
  assert.ok(firstFunction >= 0);
  return sf.statements.filter((node, index) => ts.isImportDeclaration(node) || index >= firstFunction)
    .map(node => print(node, sf));
}
const bodyRows = wrappers.map(rel => {
  const original = originalStatements(rel, blob(BASE, rel));
  const current = originalStatements(rel, blob(SOURCE, rel));
  assert.deepEqual(current, original, `${rel}: baseline statements/imports changed`);
  const sf = parse(rel, blob(SOURCE, rel));
  const firstFunction = sf.statements.findIndex(ts.isFunctionDeclaration);
  const prefix = sf.statements.slice(0, firstFunction).filter(node => !ts.isImportDeclaration(node)).map(node => print(node, sf));
  const isMigration = rel.endsWith('/verify-pe-migration-guards.ts');
  const usage = `Usage: tsx scripts/${path.posix.basename(rel)} ${isMigration ? '[--validate-generate] ' : ''}[--help]`;
  const expectedPrefixSource = `const USAGE = '${usage}';
    const argv = process.argv.slice(2);
    const unknown = argv.filter((arg) => ${isMigration ? "arg !== '--validate-generate' && " : ''}arg !== '--help');
    if (unknown.length > 0) { console.error(\`Unknown argument(s): \${unknown.join(', ')}\`); console.error(USAGE); process.exit(2); }
    if (argv.includes('--help')) { console.log(USAGE); process.exit(0); }
    ${isMigration ? 'if (argv.length === 0) ' : ''}console.error(USAGE);`;
  const expectedPrefix = parse(rel, expectedPrefixSource);
  assert.deepEqual(prefix, expectedPrefix.statements.map(node => print(node, expectedPrefix)), `${rel}: unreviewed preflight statement`);
  const functionRows = sf.statements.filter(ts.isFunctionDeclaration).map(node => ({
    name: node.name.text, sha256: digest(print(node, sf)),
  }));
  return { path: rel, originalStatements: original.length, allOriginalStatementsAndImportsIdentical: true,
    verificationAstSha256: digest(current.join('\n')), sourceSha256: digest(blob(SOURCE, rel)), functionRows,
    preflightAstSha256: digest(prefix.join('\n')), preflightStatements: prefix.length, exactHelpUnknownUsageOnlyPreflight: true };
});
const changed = git('diff', '--name-only', PRIOR, SOURCE, '--', 'apps', 'packages', 'scripts', '.github')
  .trim().split('\n').filter(Boolean).sort();
assert.deepEqual(changed, [...wrappers].sort(), 'source/caller changes outside three wrappers');
const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'selected-source-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const unchangedRows = manifest.rows.filter(row => !wrappers.includes(row.path)).map(row => {
  const before = digest(blob(PRIOR, row.path)), after = digest(blob(SOURCE, row.path));
  assert.equal(after, before, `unrelated selected CLI changed: ${row.path}`);
  return { path: row.path, sha256: after };
});
assert.equal(unchangedRows.length, 447);

const localModules = new Set();
const imports = [];
function exportsOf(sf) {
  const result = new Set();
  for (const node of sf.statements) {
    if (!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(node)) for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) result.add(decl.name.text);
    }
    else if (node.name) result.add(node.name.text);
  }
  return result;
}
function scanImports(rel) {
  if (localModules.has(rel)) return;
  localModules.add(rel);
  const sf = parse(rel, blob(SOURCE, rel));
  for (const node of sf.statements.filter(ts.isImportDeclaration)) {
    if (node.importClause?.isTypeOnly) continue;
    const name = node.moduleSpecifier.text;
    if (!name.startsWith('.')) {
      assert.ok(['node:assert', 'node:fs', 'node:child_process', 'node:path'].includes(name), `${rel}: unexpected runtime import ${name}`);
      imports.push({ path: rel, module: name, builtin: true });
      continue;
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), name)).replace(/\.js$/, '.ts');
    const targetSf = parse(target, blob(SOURCE, target));
    const exports = exportsOf(targetSf);
    const names = node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      ? node.importClause.namedBindings.elements.filter(el => !el.isTypeOnly).map(el => el.propertyName?.text ?? el.name.text) : [];
    for (const symbol of names) assert.ok(exports.has(symbol), `${rel}: absent ${symbol} from ${target}`);
    imports.push({ path: rel, module: name, resolved: target, runtimeSymbols: names, allPresent: true });
    scanImports(target);
  }
}
wrappers.forEach(scanImports);
const owners = [...localModules].filter(rel => !wrappers.includes(rel)).map(rel => {
  assert.equal(blob(SOURCE, rel), blob(BASE, rel), `canonical helper changed: ${rel}`);
  return { path: rel, identicalToBaseline: true, sourceSha256: digest(blob(SOURCE, rel)) };
});

class Exit extends Error { constructor(code) { super(`inert exit ${code}`); this.code = code; } }
function probe(ref, rel, argv, replacements = {}) {
  const events = [], output = [], loaded = [], reads = [], cache = new Map();
  const full = path.resolve(root, rel);
  const fakeProcess = { argv: ['node', full, ...argv], env: {}, cwd: () => root,
    exit: code => { throw new Exit(code); } };
  const snapshot = rel => Object.hasOwn(replacements, rel) ? replacements[rel] : blob(ref, rel);
  const deny = kind => (...args) => { events.push({ kind, args }); throw new Error(`DENIED ${kind}`); };
  const normalize = absolute => path.relative(root, path.resolve(absolute)).replaceAll('\\', '/');
  const fs = {
    readFileSync: (absolute, encoding) => {
      assert.equal(encoding, 'utf8'); const rel = normalize(absolute);
      reads.push(rel); return snapshot(rel);
    },
    existsSync: absolute => { const rel = normalize(absolute); try { snapshot(rel); return true; } catch { return false; } },
    writeFileSync: deny('FILE_WRITE'), appendFileSync: deny('FILE_WRITE'), mkdirSync: deny('FILE_WRITE'),
  };
  const child = { execFileSync: (...args) => { events.push({ kind: 'INERT_CHILD', args }); return ''; },
    exec: deny('CHILD'), spawn: deny('CHILD'), execSync: deny('CHILD') };
  function evaluate(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    assert.ok(localModules.has(relative), `unknown runtime module ${relative}`);
    const module = { exports: {} }; cache.set(relative, module); loaded.push(relative);
    const require = name => {
      if (name === 'node:assert') return { strict: assert };
      if (name === 'node:fs') return fs;
      if (name === 'node:path') return path;
      if (name === 'node:child_process') return child;
      assert.ok(name.startsWith('.'), `unapproved import ${name}`);
      return evaluate(path.posix.normalize(path.posix.join(path.posix.dirname(relative), name)).replace(/\.js$/, '.ts'));
    };
    const code = ts.transpileModule(snapshot(relative), { fileName: relative, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    runInNewContext(code, { require, module, exports: module.exports, process: fakeProcess,
      console: Object.fromEntries(['log', 'error', 'warn'].map(key => [key, (...args) => output.push({ channel: key, text: args.join(' ') })])),
      Buffer, URL, fetch: deny('PROVIDER'), setTimeout: deny('TIMER'), setInterval: deny('TIMER'),
    }, { timeout: 1000 });
    return module.exports;
  }
  let exitCode = 0, error = null;
  try { evaluate(rel); } catch (e) { if (e instanceof Exit) exitCode = e.code; else { exitCode = 1; error = { name: e.name, message: e.message }; } }
  return { ref, path: rel, argv, exitCode, error, output, reads, loaded, events,
    realFileWriteDatabaseProviderBootstrapOrChildExecuted: false };
}
const probes = [];
for (const rel of wrappers) {
  for (const argv of [['--help'], ['--unknown'], ['--help', '--unknown'], ['--help', '--run']]) {
    const row = probe(SOURCE, rel, argv); const expected = argv.length === 1 && argv[0] === '--help' ? 0 : 2;
    assert.equal(row.exitCode, expected, JSON.stringify(row));
    assert.deepEqual(row.reads, []); assert.deepEqual(row.events, []);
    assert.ok(row.output.some(out => /Usage:/.test(out.text)));
    probes.push({ ...row, expected: 'help/refusal before all file reads and child/database/provider effects' });
  }
  for (const ref of [BASE, SOURCE]) probes.push({ ...probe(ref, rel, []), expected: 'default strict verifier on exact tracked source snapshots; refusal preserved as evidence' });
}
for (const rel of wrappers) {
  const baseline = probes.find(row => row.path === rel && row.ref === BASE && row.argv.length === 0);
  const current = probes.find(row => row.path === rel && row.ref === SOURCE && row.argv.length === 0);
  assert.equal(current.exitCode, baseline.exitCode);
  assert.deepEqual(current.error, baseline.error);
  assert.deepEqual(current.output.filter(row => !/^Usage:/.test(row.text)), baseline.output);
}
const migration = wrappers[1];
for (const argv of [['--help', '--validate-generate'], ['--validate-generate', '--help'], ['--validate-generate', '--unknown']]) {
  const row = probe(SOURCE, migration, argv);
  assert.equal(row.exitCode, argv.includes('--unknown') ? 2 : 0);
  assert.deepEqual(row.reads, []); assert.deepEqual(row.events, []);
  probes.push({ ...row, expected: 'help/unknown stops before optional native path' });
}
const cleanEntry = {
  'apps/api/scripts/entrypoint.sh': 'pnpm prisma migrate deploy\n',
  'apps/api/scripts/entrypoint-legacy.sh': '# explanatory prisma migrate resolve\n',
  'apps/api/scripts/entrypoint-dispatcher.inc': 'echo dispatch\n',
  'apps/api/package.json': JSON.stringify({ scripts: {
    'prisma:generate': 'prisma generate', 'prisma:migrate:deploy': 'prisma migrate deploy',
    'typecheck:pe-scripts': 'tsc -p tsconfig.pe-scripts.json --noEmit', 'lint:pe-scripts': 'tsx scripts/lint-pe-scripts.ts',
    'test:pe-trust': 'tsx scripts/lib/pe-trust-diagnostics.spec.ts', 'verify:pe-phase-k': 'tsx scripts/verify-pe-phase-k.ts',
  } }),
};
let cleanDefault = probe(SOURCE, migration, [], cleanEntry);
assert.equal(cleanDefault.exitCode, 0, JSON.stringify(cleanDefault)); assert.deepEqual(cleanDefault.events, []);
probes.push({ ...cleanDefault, expected: 'default performs only synthetic snapshot checks; no native child' });
for (const hazard of ['if [ "$OPERATOR" = "yes" ]; then psql -c "SELECT * FROM _prisma_migrations"; fi',
  'if [ "$OPERATOR" = "yes" ]; then pnpm prisma migrate resolve --applied fixed; fi',
  'psql -c "UPDATE migrations SET rolled_back_at = NOW()"']) {
  const row = probe(SOURCE, migration, ['--validate-generate'], { ...cleanEntry, 'apps/api/scripts/entrypoint-dispatcher.inc': hazard });
  assert.equal(row.exitCode, 1); assert.deepEqual(row.events, []);
  assert.match(row.error.message, /migration history mutation forbidden/);
  probes.push({ ...row, expected: 'strict guarded/manual history references refused before optional native path' });
}
const withNativeFixture = probe(SOURCE, migration, ['--validate-generate'], { ...cleanEntry,
  'apps/api/node_modules/prisma/build/index.js': 'inert fixture only' });
assert.equal(withNativeFixture.exitCode, 0, JSON.stringify(withNativeFixture));
assert.deepEqual(withNativeFixture.events.map(e => [e.kind, Array.from(e.args[1].slice(1))]),
  [['INERT_CHILD', ['validate']], ['INERT_CHILD', ['generate']]]);
probes.push({ ...withNativeFixture, expected: 'optional argv preserved at mock child only; no native subprocess executed' });

const loader = blob(SOURCE, 'apps/api/scripts/lib/pe-exact-sha-loader-contract.ts');
const loaderSf = parse('contract.ts', loader);
const declaration = loaderSf.statements.filter(ts.isVariableStatement).flatMap(n => n.declarationList.declarations)
  .find(n => n.name.getText(loaderSf) === 'PE_EXACT_SHA_DOLLAR_LOADERS');
const unwrap = node => ts.isAsExpression(node) ? unwrap(node.expression) : node;
const loaders = unwrap(declaration.initializer).elements.map(el => el.text);
const cleanLoaders = {};
for (const file of loaders) {
  const content = file === 'ingest-defense-budget-pdf.ts'
    ? "requireApprovedSha256(arg('approved-sha256')); assertApprovedShaMatches(sourceSha256, approvedSha256); const ALLOW_VENDOR_PARSE = '--allow-vendor-parse';"
    : file === 'load-defense-budget-package.ts' ? 'resolvePeDollarLoaderPosture; plan.errors;'
    : "from './lib/pe-exact-sha-loader-contract.js'; resolvePeDollarLoaderPosture; assertExactShaCommitAllowed; 'approved-sha256'; INSPECT;";
  cleanLoaders[`apps/api/scripts/${file}`] = content;
}
const exact = wrappers[2];
const passed = probe(SOURCE, exact, [], cleanLoaders);
assert.equal(passed.exitCode, 0, JSON.stringify(passed)); assert.deepEqual(passed.events, []);
probes.push({ ...passed, expected: 'all 13 exact-SHA loader predicates pass synthetic source matching original strict checks' });
for (const missing of ["from './lib/pe-exact-sha-loader-contract.js';", 'resolvePeDollarLoaderPosture;',
  'assertExactShaCommitAllowed;', "'approved-sha256';", 'INSPECT;']) {
  const key = 'apps/api/scripts/sync-jbook-r2.ts';
  const row = probe(SOURCE, exact, [], { ...cleanLoaders, [key]: cleanLoaders[key].replace(missing, '') });
  assert.equal(row.exitCode, 1, JSON.stringify(row)); assert.deepEqual(row.events, []);
  probes.push({ ...row, expected: `missing ${missing} fails unchanged strict loader predicate` });
}
const facade = probe(SOURCE, exact, [], { ...cleanLoaders,
  'apps/api/scripts/sync-jbook-r2.ts': "console.log('INSPECT'); // inspect-only facade with no exact-SHA commit contract" });
assert.equal(facade.exitCode, 1); assert.deepEqual(facade.events, []);
probes.push({ ...facade, expected: 'inspect-only facade receives no special exemption from exact-SHA inventory' });

console.log(JSON.stringify({ source: SOURCE, tree: git('rev-parse', `${SOURCE}^{tree}`).trim(), base: BASE, priorAcceptedSource: PRIOR,
  sourceOnly: true, sourceDelta: changed, allCallerPathsUnchangedSincePriorAcceptance: true,
  bodyRows, owners, imports, unchangedSelectedCliCount: unchangedRows.length, unchangedSelectedCliRows: unchangedRows,
  probes: probes.length, rows: probes,
  limits: 'AST/source and inert VM only; no native compiler acceptance, real DB/migration/provider/bootstrap or child invocation.' }, null, 2));
