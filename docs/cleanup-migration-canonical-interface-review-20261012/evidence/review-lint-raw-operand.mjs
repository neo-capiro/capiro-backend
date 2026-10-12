import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const compiler = createRequire(import.meta.url)('typescript');
const apiRoot = path.resolve('apps/api');
const lintPath = path.join(apiRoot, 'scripts/lint-pe-scripts.ts');
const source = fs.readFileSync(lintPath, 'utf8');
const transpile = (text) => compiler.transpileModule(text, {
  compilerOptions: { module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function literalArray(file, name) {
  const sf = compiler.createSourceFile(file, fs.readFileSync(file, 'utf8'), compiler.ScriptTarget.Latest, true);
  let result;
  function visit(node) {
    if (compiler.isVariableDeclaration(node) && compiler.isIdentifier(node.name) && node.name.text === name) {
      let initializer = node.initializer;
      while (compiler.isAsExpression(initializer) || compiler.isSatisfiesExpression(initializer)) initializer = initializer.expression;
      assert(compiler.isArrayLiteralExpression(initializer));
      assert(initializer.elements.every(compiler.isStringLiteralLike));
      result = initializer.elements.map((element) => element.text);
    }
    compiler.forEachChild(node, visit);
  }
  visit(sf);
  assert(result, 'catalog must be a source-owned literal array: ' + name);
  return result;
}
const catalogFile = path.join(apiRoot, 'scripts/lib/pe-production-scripts.ts');
const catalogs = {
  PE_PRODUCTION_SCRIPTS: literalArray(catalogFile, 'PE_PRODUCTION_SCRIPTS'),
  PE_PRODUCTION_SCRIPT_HELPERS: literalArray(catalogFile, 'PE_PRODUCTION_SCRIPT_HELPERS'),
};
const exactShaCatalog = { PE_EXACT_SHA_DOLLAR_LOADERS: literalArray(path.join(apiRoot, 'scripts/lib/pe-exact-sha-loader-contract.ts'), 'PE_EXACT_SHA_DOLLAR_LOADERS') };
const guard = {};
vm.runInNewContext(transpile(fs.readFileSync(path.join(apiRoot, 'scripts/lib/pe-migration-guards.ts'), 'utf8')), {
  exports: guard,
  require: (name) => { assert.equal(name, 'node:crypto'); return { createHash }; },
});
class Exit extends Error { constructor(code) { super('inert process exit'); this.code = code; } }
const entryPaths = ['scripts/entrypoint.sh', 'scripts/entrypoint-legacy.sh', 'scripts/entrypoint-dispatcher.inc'];
function run(name, override, args, expectedExit) {
  const stdout = [], stderr = [], frames = [];
  const guardedFs = {
    existsSync: (file) => { assert(file.startsWith(apiRoot + path.sep)); return fs.existsSync(file); },
    readFileSync: (file, encoding) => {
      assert(file.startsWith(apiRoot + path.sep));
      const relative = path.relative(apiRoot, file).split(path.sep).join('/');
      const body = fs.readFileSync(file, encoding);
      return override && entryPaths.includes(relative) ? override(relative, body) : body;
    },
  };
  const wrappedGuard = { ...guard, assertNoMigrationHistoryMutation: (snapshots) => {
    if (snapshots.some((snap) => entryPaths.includes(snap.path))) frames.push(snapshots.map((snap) => ({ path: snap.path, sha256: createHash('sha256').update(snap.source).digest('hex') })));
    return guard.assertNoMigrationHistoryMutation(snapshots);
  } };
  let exitCode = 0;
  try {
    vm.runInNewContext(transpile(source), {
      exports: {},
      require: (module) => {
        if (module === 'node:assert') return { strict: assert };
        if (module === 'node:fs') return guardedFs;
        if (module === 'node:path') return path;
        if (module === './lib/pe-production-scripts.js') return catalogs;
        if (module === './lib/pe-exact-sha-loader-contract.js') return exactShaCatalog;
        if (module === './lib/pe-migration-guards.js') return wrappedGuard;
        throw new Error('non-inert dependency refused: ' + module);
      },
      process: { argv: ['node', lintPath, ...args], cwd: () => apiRoot, exit: (code) => { throw new Exit(code); } },
      console: { log: (...parts) => stdout.push(parts.join(' ')), error: (...parts) => stderr.push(parts.join(' ')) },
    });
  } catch (error) { if (error instanceof Exit) exitCode = error.code; else throw error; }
  assert.equal(exitCode, expectedExit, name);
  return { name, args, exitCode, stdout, stderr, frames };
}
const results = [
  run('actual raw overlay succeeds', null, [], 0),
  run('CRLF source is normalized consistently', (_relative, body) => body.replace(/\n/g, '\r\n'), [], 0),
  run('pre-stripped snapshot bytes refuse', (_relative, body) => guard.stripShellComments(body), [], 1),
  run('comment-only unreviewed envelope refuses', (relative, body) => relative === entryPaths[0] ? body + '# changed\n' : body, [], 1),
  run('legacy extra history edit refuses', (relative, body) => relative === entryPaths[1] ? body + '\nUPDATE _prisma_migrations SET rolled_back_at = NOW()\n' : body, [], 1),
  run('help does not enter source scanner', null, ['--help'], 0),
  run('unknown arguments stay refused before scanning', null, ['--not-supported'], 2),
];
assert(results[0].stdout.includes('PE_LINT_SCRIPTS_OK'));
assert.equal(results[0].frames.length, 1);
assert(results.slice(2, 5).every((result) => !result.stdout.includes('PE_LINT_SCRIPTS_OK')));
assert.equal(results[5].frames.length, 0);
assert.equal(results[6].frames.length, 0);
const receipt = {
  authorSource: 'a96af2e1161def587d4ed9b6b79be7e5ff042c5b',
  rootOverlay: 'dced1ff282fffea55376f9cc8eef3e849a0ec782',
  lintSha256: createHash('sha256').update(source).digest('hex'),
  results, cases: results.length,
  catalogMode: 'actual source-owned string arrays extracted by TypeScript AST; no transitive helper execution',
  shellMutantsExecuted: false, nativeOperations: false, compositionTestsDuplicated: false,
};
fs.writeFileSync(new URL('lint-raw-operand-review.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length, passed: results.length, authorSource: receipt.authorSource, rootOverlay: receipt.rootOverlay, nativeOperations: false }, null, 2));
