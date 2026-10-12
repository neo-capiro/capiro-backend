import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { checkTimeSources } from '../../../scripts/check-strategy-time-bypasses.mjs';

// Parse/analyze only. Mutant strings are never emitted, imported, or executed.
const here = new URL('./', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, here), 'utf8'));
const data = JSON.parse(readFileSync('scripts/strategy-time-boundaries.json', 'utf8'));
const sources = new Map();
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.ts') && !/\.(?:spec|test|d)\.ts$/.test(file))
      sources.set(file, readFileSync(file, 'utf8'));
  }
}
for (const dir of data.sourceRoots) walk(dir);
for (const file of data.extraSourceFiles) sources.set(file, readFileSync(file, 'utf8'));
const baseline = checkTimeSources(sources, data);
assert.deepEqual(baseline, []);
const cases = load('independent-original-adversarial-guard-review.json').results;
cases.push({ name: 'hoisted imported RNG alias', addition: load('independent-original-hoisted-alias-adversarial-red.json').addition });
cases.push(...load('independent-original-canonical-member-adversarial-red.json').results);
const file = 'apps/api-strategy/src/meri/context-load.ts';
const results = cases.map(({ name, addition }) => {
  const mutant = new Map(sources);
  mutant.set(file, sources.get(file) + '\n' + addition + '\n');
  const failures = checkTimeSources(mutant, data);
  return { name, addition, rejected: failures.length > 0, failures };
});
const deferred = data.existingAmbient.filter((row) => row.status === 'existing-unconverted');
const receipt = {
  originalSource: 'f86bf11b9b6da367d464da453ee1f260fa60e06e',
  testedSource: process.argv[3] ?? 'f86bf11b9b6da367d464da453ee1f260fa60e06e',
  phase: process.argv[2], sourceFiles: sources.size, baseline,
  deferredIdentities: deferred.length,
  deferredSamples: deferred.reduce((n, row) => n + row.maximum, 0),
  cases: results.length, rejected: results.filter((row) => row.rejected).length,
  unexpectedlyAccepted: results.filter((row) => !row.rejected).map((row) => row.name),
  results, mutantsExecuted: false, nativeAcceptance: false,
};
writeFileSync(new URL(`reported-corpus-${receipt.phase}.json`, here), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ ...receipt, results: undefined }, null, 2));
assert.equal(receipt.rejected, receipt.phase === 'red' ? 2 : cases.length);
