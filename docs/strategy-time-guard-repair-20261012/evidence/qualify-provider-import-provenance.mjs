import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { analyzeTimeSource, checkTimeSources } from '../../../scripts/check-strategy-time-bypasses.mjs';

// No module resolution or execution: inspect the preserved mutant AST only.
const here = new URL('./', import.meta.url);
const data = JSON.parse(readFileSync('scripts/strategy-time-boundaries.json', 'utf8'));
const prior = JSON.parse(readFileSync(new URL('independent-original-provider-import-provenance-red-72b.json', here), 'utf8'));
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
const baseline = checkTimeSources(sources, data);
assert.deepEqual(baseline, []);
const baselineAnalysis = analyzeTimeSource(prior.file, sources.get(prior.file), data);
assert.deepEqual(baselineAnalysis.events, []);
const badAnalysis = analyzeTimeSource(prior.file, prior.mutant, data);
assert.equal(badAnalysis.events.length, 3);
sources.set(prior.file, prior.mutant);
const failures = checkTimeSources(sources, data);
assert.equal(failures.length, 3);
const receipt = {
  source: process.argv[2], priorSource: prior.source, sourceFiles: sources.size,
  baseline, baselineAnalysis, badAnalysis, failures,
  moduleGraphLoaded: false, mutantsExecuted: false, nativeAcceptance: false,
};
writeFileSync(new URL('provider-import-provenance-green-c00.json', here), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ source: receipt.source, sourceFiles: sources.size, refusedHookReferences: failures.length, baseline, moduleGraphLoaded: false, mutantsExecuted: false }, null, 2));
