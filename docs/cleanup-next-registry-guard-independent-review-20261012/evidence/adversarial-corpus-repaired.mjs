// Pure guard execution on inert source strings; no application import/evaluation.
import fs from 'node:fs';
import { declarationDigest, inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
const owner = 'apps/example/src/registry.ts';
const consumer = 'apps/example/src/consumer.ts';
const ownerSource = 'export function canonicalRoute(input: string) { return input; }';
const consumerSource = "import { canonicalRoute as route } from './registry.js';\nexport function dispatch(input: string) { return route(input); }";
function fixture() {
  return { files: new Map([[owner, ownerSource], [consumer, consumerSource]]), config: { version: 1, profiles: [{ id: 'example', owner, roots: ['apps/example/src'], symbols: [{ name: 'canonicalRoute', kind: 'function' }], edges: [{ file: consumer, module: './registry.js', imported: 'canonicalRoute', uses: 1 }], carriers: [{ file: consumer, name: 'dispatch', kind: 'function', sha256: declarationDigest(consumerSource, 'dispatch', 'function') }] }] } };
}
const results = [];
function probe(name, mutate, expectedRefuse = true) {
  const value = fixture(); mutate?.(value);
  let output;
  try { output = inspectRegistryOwnership(value.files, value.config); }
  catch (error) { output = { errors: [`THREW:${error.message}`], threw: true }; }
  const refused = output.errors.length > 0;
  results.push({ name, expectedRefuse, refused, pass: refused === expectedRefuse && !output.threw, output });
}
probe('canonical baseline', undefined, false);
probe('non-exported owner function', ({ files }) => files.set(owner, ownerSource.replace('export ', '')));
probe('nested owner function not available as module export', ({ files }) => files.set(owner, 'export function wrapper(){ function canonicalRoute(input:string){return input;} return canonicalRoute; }'));
probe('namespace owner function not available as module export', ({ files }) => files.set(owner, 'export namespace Box { export function canonicalRoute(input:string){return input;} }'));
probe('default-only export cannot satisfy named import', ({ files }) => files.set(owner, ownerSource.replace('export function', 'export default function')));
probe('duplicate object destructuring binding outside owner', ({ files }) => files.set('apps/example/src/copy.ts', 'const { canonicalRoute } = someRegistry;'));
probe('duplicate renamed object destructuring binding outside owner', ({ files }) => files.set('apps/example/src/copy.ts', 'const { other: canonicalRoute } = someRegistry;'));
probe('duplicate array destructuring binding outside owner', ({ files }) => files.set('apps/example/src/copy.ts', 'const [canonicalRoute] = someRegistry;'));
probe('duplicate parameter binding outside owner', ({ files }) => files.set('apps/example/src/copy.ts', 'function duplicate(canonicalRoute: unknown) { return canonicalRoute; }'));
probe('duplicate destructured parameter binding outside owner', ({ files }) => files.set('apps/example/src/copy.ts', 'function duplicate({ canonicalRoute }: { canonicalRoute:unknown }) { return canonicalRoute; }'));
probe('imported module symbol absent from owner', ({ files, config }) => { files.set(consumer, consumerSource.replace('canonicalRoute as route', 'absentExport as route')); config.profiles[0].edges[0].imported = 'absentExport'; });
probe('consumer edge outside declared scan roots', ({ files, config }) => { const outside = 'unscanned/consumer.ts'; files.set(outside, consumerSource.replace('./registry.js', '../apps/example/src/registry.js')); config.profiles[0].edges[0].file = outside; config.profiles[0].edges[0].module = '../apps/example/src/registry.js'; config.profiles[0].carriers[0].file = outside; });
probe('carrier declaration outside declared scan roots', ({ files, config }) => { const outside = 'unscanned/carrier.ts'; files.set(outside, 'export function dispatch(input: string){return route(input);}'); config.profiles[0].carriers[0] = { file: outside, name: 'dispatch', kind: 'function', sha256: declarationDigest(files.get(outside), 'dispatch', 'function') }; });
probe('duplicate owned symbol entry', ({ config }) => config.profiles[0].symbols.push({ ...config.profiles[0].symbols[0] }));
probe('duplicate consumer edge entry', ({ config }) => config.profiles[0].edges.push({ ...config.profiles[0].edges[0] }));
probe('duplicate carrier entry', ({ config }) => config.profiles[0].carriers.push({ ...config.profiles[0].carriers[0] }));
probe('genuine top-level owner duplicate refused', ({ files }) => files.set('apps/example/src/copy.ts', ownerSource));
probe('namespace import refused', ({ files }) => files.set(consumer, consumerSource.replace('import { canonicalRoute as route }', 'import * as route')));
probe('parameter shadows import refused', ({ files }) => files.set(consumer, consumerSource.replace('dispatch(input: string)', 'dispatch(input: string, route: (x:string)=>string)')));
probe('inert source string containing throw remains unevaluated', ({ files }) => files.set(owner, ownerSource + '\nthrow new Error("INERT_SOURCE_DO_NOT_RUN");'), false);
const comparisons = [
  ['variable const-to-let mutability drift', 'export const vocabulary = ["one"] as const;', 'export let vocabulary = ["one"] as const;', 'vocabulary', 'variable', false],
  ['variable exported-to-local visibility drift', 'export const vocabulary = ["one"] as const;', 'const vocabulary = ["one"] as const;', 'vocabulary', 'variable', false],
  ['literal change remains fingerprint-sensitive', 'export const vocabulary = ["one"] as const;', 'export const vocabulary = ["two"] as const;', 'vocabulary', 'variable', false],
  ['comment and whitespace intentionally ignored', 'export function same(x:string){return x;}', 'export function same( x: string ){ /* inert */ return x; }', 'same', 'function', true],
];
for (const [name, before, after, symbol, kind, expectedEqual] of comparisons) {
  const actualEqual = declarationDigest(before, symbol, kind) === declarationDigest(after, symbol, kind);
  results.push({ name, expectedEqual, actualEqual, pass: actualEqual === expectedEqual });
}
const summary = { frozenHead: '721bfd4825bfccd819be50172ed712023891f978', frozenTree: 'befb2cd1b4c5ba09223b4d327506706d7c007cdd', checks: results.length, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results, actualCanonicalProfilesChecked: false, sourceStringsEvaluated: false, applicationModulesImported: 0, nativeAcceptance: false, acceptance: false };
fs.writeFileSync(new URL('adversarial-corpus-repaired.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ checks: summary.checks, passed: summary.passed, failed: summary.failed, reds: results.filter((r) => !r.pass).map((r) => r.name) }));
if (summary.failed) process.exitCode = 1;
