import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { analyzeTimeSource, checkTimeSources } from './check-strategy-time-bypasses.mjs';

const file = 'apps/api-strategy/src/meri/context-load.ts';
const valid = `
function withContextRetry(source: string, fn: () => unknown, runtime: unknown) { return fn(); }
class C { run() { return withContextRetry('x', () => 1, this.retryRuntime); } }
`;
function data(existingAmbient = []) {
  return {
    version: 1,
    requiredFiles: [file],
    retryDefinition: file,
    retryConsumers: [{ file, calls: 1, runtime: 'this.retryRuntime' }],
    existingAmbient,
    canonicalDefinitions: [{ file, name: 'withContextRetry' }],
  };
}
function check(source, policy = data()) {
  return checkTimeSources(new Map([[file, source]]), policy);
}

test('explicit runtime boundary permits deterministic date math, types, comments and strings', () => {
  assert.deepEqual(
    check(
      valid +
        `
    function dateMath(now: Date): Date { return new Date(now.getTime() + Math.floor(1.5)); }
    const label = 'Date.now() Math.random() setTimeout()'; // new Date()
  `,
    ),
    [],
  );
});

const mutations = [
  ['new date', 'new Date()'],
  ['date call', 'Date()'],
  ['clock', 'Date.now()'],
  ['random', 'Math.random()'],
  ['bracket clock', `Date['now']()`],
  ['bracket random', `Math['random']()`],
  ['global clock', 'globalThis.Date.now()'],
  ['global bracket clock', `globalThis['Date']['now']()`],
  ['global random', 'globalThis.Math.random()'],
  ['spread constructor', 'new Date(...[])'],
  ['date alias', 'const Clock = Date'],
  ['random alias', 'const random = Math.random'],
  ['clock destructuring', 'const { now } = Date'],
  ['math destructuring', 'const { random } = Math'],
  ['dynamic member', `const key = 'now'; Date[key]()`],
  ['timer', 'setTimeout(() => {}, 0)'],
  ['global timer', 'globalThis.setTimeout(() => {}, 0)'],
  ['timer alias', 'const delay = setTimeout'],
  ['system fallback call', 'systemWallClock()'],
  ['aliased system fallback', `import { systemRandom as rng } from '@capiro/shared'; rng()`],
  ['namespace system fallback', `import * as time from '@capiro/shared'; time.systemDelay(1)`],
  ['retry namespace bypass', `context.withContextRetry('x', () => 1)`],
  ['retry import alias', `import { withContextRetry as retry } from './context-load.js'`],
];
for (const [name, source] of mutations)
  test(`rejects new ambient or indirect boundary: ${name}`, () => {
    assert.notDeepEqual(check(`${valid}\n${source};`), []);
  });

test('existing sample allowance cannot grow or move to another owner', () => {
  const old = valid + 'function stamp() { return Date.now(); }';
  const key = analyzeTimeSource(file, old).events[0];
  const policy = data([{ key, maximum: 1, reason: 'existing mutation timestamp' }]);
  assert.deepEqual(check(old, policy), []);
  assert.notDeepEqual(
    check(valid + 'function stamp() { return Date.now() + Date.now(); }', policy),
    [],
  );
  assert.notDeepEqual(check(valid + 'function moved() { return Date.now(); }', policy), []);
});

test('required runtime cannot become optional, defaulted, omitted or replaced', () => {
  for (const source of [
    valid.replace('runtime: unknown', 'runtime?: unknown'),
    valid.replace('runtime: unknown', 'runtime: unknown = {}'),
    valid.replace(', this.retryRuntime', ''),
    valid.replace('this.retryRuntime', 'undefined'),
    valid.replace('this.retryRuntime', '{}'),
    valid.replace('this.retryRuntime', 'this.other'),
  ])
    assert.notDeepEqual(check(source), []);
});

test('missing source, parse failures and malformed inventory fail closed', () => {
  assert.notDeepEqual(checkTimeSources(new Map(), data()), []);
  assert.notDeepEqual(check(valid + 'const bad = ;'), []);
  assert.notDeepEqual(check(valid, { ...data(), requiredFiles: [] }), []);
  assert.notDeepEqual(check(valid, data([{ key: '*', maximum: 100, reason: 'wildcard' }])), []);
  assert.notDeepEqual(check(valid, data([{ key: 'x', maximum: -1, reason: 'negative' }])), []);
});

test('canonical helper ownership rejects function, variable and method copies', () => {
  for (const extra of [
    'function withContextRetry() {}',
    'function other() { const withContextRetry = () => 1; }',
    'class Other { withContextRetry() { return 1; } }',
  ])
    assert.notDeepEqual(check(valid + extra), []);
});

test('system defaults sample only on invocation and pass delay unchanged', async () => {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = readFileSync(new URL('../packages/shared/src/time.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const calls = [];
  const exports = {};
  vm.runInNewContext(js, {
    exports,
    Date: {
      now: () => {
        calls.push('clock');
        return 123;
      },
    },
    Math: {
      random: () => {
        calls.push('random');
        return 0.999;
      },
    },
    setTimeout: (resolve, milliseconds) => {
      calls.push(milliseconds);
      resolve();
    },
  });
  assert.deepEqual(calls, [], 'no import-time time/random/timer effects');
  assert.equal(exports.systemWallClock(), 123);
  assert.equal(exports.systemRandom(), 0.999);
  await exports.systemDelay(275);
  assert.deepEqual(calls, ['clock', 'random', 275]);
});
