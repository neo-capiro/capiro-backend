import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  analyzeTimeSource,
  checkTimeSources,
  sourceFiles,
} from './check-strategy-time-bypasses.mjs';

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
    systemHookValueOwners: [],
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

// These strings are parsed/analyzed only, never emitted or executed. Retain the
// exact independent-review controls, including the late (hoisted) import.
const reportedBypasses = [
  [
    'global alias clock',
    'function reviewProbe(){const ambient=globalThis;return ambient.Date.now();}',
  ],
  ['computed global clock', "function reviewProbe(){return globalThis['Da'+'te']['now']();}"],
  [
    'global alias random',
    'function reviewProbe(){const ambient=globalThis;return ambient.Math.random();}',
  ],
  ['computed global random', "function reviewProbe(){return globalThis['Ma'+'th']['random']();}"],
  [
    'global alias constructor',
    'function reviewProbe(){const ambient=globalThis;return new ambient.Date();}',
  ],
  ['computed global constructor', "function reviewProbe(){return new (globalThis['Da'+'te'])();}"],
  [
    'global alias timer',
    'function reviewProbe(){const ambient=globalThis;return ambient.setTimeout(()=>{},1);}',
  ],
  [
    'computed global timer',
    "function reviewProbe(){return globalThis['set'+'Timeout'](()=>{},1);}",
  ],
  [
    'system local alias',
    "import { systemWallClock } from '@capiro/shared';function reviewProbe(){const clock=systemWallClock;return clock();}",
  ],
  [
    'system namespace destructure',
    "import * as sharedTime from '@capiro/shared';function reviewProbe(){const {systemWallClock:clock}=sharedTime;return clock();}",
  ],
  [
    'retry local alias',
    'function reviewProbe(){const retry:any=withContextRetry;return retry("x",()=>1);}',
  ],
  ['quoted canonical method', 'class ReviewProbe { "withContextRetry"() {return 1;} }'],
  ['computed canonical method', 'class ReviewProbe { ["withContextRetry"]() {return 1;} }'],
  [
    'timer module namespace',
    "import * as timers from 'node:timers';function reviewProbe(){return timers.setTimeout(()=>{},1);}",
  ],
  [
    'hoisted imported RNG alias',
    "function reviewHoistedAlias() { return rng(); }\nimport { systemRandom as rng } from '@capiro/shared';",
  ],
  ['object canonical function', 'const reviewDup = { withContextRetry: () => 1 };'],
  ['computed canonical property', 'const reviewDup = { ["withContextRetry"]: () => 1 };'],
  ['class canonical property', 'class ReviewDup { withContextRetry = () => 1; }'],
  ['canonical getter', 'class ReviewDup { get withContextRetry() { return () => 1; } }'],
];
for (const [name, source] of reportedBypasses)
  test(`refuses reported AST bypass: ${name}`, () => {
    assert.notDeepEqual(check(valid + '\n' + source), []);
  });

const aliasVariants = [
  [
    'class global alias',
    'class Probe { ambient=globalThis; run(){return this.ambient.Date.now();} }',
  ],
  ['global object rest alias', 'const {...ambient}=globalThis; ambient.Math.random();'],
  [
    'computed destructuring alias',
    'const key="Da"+"te"; const {[key]:{now:clock}}=globalThis; clock();',
  ],
  ['nested global destructuring', 'const {Date:{now:clock}}=globalThis; clock();'],
  ['chained global alias', 'const root=globalThis; const ambient=root; ambient.Math.random();'],
  ['assigned global alias', 'let ambient; ambient=globalThis; ambient.Date.now();'],
  [
    'constant member alias',
    "const root=globalThis; const first='Da'; const name=first+'te'; root[name].now();",
  ],
  ['template member alias', "const part='Date'; globalThis[`${part}`]['now']();"],
  ['unknown global member', 'function probe(key:string) { globalThis[key](); }'],
  ['unknown math member', 'function probe(key:string) { Math[key](); }'],
  [
    'system array destructuring',
    "import {systemRandom} from '@capiro/shared'; const [rng]=[systemRandom]; rng();",
  ],
  [
    'namespace object alias',
    "import * as shared from '@capiro/shared'; const holder={time:shared}; const {time:{systemRandom:rng}}=holder; rng();",
  ],
  [
    'system bound alias',
    "import {systemRandom} from '@capiro/shared'; const rng=systemRandom.bind(null); rng();",
  ],
  [
    'system parameter default',
    "import {systemWallClock} from '@capiro/shared'; function fallback(clock=systemWallClock) {}",
  ],
  [
    'system callback reference',
    "import {systemRandom} from '@capiro/shared'; accept(systemRandom);",
  ],
  [
    'system renamed forwarding export',
    "import {systemRandom} from '@capiro/shared'; export {systemRandom as fallback};",
  ],
  ['system forwarding export', "export {systemWallClock} from '@capiro/shared';"],
  [
    'timer namespace destructuring',
    "import * as timers from 'node:timers'; const {setTimeout:delay}=timers; delay(()=>{},1);",
  ],
  ['timer named import alias', "import {setTimeout as delay} from 'timers'; delay(()=>{},1);"],
  [
    'timer promise namespace',
    "import * as timers from 'node:timers/promises'; timers.setTimeout(1);",
  ],
  [
    'retry destructuring alias',
    'const {withContextRetry:retry}=context; retry("x",()=>1,this.retryRuntime);',
  ],
  [
    'retry alias even with valid runtime',
    'const retry=withContextRetry; retry("x",()=>1,this.retryRuntime);',
  ],
  ['retry callback reference', 'accept(withContextRetry);'],
  [
    'constant canonical method name',
    'const key="with"+"ContextRetry"; class Duplicate { [key]() {} }',
  ],
  ['computed class arrow property', 'class Duplicate { ["with"+"ContextRetry"] = () => 1; }'],
  ['canonical setter', 'class Duplicate { set withContextRetry(value:unknown) {} }'],
  ['canonical object method', 'const duplicate = { ["withContextRetry"]() {} };'],
  ['Date constructor alias with explicit argument', 'const Clock=Date; new Clock("2026-10-12");'],
  ['global Date constructor alias', 'const Clock=globalThis.Date; new Clock();'],
  ['property Date constructor alias', 'const clocks={Clock:Date}; new clocks.Clock();'],
];
for (const [name, source] of aliasVariants)
  test(`refuses bounded static alias variant: ${name}`, () => {
    assert.notDeepEqual(check(valid + '\n' + source), []);
  });

test('lexical shadows, explicit dates, ordinary object members and type-only references stay permitted', () => {
  const source =
    valid +
    `
    import type { systemRandom as rng } from '@capiro/shared';
    type ClockType = typeof Date;
    interface Labels { withContextRetry(): unknown; }
    const label = 'withContextRetry'; // globalThis['Da'+'te'].now()
    const labels = { withContextRetry: 'a label', systemRandom: 'a label' };
    function shadow(Date: {now():number}, Math: {random():number}, globalThis: {Date:{now():number}}, setTimeout:()=>void, rng:()=>number) {
      Date.now(); Math.random(); globalThis.Date.now(); setTimeout(); rng();
    }
    const local={Clock:()=>1}; local.Clock();
    new Date('2026-10-12'); new Date(0); new globalThis.Date(0);
    new (globalThis['Da'+'te'])('2026-10-12'); Math.floor(1.5);
  `;
  assert.deepEqual(check(source), []);
});

test('a hoisted imported alias does not taint a different lexical parameter binding', () => {
  const source = `
    function shadow(rng:()=>number) { return rng(); }
    import {systemRandom as rng} from '@capiro/shared';
  `;
  assert.deepEqual(analyzeTimeSource(file, source).events, []);
  assert.equal(
    analyzeTimeSource(file, source + '\nfunction unshadowed(){return rng();}').events.length,
    1,
  );
});

test('global aliases respect nested lexical shadows and ordinary object field names', () => {
  assert.deepEqual(
    check(
      valid +
        `
    const ambient=globalThis;
    function shadow(ambient:{Date:{now():number}}) { return ambient.Date.now(); }
    class Ordinary { ambient={Date:{now:()=>123}}; run(){return this.ambient.Date.now();} }
    { const ambient={Math:{random:()=>123}}; ambient.Math.random(); }
  `,
    ),
    [],
  );
});

test('only data-owned lazy provider values are permitted, never invocation or callback fallbacks', () => {
  const provider = 'apps/api-strategy/src/meri/strategy-time.providers.ts';
  const owner = {
    file: provider,
    binding: 'STRATEGY_TIME_PROVIDERS',
    reason: 'canonical lazy Nest registration',
  };
  const policy = { ...data(), requiredFiles: [file, provider], systemHookValueOwners: [owner] };
  const source = `import {systemWallClock,systemRandom,systemDelay} from '@capiro/shared';
    export const STRATEGY_TIME_PROVIDERS=[{useValue:systemWallClock},{useValue:Object.freeze({random:systemRandom,delay:systemDelay})}];`;
  const checkProvider = (addition, override = policy) =>
    checkTimeSources(
      new Map([
        [file, valid],
        [provider, source + addition],
      ]),
      override,
    );
  assert.deepEqual(checkProvider(''), []);
  assert.notDeepEqual(checkProvider('\nconst fallback=systemWallClock;'), []);
  assert.notDeepEqual(checkProvider('\nsystemRandom();'), []);
  assert.notDeepEqual(checkProvider('\nexport {systemDelay as fallback};'), []);
  assert.notDeepEqual(checkProvider('', { ...policy, systemHookValueOwners: [] }), []);
  assert.notDeepEqual(
    checkProvider('', { ...policy, systemHookValueOwners: [{ ...owner, binding: 'other' }] }),
    [],
  );
  assert.notDeepEqual(
    checkProvider('', {
      ...policy,
      systemHookValueOwners: [{ ...owner, binding: '*', reason: '' }],
    }),
    [],
  );
  assert.notDeepEqual(checkProvider('\nfunction deferred(clock=systemWallClock){}'), []);
});

test('source discovery includes supported runtime TypeScript extensions and excludes declarations and tests', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'strategy-time-extensions-'));
  try {
    mkdirSync(path.join(fixture, 'src'));
    const runtime = ['main.ts', 'hidden.cts', 'hidden.mts', 'component.tsx'];
    const excluded = [
      'types.d.ts',
      'types.d.cts',
      'types.d.mts',
      'unit.spec.ts',
      'unit.test.cts',
      'unit.spec.mts',
      'unit.test.tsx',
    ];
    for (const name of [...runtime, ...excluded])
      writeFileSync(
        path.join(fixture, 'src', name),
        name.endsWith('.tsx')
          ? 'export const view = <span>{Date.now()}</span>;'
          : 'export const clock = () => Date.now();',
      );
    const sources = sourceFiles(fixture, ['src']);
    assert.deepEqual([...sources.keys()].sort(), runtime.map((name) => 'src/' + name).sort());
    for (const [name, source] of sources) {
      const result = analyzeTimeSource(name, source);
      assert.deepEqual(result.problems, []);
      assert.equal(
        result.events.length,
        1,
        name + ' runtime clock cannot hide from source discovery',
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('TSX parsing permits benign markup but finds protected calls inside expressions', () => {
  assert.deepEqual(
    analyzeTimeSource('src/view.tsx', 'const view=<span title="Date.now()">label</span>;').events,
    [],
  );
  const result = analyzeTimeSource(
    'src/view.tsx',
    'const view=<span>{globalThis["Da"+"te"].now()}</span>;',
  );
  assert.deepEqual(result.problems, []);
  assert.equal(result.events.length, 1);
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
