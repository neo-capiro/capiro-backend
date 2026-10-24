const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const test = require('node:test');

const apiRoot = path.resolve(__dirname, '../..');
const api = createRequire(path.join(apiRoot, 'package.json'));
const ts = api('typescript');
const compare = 'compare-defense-budget-canonical-reads-v1.ts';
const qualification = 'qualify-defense-budget-drain-image-v1.ts';

// Execute the actual subprocess-owning function without booting Nest or a database.
function loadFunction(file, name, spawn) {
  const filename = path.join(apiRoot, 'scripts', file);
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(declaration, `${file}:${name}`);
  const compiled = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({
    require: api, path, SCRIPT_PATH: filename, spawnSync: spawn,
    process: { execPath: process.execPath, platform: 'linux', env: { PATH: '', SYNTHETIC_CONTEXT: 'preserved' } },
    console: { error() {} }, setTimeout: callback => callback(),
    MigrationError: class MigrationError extends Error {},
  });
  vm.runInContext(compiled, context, { timeout: 1000 });
  return context[name];
}

test('mounted comparison dispatches both read modes directly through installed tsx', () => {
  const calls = [];
  const result = { peCode: 'synthetic', budgetPositions: [], pbComparison: {}, budgetPositionsMs: 1, pbComparisonMs: 2 };
  const probe = loadFunction(compare, 'probe', (command, args, options) => {
    calls.push({ command, args: Array.from(args), options });
    return { status: 0, stdout: JSON.stringify(result), stderr: '' };
  });
  for (const mode of ['legacy', 'snapshot']) {
    assert.equal(JSON.stringify(probe('synthetic', 2026, mode)), JSON.stringify(result));
  }
  for (const [index, call] of calls.entries()) {
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args, [api.resolve('tsx/cli'), path.join(apiRoot, 'scripts', compare), '--__probe', '--pe-code', 'synthetic', '--fy', '2026']);
    assert.equal(call.options.cwd, apiRoot);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.PATH, '');
    assert.equal(call.options.env.SYNTHETIC_CONTEXT, 'preserved');
    assert.equal(call.options.env.PE_SNAPSHOT_READ_MODE, ['legacy', 'snapshot'][index]);
  }
});

test('comparison retains failed/invalid child output refusal and optional fiscal year', () => {
  const outcomes = [{ status: 1, stdout: '', stderr: 'synthetic failure' }, { status: 0, stdout: 'invalid JSON' }];
  const probe = loadFunction(compare, 'probe', (_command, args) => {
    assert.equal(args.includes('--fy'), false);
    return outcomes.shift();
  });
  assert.match(probe('synthetic', undefined, 'legacy').error, /produced no output.*synthetic failure/);
  assert.match(probe('synthetic', undefined, 'snapshot').error, /did not return JSON/);
});

test('mounted migration dispatch uses installed Prisma, preserves retries and succeeds once', async () => {
  const calls = [];
  const migrate = loadFunction(qualification, 'runPrismaMigrateDeploy', (command, args, options) => {
    calls.push({ command, args: Array.from(args), options });
    return { status: calls.length === 1 ? 1 : 0 };
  });
  await migrate(apiRoot, 3, 0);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args, [api.resolve('prisma/build/index.js'), 'migrate', 'deploy']);
    assert.equal(call.options.cwd, apiRoot);
    assert.equal(call.options.stdio, 'inherit');
    assert.equal(call.options.env.SYNTHETIC_CONTEXT, 'preserved');
    assert.equal(call.options.shell, undefined);
  }
});

test('migration still fails closed after bounded child failures', async () => {
  let attempts = 0;
  const migrate = loadFunction(qualification, 'runPrismaMigrateDeploy', () => {
    attempts++;
    return { status: null, signal: null, error: Object.assign(new Error('synthetic missing executable'), { code: 'ENOENT' }) };
  });
  await assert.rejects(migrate(apiRoot, 3, 0), /exited null.*after 3 attempts/);
  assert.equal(attempts, 3);
});

for (const [name, entrypoint, marker] of [
  ['tsx', 'tsx/cli', /tsx/],
  ['Prisma', 'prisma/build/index.js', /prisma/i],
]) {
  test(`installed ${name} CLI loads without PATH/npm/npx or database configuration`, () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE)$/i.test(key)));
    const result = spawnSync(process.execPath, [api.resolve(entrypoint), '--help'], {
      cwd: apiRoot, env: { ...env, PATH: '', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8', timeout: 15000, shell: false,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, marker);
  });
}
