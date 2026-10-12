import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declarationDigest, inspectRegistryOwnership } from './check-registry-ownership.mjs';

const owner = 'apps/example/src/registry.ts';
const consumer = 'apps/example/src/consumer.ts';
const ownerSource = 'export function canonicalRoute(input: string) { return input; }';
const consumerSource = "import { canonicalRoute as route } from './registry.js';\nexport function dispatch(input: string) { return route(input); }";
function fixture() {
  return {
    files: new Map([[owner, ownerSource], [consumer, consumerSource]]),
    config: { version: 1, profiles: [{
      id: 'example', owner, roots: ['apps/example/src'],
      symbols: [{ name: 'canonicalRoute', kind: 'function' }],
      edges: [{ file: consumer, module: './registry.js', imported: 'canonicalRoute', uses: 1 }],
      carriers: [{ file: consumer, name: 'dispatch', kind: 'function', sha256: declarationDigest(consumerSource, 'dispatch', 'function') }],
    }] },
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
  assert.deepEqual(check(({ files }) => files.set(owner, `${ownerSource}\nthrow new Error('must not run');`)).errors, []);
});
test('carrier digest ignores comments and whitespace and preserves literal meaning', () => {
  assert.equal(declarationDigest('export function dispatch(input: string) { /* context */ return route(input); }', 'dispatch', 'function'), declarationDigest(consumerSource, 'dispatch', 'function'));
  assert.notEqual(declarationDigest("export function dispatch(input: string) { return route('different'); }", 'dispatch', 'function'), declarationDigest(consumerSource, 'dispatch', 'function'));
});
for (const [label, change] of [
  ['missing owner', ({ files }) => files.delete(owner)],
  ['duplicate local declaration', ({ files }) => files.set('apps/example/src/copy.ts', ownerSource)],
  ['nested local declaration', ({ files }) => files.set('apps/example/src/copy.ts', `function wrapper(){ ${ownerSource.replace('export ', '')} }`)],
  ['class method with owned name', ({ files }) => files.set('apps/example/src/copy.ts', 'class Copy { canonicalRoute(input:string){return input;} }')],
  ['owner renamed', ({ files }) => files.set(owner, ownerSource.replaceAll('canonicalRoute', 'other'))],
  ['wrong declaration kind', ({ files }) => files.set(owner, 'export const canonicalRoute = (input:string) => input;')],
  ['namespace import', ({ files }) => files.set(consumer, consumerSource.replace('import { canonicalRoute as route }', 'import * as route'))],
  ['type-only import', ({ files }) => files.set(consumer, consumerSource.replace('import {', 'import type {'))],
  ['type-only imported member', ({ files }) => files.set(consumer, consumerSource.replace('{ canonicalRoute', '{ type canonicalRoute'))],
  ['wrong import module', ({ files }) => files.set(consumer, consumerSource.replace('./registry.js', './other.js'))],
  ['missing consumer', ({ files }) => files.delete(consumer)],
  ['unused imported binding', ({ files }) => files.set(consumer, consumerSource.replace('return route(input)', 'return input'))],
  ['parameter shadow', ({ files }) => files.set(consumer, consumerSource.replace('dispatch(input: string)', 'dispatch(input: string, route: (v:string)=>string)'))],
  ['extra call', ({ files }) => files.set(consumer, consumerSource.replace('return route(input)', 'route(input); return route(input)'))],
  ['carrier bypass', ({ files }) => files.set(consumer, consumerSource.replace('return route(input)', 'if (false) return route(input); return input'))],
  ['changed argument order', ({ files }) => files.set(consumer, consumerSource.replace('route(input)', "route('different')"))],
  ['duplicate carrier', ({ files }) => files.set(consumer, `${consumerSource}\nfunction dispatch(){}`)],
  ['syntax error', ({ files }) => files.set(owner, `${ownerSource}\nfunction broken(`)],
  ['empty profile list', ({ config }) => config.profiles = []],
  ['duplicate profile id', ({ config }) => config.profiles.push(config.profiles[0])],
  ['owner path traversal', ({ config }) => config.profiles[0].owner = '../registry.ts'],
  ['root path traversal', ({ config }) => config.profiles[0].roots = ['apps/../example/src']],
  ['unscanned owner', ({ config }) => config.profiles[0].roots = ['apps/other/src']],
  ['nonpositive reference count', ({ config }) => config.profiles[0].edges[0].uses = 0],
  ['spoofed carrier fingerprint', ({ config }) => config.profiles[0].carriers[0].sha256 = '0'.repeat(64)],
]) test(`refuses ${label}`, () => assert.ok(check(change).errors.length > 0));

test('canonical module cannot be redirected in profile while keeping source import', () => {
  assert.ok(check(({ config }) => config.profiles[0].edges[0].module = './other.js').errors.length > 0);
});
test('invalid sources fail as data', () => {
  assert.ok(check(({ files }) => files.set('../outside.ts', 'export const x=1;')).errors.length > 0);
});
test('inert declaration aliases in unrelated scope do not satisfy a missing canonical use', () => {
  const result = check(({ files }) => files.set(consumer, consumerSource.replace('return route(input)', 'function helper(route: (v:string)=>string) { return route(input); } return input')));
  assert.ok(result.errors.some((error) => error.includes('bound references')));
});
