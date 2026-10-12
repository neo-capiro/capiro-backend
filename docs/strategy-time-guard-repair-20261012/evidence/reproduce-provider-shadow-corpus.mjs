import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { checkTimeSources } from '../../../scripts/check-strategy-time-bypasses.mjs';

// Mutants remain source strings for the installed TypeScript AST guard only.
const here = new URL('./', import.meta.url);
const data = JSON.parse(readFileSync('scripts/strategy-time-boundaries.json', 'utf8'));
const original = JSON.parse(readFileSync(new URL('independent-original-provider-shadow-red.json', here), 'utf8'));
const sources = new Map();
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:[cm]?ts|tsx)$/.test(file) && !/\.(?:d|spec|test)\.(?:[cm]?ts|tsx)$/.test(file))
      sources.set(file, readFileSync(file, 'utf8'));
  }
}
for (const dir of data.sourceRoots) walk(dir);
for (const file of data.extraSourceFiles) sources.set(file, readFileSync(file, 'utf8'));
assert.deepEqual(checkTimeSources(sources, data), []);
const file = data.systemHookValueOwners[0].file;
const results = original.results.map(({ name, addition }) => {
  const mutant = new Map(sources);
  mutant.set(file, sources.get(file) + '\n' + addition);
  const failures = checkTimeSources(mutant, data);
  return { name, addition, rejected: failures.length > 0, failures };
});
const receipt = {
  testedSource: process.argv[3], phase: process.argv[2], sourceFiles: sources.size,
  results, rejected: results.filter((row) => row.rejected).length,
  mutantsExecuted: false, nativeAcceptance: false,
};
writeFileSync(new URL(`provider-corpus-${receipt.phase}.json`, here), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ ...receipt, results: undefined }, null, 2));
assert.equal(receipt.rejected, receipt.phase === 'red' ? 0 : 3);
