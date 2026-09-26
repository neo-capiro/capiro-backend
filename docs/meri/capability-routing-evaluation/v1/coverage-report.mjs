#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateDataset } from './validate.mjs';

const MINIMUM_PER_FAMILY = 50;
const HASH = (value) => createHash('sha256').update(value).digest('hex');
const sortedCounts = (counts, key) => [...counts].map(([name, count]) => ({ [key]: name, count }))
  .sort((a, b) => a[key].localeCompare(b[key]));

export function buildCoverageReport(dataset, rawDataset) {
  if (dataset?.status !== 'seed' || dataset?.source !== 'manual_synthetic') {
    throw new Error('coverage report only accepts the manual_synthetic seed; do not process traffic or holdout data');
  }
  const errors = validateDataset(dataset);
  if (errors.length) throw new Error(`invalid seed: ${errors.join('; ')}`);
  if (dataset.cases.some((item) => item.split !== 'unassigned')) {
    throw new Error('seed cases must remain unassigned; this report does not assign splits');
  }

  const families = new Map();
  const contexts = new Map();
  const risks = new Map();
  const fixtureKinds = new Map();
  const declaredFixtureKinds = new Map();
  const fixturesById = new Map(dataset.contextFixtures.map(({ id, kind }) => [id, kind]));
  for (const fixture of dataset.contextFixtures) {
    declaredFixtureKinds.set(fixture.kind, (declaredFixtureKinds.get(fixture.kind) ?? 0) + 1);
  }
  for (const item of dataset.cases) {
    contexts.set(item.contextState, (contexts.get(item.contextState) ?? 0) + 1);
    for (const id of item.candidateIds) families.set(id, (families.get(id) ?? 0) + 1);
    for (const tag of item.riskTags) risks.set(tag, (risks.get(tag) ?? 0) + 1);
    for (const fixtureId of item.contextFixtureRefs) {
      const kind = fixturesById.get(fixtureId);
      fixtureKinds.set(kind, (fixtureKinds.get(kind) ?? 0) + 1);
    }
  }
  const familyCoverage = [...families].map(([id, caseAppearances]) => ({
    id,
    candidateCaseAppearances: caseAppearances,
    minimumCases: MINIMUM_PER_FAMILY,
    gapToMinimum: Math.max(0, MINIMUM_PER_FAMILY - caseAppearances),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const splitCounts = Object.fromEntries(['unassigned', 'development', 'calibration', 'locked_holdout']
    .map((split) => [split, dataset.cases.filter((item) => item.split === split).length]));

  return {
    reportVersion: 'meri-capability-routing-coverage.v1',
    datasetId: dataset.datasetId,
    sourceDatasetSha256: HASH(rawDataset),
    status: 'structural_seed_coverage_only',
    caseCount: dataset.cases.length,
    fixtureCount: dataset.contextFixtures.length,
    splitCounts,
    candidateFamilies: familyCoverage,
    contextStates: sortedCounts(contexts, 'state'),
    riskTags: sortedCounts(risks, 'tag'),
    fixtureKindsDeclared: sortedCounts(declaredFixtureKinds, 'kind'),
    fixtureKindsReferenced: sortedCounts(fixtureKinds, 'kind'),
    cases: dataset.cases.map((item) => ({
      id: item.id,
      promptSha256: HASH(item.prompt),
      contextState: item.contextState,
      riskTags: [...item.riskTags].sort(),
      fixtureKinds: [...new Set(item.contextFixtureRefs.map((id) => fixturesById.get(id)))].sort(),
      split: item.split,
    })),
    guardrails: {
      promptsIncluded: false,
      fixtureContentIncluded: false,
      acceptableOutcomesIncluded: false,
      groundTruthAsserted: false,
      scoresComputed: false,
      holdoutAssigned: false,
      candidateAppearancesAreNotPositiveRouteOracles: true,
    },
  };
}

async function main() {
  const sourcePath = fileURLToPath(new URL('./seed.json', import.meta.url));
  const outputPath = process.argv[2] ?? fileURLToPath(new URL('./coverage-report.json', import.meta.url));
  const raw = await readFile(sourcePath);
  const dataset = JSON.parse(raw.toString('utf8'));
  const report = buildCoverageReport(dataset, raw);
  await writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Wrote structural-only coverage for ${report.caseCount} synthetic seed cases; no outcomes or scores included.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
