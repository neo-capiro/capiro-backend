import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCanonicalCapabilityIds, validateDataset } from './validate.mjs';

const seedPath = fileURLToPath(new URL('./seed.json', import.meta.url));
const seed = JSON.parse(await readFile(seedPath, 'utf8'));
const repoRoot = path.resolve(path.dirname(seedPath), '../../../..');
const registrySource = await readFile(path.join(repoRoot, 'packages/shared/src/index.ts'), 'utf8');
const canonicalIds = extractCanonicalCapabilityIds(registrySource);

test('curated seed satisfies versioned structural and cross-field checks', () => {
  assert.ok(canonicalIds.size > 0);
  assert.deepEqual(validateDataset(seed, canonicalIds), []);
  assert.equal(seed.cases.length, 24);
  assert.ok(seed.cases.every((item) => item.split === 'unassigned'));
});

test('rejects a route label outside the case candidate set', () => {
  const bad = structuredClone(seed);
  bad.cases[0].acceptableOutcomes = ['send_email'];
  assert.ok(validateDataset(bad, canonicalIds).some((error) => error.includes('not a candidate or fixed outcome')));
});

test('rejects duplicate case IDs and duplicate candidates', () => {
  const bad = structuredClone(seed);
  bad.cases[1].id = bad.cases[0].id;
  bad.cases[0].candidateIds.push(bad.cases[0].candidateIds[0]);
  const errors = validateDataset(bad, canonicalIds).join('\n');
  assert.match(errors, /id: must be unique/);
  assert.match(errors, /candidateIds: must contain unique/);
});

test('seed cannot select calibration or holdout membership', () => {
  const bad = structuredClone(seed);
  bad.cases[0].split = 'locked_holdout';
  assert.ok(validateDataset(bad, canonicalIds).some((error) => error.includes('seed cases must remain unassigned')));
});

test('rejects unknown fields so factual or score oracles cannot be silently added to v1', () => {
  const bad = structuredClone(seed);
  bad.cases[0].expectedValue = 123;
  assert.ok(validateDataset(bad, canonicalIds).some((error) => error.includes('exactly the schema-defined case fields')));
});

test('rejects unresolved context fixtures and noncanonical candidate IDs', () => {
  const badContext = structuredClone(seed);
  badContext.cases[0].contextFixtureRefs = ['CTX-does-not-exist'];
  assert.ok(validateDataset(badContext, canonicalIds).some((error) => error.includes('references to declared fixtures')));

  const badTool = structuredClone(seed);
  badTool.cases[0].candidateIds = ['made_up_tool'];
  assert.ok(validateDataset(badTool, canonicalIds).some((error) => error.includes('absent from the canonical capability registry')));
});

test('canonical ID extraction ignores name fields outside the registry array', () => {
  const source = `const unrelated = { name: 'not_a_capability' };\nexport const MERI_CAPABILITY_REGISTRY = [\n  { name: 'real_capability' },\n] as const satisfies readonly MeriCapabilityDefinition[];\nconst later = { name: 'also_not_a_capability' };`;
  assert.deepEqual([...extractCanonicalCapabilityIds(source)], ['real_capability']);
});
