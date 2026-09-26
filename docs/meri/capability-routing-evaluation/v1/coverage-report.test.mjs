import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildCoverageReport } from './coverage-report.mjs';

const seedPath = fileURLToPath(new URL('./seed.json', import.meta.url));
const rawSeed = await readFile(seedPath);
const seed = JSON.parse(rawSeed.toString('utf8'));

test('reports aggregate and hashed dimensions without exposing seed text or outcome labels', () => {
  const report = buildCoverageReport(seed, rawSeed);
  assert.equal(report.caseCount, 24);
  assert.equal(report.fixtureCount, 13);
  assert.deepEqual(report.splitCounts, { unassigned: 24, development: 0, calibration: 0, locked_holdout: 0 });
  assert.equal(report.candidateFamilies.length, 14);
  assert.deepEqual(report.fixtureKindsDeclared, [
    { kind: 'synthetic_context', count: 8 },
    { kind: 'synthetic_permission_state', count: 1 },
    { kind: 'synthetic_source_state', count: 3 },
    { kind: 'synthetic_untrusted_content', count: 1 },
  ]);
  assert.ok(report.candidateFamilies.every((family) => family.candidateCaseAppearances < 50));
  assert.ok(report.candidateFamilies.every((family) => family.gapToMinimum === 50 - family.candidateCaseAppearances));
  assert.equal(report.cases.length, 24);
  assert.ok(report.cases.every((item) => /^[a-f0-9]{64}$/.test(item.promptSha256)));
  assert.equal(report.cases.some((item) => 'prompt' in item || 'acceptableOutcomes' in item), false);
  assert.deepEqual(report.guardrails, {
    promptsIncluded: false,
    fixtureContentIncluded: false,
    acceptableOutcomesIncluded: false,
    groundTruthAsserted: false,
    scoresComputed: false,
    holdoutAssigned: false,
    candidateAppearancesAreNotPositiveRouteOracles: true,
  });
  const serialized = JSON.stringify(report);
  for (const item of seed.cases) assert.equal(serialized.includes(item.prompt), false);
  for (const fixture of seed.contextFixtures) assert.equal(serialized.includes(fixture.content), false);
});

test('refuses non-synthetic or partitioned input rather than touching traffic or locked holdout', () => {
  assert.throws(() => buildCoverageReport({ ...seed, source: 'reviewed_traffic' }, rawSeed), /manual_synthetic seed/);
  const assigned = structuredClone(seed);
  assigned.cases[0].split = 'locked_holdout';
  assert.throws(() => buildCoverageReport(assigned, rawSeed), /must remain unassigned/);
});
