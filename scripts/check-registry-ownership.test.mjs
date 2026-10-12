import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { declarationDigest, inspectRegistryOwnership, run } from './check-registry-ownership.mjs';

const owner = 'apps/example/src/registry.ts';
const consumer = 'apps/example/src/consumer.ts';
const ownerSource = 'export function canonicalRoute(input: string) { return input; }';
const consumerSource =
  "import { canonicalRoute as route } from './registry.js';\nexport function dispatch(input: string) { return route(input); }";
function fixture() {
  return {
    files: new Map([
      [owner, ownerSource],
      [consumer, consumerSource],
    ]),
    config: {
      version: 1,
      profiles: [
        {
          id: 'example',
          owner,
          roots: ['apps/example/src'],
          symbols: [{ name: 'canonicalRoute', kind: 'function' }],
          edges: [{ file: consumer, module: './registry.js', imported: 'canonicalRoute', uses: 1 }],
          carriers: [
            {
              file: consumer,
              name: 'dispatch',
              kind: 'function',
              sha256: declarationDigest(consumerSource, 'dispatch', 'function'),
            },
          ],
        },
      ],
    },
  };
}
function check(change) {
  const value = fixture();
  change?.(value);
  return inspectRegistryOwnership(value.files, value.config);
}

test('accepts the canonical declaration, alias-bound use and reviewed carrier', () => {
  assert.deepEqual(check(), { errors: [], profiles: 1, files: 2 });
});
test('does not evaluate imported application source', () => {
  assert.deepEqual(
    check(({ files }) => files.set(owner, `${ownerSource}\nthrow new Error('must not run');`))
      .errors,
    [],
  );
});
test('carrier digest ignores comments and whitespace and preserves literal meaning', () => {
  assert.equal(
    declarationDigest(
      'export function dispatch(input: string) { /* context */ return route(input); }',
      'dispatch',
      'function',
    ),
    declarationDigest(consumerSource, 'dispatch', 'function'),
  );
  assert.notEqual(
    declarationDigest(
      "export function dispatch(input: string) { return route('different'); }",
      'dispatch',
      'function',
    ),
    declarationDigest(consumerSource, 'dispatch', 'function'),
  );
});
for (const [label, change] of [
  ['missing owner', ({ files }) => files.delete(owner)],
  [
    'duplicate local declaration',
    ({ files }) => files.set('apps/example/src/copy.ts', ownerSource),
  ],
  [
    'nested local declaration',
    ({ files }) =>
      files.set(
        'apps/example/src/copy.ts',
        `function wrapper(){ ${ownerSource.replace('export ', '')} }`,
      ),
  ],
  [
    'class method with owned name',
    ({ files }) =>
      files.set(
        'apps/example/src/copy.ts',
        'class Copy { canonicalRoute(input:string){return input;} }',
      ),
  ],
  [
    'owner renamed',
    ({ files }) => files.set(owner, ownerSource.replaceAll('canonicalRoute', 'other')),
  ],
  [
    'wrong declaration kind',
    ({ files }) => files.set(owner, 'export const canonicalRoute = (input:string) => input;'),
  ],
  [
    'namespace import',
    ({ files }) =>
      files.set(
        consumer,
        consumerSource.replace('import { canonicalRoute as route }', 'import * as route'),
      ),
  ],
  [
    'type-only import',
    ({ files }) => files.set(consumer, consumerSource.replace('import {', 'import type {')),
  ],
  [
    'type-only imported member',
    ({ files }) =>
      files.set(consumer, consumerSource.replace('{ canonicalRoute', '{ type canonicalRoute')),
  ],
  [
    'wrong import module',
    ({ files }) => files.set(consumer, consumerSource.replace('./registry.js', './other.js')),
  ],
  ['missing consumer', ({ files }) => files.delete(consumer)],
  [
    'unused imported binding',
    ({ files }) =>
      files.set(consumer, consumerSource.replace('return route(input)', 'return input')),
  ],
  [
    'parameter shadow',
    ({ files }) =>
      files.set(
        consumer,
        consumerSource.replace(
          'dispatch(input: string)',
          'dispatch(input: string, route: (v:string)=>string)',
        ),
      ),
  ],
  [
    'extra call',
    ({ files }) =>
      files.set(
        consumer,
        consumerSource.replace('return route(input)', 'route(input); return route(input)'),
      ),
  ],
  [
    'carrier bypass',
    ({ files }) =>
      files.set(
        consumer,
        consumerSource.replace(
          'return route(input)',
          'if (false) return route(input); return input',
        ),
      ),
  ],
  [
    'changed argument order',
    ({ files }) =>
      files.set(consumer, consumerSource.replace('route(input)', "route('different')")),
  ],
  [
    'duplicate carrier',
    ({ files }) => files.set(consumer, `${consumerSource}\nfunction dispatch(){}`),
  ],
  ['syntax error', ({ files }) => files.set(owner, `${ownerSource}\nfunction broken(`)],
  ['empty profile list', ({ config }) => (config.profiles = [])],
  ['duplicate profile id', ({ config }) => config.profiles.push(config.profiles[0])],
  ['owner path traversal', ({ config }) => (config.profiles[0].owner = '../registry.ts')],
  ['root path traversal', ({ config }) => (config.profiles[0].roots = ['apps/../example/src'])],
  ['unscanned owner', ({ config }) => (config.profiles[0].roots = ['apps/other/src'])],
  ['nonpositive reference count', ({ config }) => (config.profiles[0].edges[0].uses = 0)],
  [
    'spoofed carrier fingerprint',
    ({ config }) => (config.profiles[0].carriers[0].sha256 = '0'.repeat(64)),
  ],
])
  test(`refuses ${label}`, () => assert.ok(check(change).errors.length > 0));

test('canonical module cannot be redirected in profile while keeping source import', () => {
  assert.ok(
    check(({ config }) => (config.profiles[0].edges[0].module = './other.js')).errors.length > 0,
  );
});
test('invalid sources fail as data', () => {
  assert.ok(
    check(({ files }) => files.set('../outside.ts', 'export const x=1;')).errors.length > 0,
  );
});
test('inert declaration aliases in unrelated scope do not satisfy a missing canonical use', () => {
  const result = check(({ files }) =>
    files.set(
      consumer,
      consumerSource.replace(
        'return route(input)',
        'function helper(route: (v:string)=>string) { return route(input); } return input',
      ),
    ),
  );
  assert.ok(result.errors.some((error) => error.includes('bound references')));
});

for (const [label, change] of [
  ['local owner function', ({ files }) => files.set(owner, ownerSource.replace('export ', ''))],
  [
    'nested owner function',
    ({ files }) =>
      files.set(owner, `export function wrapper(){ ${ownerSource.replace('export ', '')} }`),
  ],
  [
    'namespace owner function',
    ({ files }) => files.set(owner, `export namespace Box { ${ownerSource} }`),
  ],
  [
    'default-only owner function',
    ({ files }) =>
      files.set(owner, ownerSource.replace('export function', 'export default function')),
  ],
  [
    'object destructured owned binding',
    ({ files }) => files.set('apps/example/src/copy.ts', 'const {canonicalRoute} = value;'),
  ],
  [
    'renamed object destructured owned binding',
    ({ files }) => files.set('apps/example/src/copy.ts', 'const {other: canonicalRoute} = value;'),
  ],
  [
    'array destructured owned binding',
    ({ files }) => files.set('apps/example/src/copy.ts', 'const [canonicalRoute] = value;'),
  ],
  [
    'parameter using reserved owned name',
    ({ files }) =>
      files.set('apps/example/src/copy.ts', 'function wrapper(canonicalRoute:unknown) {}'),
  ],
  [
    'destructured parameter using reserved owned name',
    ({ files }) =>
      files.set(
        'apps/example/src/copy.ts',
        'function wrapper({canonicalRoute}:{canonicalRoute:unknown}) {}',
      ),
  ],
  [
    'named function expression copy',
    ({ files }) =>
      files.set(
        'apps/example/src/copy.ts',
        'const copy = function canonicalRoute(input:string){return input;};',
      ),
  ],
  [
    'object method copy',
    ({ files }) =>
      files.set(
        'apps/example/src/copy.ts',
        'const copy={canonicalRoute(input:string){return input;}};',
      ),
  ],
  [
    'quoted object method copy',
    ({ files }) =>
      files.set(
        'apps/example/src/copy.ts',
        'const copy={"canonicalRoute"(input:string){return input;}};',
      ),
  ],
  [
    'static computed object method copy',
    ({ files }) =>
      files.set(
        'apps/example/src/copy.ts',
        'const copy={["canonicalRoute"](input:string){return input;}};',
      ),
  ],
  [
    'object property copy',
    ({ files }) =>
      files.set('apps/example/src/copy.ts', 'const copy={canonicalRoute:(input:string)=>input};'),
  ],
  [
    'phantom imported export',
    ({ files, config }) => {
      files.set(consumer, consumerSource.replace('canonicalRoute as route', 'absent as route'));
      config.profiles[0].edges[0].imported = 'absent';
    },
  ],
  [
    'out-of-scope consumer edge',
    ({ files, config }) => {
      const file = 'outside/consumer.ts';
      files.set(file, consumerSource.replace('./registry.js', '../apps/example/src/registry.js'));
      config.profiles[0].edges[0] = {
        file,
        module: '../apps/example/src/registry.js',
        imported: 'canonicalRoute',
        uses: 1,
      };
    },
  ],
  [
    'out-of-scope carrier',
    ({ files, config }) => {
      const file = 'outside/carrier.ts';
      files.set(file, consumerSource);
      config.profiles[0].carriers[0].file = file;
    },
  ],
  [
    'duplicate owned symbol entry',
    ({ config }) => config.profiles[0].symbols.push({ ...config.profiles[0].symbols[0] }),
  ],
  [
    'duplicate consumer edge entry',
    ({ config }) => config.profiles[0].edges.push({ ...config.profiles[0].edges[0] }),
  ],
  [
    'duplicate carrier entry',
    ({ config }) => config.profiles[0].carriers.push({ ...config.profiles[0].carriers[0] }),
  ],
  [
    'unlisted owner import',
    ({ files }) =>
      files.set(
        'apps/example/src/extra.ts',
        "import {canonicalRoute} from './registry.js'; canonicalRoute('extra');",
      ),
  ],
  [
    'unlisted alternate owner import path',
    ({ files }) =>
      files.set(
        'apps/example/src/extra.ts',
        "import {canonicalRoute} from './nested/../registry.js'; canonicalRoute('extra');",
      ),
  ],
  [
    'owned symbol imported from an unknown barrel',
    ({ files }) =>
      files.set(
        'apps/example/src/extra.ts',
        "import {canonicalRoute as other} from './barrel.js'; other('extra');",
      ),
  ],
  [
    'extensionless unlisted owner import',
    ({ files }) =>
      files.set(
        'apps/example/src/extra.ts',
        "import {canonicalRoute as other} from './registry'; other('extra');",
      ),
  ],
  [
    'import-equals owner reference',
    ({ files }) =>
      files.set('apps/example/src/extra.cts', "import other = require('./registry.js');"),
  ],
  [
    'named owner re-export',
    ({ files }) =>
      files.set('apps/example/src/extra.ts', "export {canonicalRoute} from './registry.js';"),
  ],
  [
    'star owner re-export',
    ({ files }) => files.set('apps/example/src/extra.ts', "export * from './registry.js';"),
  ],
  [
    'default owner import',
    ({ files }) => files.set('apps/example/src/extra.ts', "import other from './registry.js';"),
  ],
  [
    'static dynamic owner import',
    ({ files }) => files.set('apps/example/src/extra.ts', "const other = import('./registry.js');"),
  ],
  [
    'static require of owner',
    ({ files }) =>
      files.set('apps/example/src/extra.cts', "const other = require('./registry.js');"),
  ],
  [
    'type reference spoofing runtime consumption',
    ({ files, config }) => {
      const text =
        consumerSource.replace('return route(input)', 'return input') +
        '\ntype Unused = typeof route;';
      files.set(consumer, text);
      config.profiles[0].carriers[0].sha256 = declarationDigest(text, 'dispatch', 'function');
    },
  ],
])
  test(`refuses ${label} after independent rejection`, () =>
    assert.ok(check(change).errors.length > 0));

test('variable carrier fingerprints include export visibility and const/let mutability', () => {
  const before = 'export const vocabulary = ["one"] as const;';
  for (const after of [
    'const vocabulary = ["one"] as const;',
    'export let vocabulary = ["one"] as const;',
    'export const vocabulary = ["two"] as const;',
  ])
    assert.notEqual(
      declarationDigest(before, 'vocabulary', 'variable'),
      declarationDigest(after, 'vocabulary', 'variable'),
    );
  assert.equal(
    declarationDigest(before, 'vocabulary', 'variable'),
    declarationDigest(
      'export const vocabulary= /* context */ ["one"] as const;',
      'vocabulary',
      'variable',
    ),
  );
});

function onDisk(change, inspect) {
  const root = mkdtempSync(path.join(tmpdir(), 'capiro-registry-source-'));
  try {
    const value = fixture();
    change?.(value);
    for (const [file, source] of value.files) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    }
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts/registry-ownership.json'), JSON.stringify(value.config));
    return inspect(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('reads a complete synthetic source root without loading it', () => {
  assert.deepEqual(
    onDisk(undefined, (root) => run(root)),
    { errors: [], profiles: 1, files: 2 },
  );
});
for (const extension of ['ts', 'cts', 'mts', 'tsx'])
  test(`scans owned declaration copies in .${extension}`, () => {
    const result = onDisk(
      ({ files }) => files.set(`apps/example/src/copy.${extension}`, ownerSource),
      (root) => run(root),
    );
    assert.ok(result.errors.length > 0);
  });
test('does not follow source-file symlinks into an owner', () => {
  onDisk(undefined, (root) => {
    const file = path.join(root, owner);
    const target = path.join(root, 'outside.ts');
    writeFileSync(target, ownerSource);
    rmSync(file);
    symlinkSync(target, file);
    assert.ok(run(root).errors.some((error) => error.includes('missing owner')));
  });
});
test('refuses a symlink in the configured source root', () => {
  onDisk(undefined, (root) => {
    const target = path.join(root, 'linked');
    mkdirSync(target);
    rmSync(path.join(root, 'apps/example/src'), { recursive: true });
    symlinkSync(target, path.join(root, 'apps/example/src'));
    assert.throws(() => run(root), /real directories/);
  });
});
