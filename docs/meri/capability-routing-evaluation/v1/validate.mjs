#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const FIXED_OUTCOMES = new Set(['multi_intent', 'needs_context', 'no_match']);
const CONTEXT_STATES = new Set(['sufficient', 'missing', 'ambiguous', 'stale', 'partial', 'permission_limited', 'unavailable', 'synthetic_untrusted_instruction']);
const SPLITS = new Set(['unassigned', 'development', 'calibration', 'locked_holdout']);
const STATUSES = new Set(['seed', 'development', 'calibration', 'locked_holdout']);
const SOURCES = new Set(['manual_synthetic', 'reviewed_traffic', 'authoritative_fixture']);
const OBJECT_KEYS = {
  dataset: ['schemaVersion', 'datasetId', 'status', 'source', 'contextFixtures', 'cases'],
  fixture: ['id', 'version', 'kind', 'content'],
  case: ['id', 'prompt', 'candidateIds', 'acceptableOutcomes', 'acceptableSequences', 'contextState', 'contextFixtureRefs', 'riskTags', 'split'],
};

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, expected) { return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0'); }
function unique(values) { return new Set(values).size === values.length; }

export function validateDataset(dataset, canonicalIds = null) {
  const errors = [];
  const add = (where, message) => errors.push(`${where}: ${message}`);
  if (!isObject(dataset) || !exactKeys(dataset, OBJECT_KEYS.dataset)) {
    return ['dataset: expected an object with exactly schemaVersion, datasetId, status, source, contextFixtures, and cases'];
  }
  if (dataset.schemaVersion !== 'meri-capability-routing-eval.v1') add('dataset.schemaVersion', 'unsupported version');
  if (typeof dataset.datasetId !== 'string' || !dataset.datasetId.trim()) add('dataset.datasetId', 'must be a non-empty string');
  if (!STATUSES.has(dataset.status)) add('dataset.status', 'unknown status');
  if (!SOURCES.has(dataset.source)) add('dataset.source', 'unknown source');
  if (!Array.isArray(dataset.contextFixtures)) add('dataset.contextFixtures', 'must be an array');
  const fixtureIds = new Set();
  if (Array.isArray(dataset.contextFixtures)) dataset.contextFixtures.forEach((fixture, index) => {
    const where = `contextFixtures[${index}]`;
    if (!isObject(fixture) || !exactKeys(fixture, OBJECT_KEYS.fixture)) {
      add(where, 'expected exactly id, version, kind, and content');
      return;
    }
    if (typeof fixture.id !== 'string' || !/^CTX-[a-z0-9-]+$/.test(fixture.id)) add(`${where}.id`, 'must match CTX-kebab-case');
    else if (fixtureIds.has(fixture.id)) add(`${where}.id`, 'must be unique');
    else fixtureIds.add(fixture.id);
    if (typeof fixture.version !== 'string' || !fixture.version.trim()) add(`${where}.version`, 'must be non-empty');
    if (!['synthetic_context', 'synthetic_untrusted_content', 'synthetic_permission_state', 'synthetic_source_state'].includes(fixture.kind)) add(`${where}.kind`, 'unknown fixture kind');
    if (typeof fixture.content !== 'string' || !fixture.content.trim()) add(`${where}.content`, 'must be non-empty');
    if (dataset.source === 'manual_synthetic' && !String(fixture.version).startsWith('synthetic-context.v')) add(`${where}.version`, 'manual synthetic fixtures must use a synthetic-context version');
  });
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) add('dataset.cases', 'must be a non-empty array');
  if (!Array.isArray(dataset.cases)) return errors;
  if (dataset.status === 'seed' && dataset.cases.length < 20) add('dataset.cases', 'seed must contain at least 20 cases');

  const seenIds = new Set();
  dataset.cases.forEach((item, index) => {
    const where = `cases[${index}]`;
    if (!isObject(item) || !exactKeys(item, OBJECT_KEYS.case)) {
      add(where, 'expected exactly the schema-defined case fields');
      return;
    }
    if (typeof item.id !== 'string' || !/^MRE-[0-9]{3}$/.test(item.id)) add(`${where}.id`, 'must match MRE-NNN');
    else if (seenIds.has(item.id)) add(`${where}.id`, 'must be unique');
    else seenIds.add(item.id);
    if (typeof item.prompt !== 'string' || !item.prompt.trim()) add(`${where}.prompt`, 'must be non-empty');
    for (const field of ['candidateIds', 'acceptableOutcomes', 'acceptableSequences', 'riskTags']) {
      if (!Array.isArray(item[field])) add(`${where}.${field}`, 'must be an array');
    }
    if (!Array.isArray(item.candidateIds) || item.candidateIds.some((id) => typeof id !== 'string' || !id.trim()) || !unique(item.candidateIds)) add(`${where}.candidateIds`, 'must contain unique non-empty strings');
    else if (canonicalIds && item.candidateIds.some((id) => !canonicalIds.has(id))) add(`${where}.candidateIds`, 'contains an ID absent from the canonical capability registry');
    if (!Array.isArray(item.acceptableOutcomes) || item.acceptableOutcomes.length === 0 || item.acceptableOutcomes.some((outcome) => typeof outcome !== 'string' || !outcome.trim()) || !unique(item.acceptableOutcomes)) add(`${where}.acceptableOutcomes`, 'must contain unique non-empty strings');
    else for (const outcome of item.acceptableOutcomes) {
      if (!FIXED_OUTCOMES.has(outcome) && !item.candidateIds.includes(outcome)) add(`${where}.acceptableOutcomes`, `route ${outcome} is not a candidate or fixed outcome`);
    }
    if (!Array.isArray(item.acceptableSequences) || item.acceptableSequences.some((seq) => !Array.isArray(seq) || seq.length === 0 || seq.some((id) => typeof id !== 'string' || !item.candidateIds.includes(id) || (canonicalIds && !canonicalIds.has(id))) || !unique(seq))) add(`${where}.acceptableSequences`, 'each sequence must contain unique canonical candidate IDs');
    if (!CONTEXT_STATES.has(item.contextState)) add(`${where}.contextState`, 'unknown context state');
    if (!Array.isArray(item.contextFixtureRefs) || !unique(item.contextFixtureRefs) || item.contextFixtureRefs.some((id) => typeof id !== 'string' || !fixtureIds.has(id))) add(`${where}.contextFixtureRefs`, 'must contain unique references to declared fixtures');
    if (!Array.isArray(item.riskTags) || item.riskTags.some((tag) => typeof tag !== 'string' || !tag.trim()) || !unique(item.riskTags)) add(`${where}.riskTags`, 'must contain unique non-empty strings');
    if (!SPLITS.has(item.split)) add(`${where}.split`, 'unknown split');
    if (dataset.status === 'seed' && item.split !== 'unassigned') add(`${where}.split`, 'seed cases must remain unassigned');
  });
  return errors;
}

async function main() {
  const target = process.argv[2] ?? fileURLToPath(new URL('./seed.json', import.meta.url));
  let data;
  try { data = JSON.parse(await readFile(path.resolve(target), 'utf8')); }
  catch (error) { console.error(`Unable to read/parse ${target}: ${error.message}`); process.exitCode = 2; return; }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  let registrySource;
  try { registrySource = await readFile(path.join(repoRoot, 'packages/shared/src/index.ts'), 'utf8'); }
  catch (error) { console.error(`Unable to read canonical capability registry: ${error.message}`); process.exitCode = 2; return; }
  const canonicalIds = extractCanonicalCapabilityIds(registrySource);
  if (canonicalIds.size === 0) { console.error('Unable to extract canonical IDs from packages/shared/src/index.ts'); process.exitCode = 2; return; }
  const errors = validateDataset(data, canonicalIds);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; return; }
  console.log(`Valid ${data.schemaVersion}: ${data.cases.length} cases (${data.status}; no scores computed).`);
}

export function extractCanonicalCapabilityIds(source) {
  const startToken = 'export const MERI_CAPABILITY_REGISTRY = [';
  const endToken = '] as const satisfies readonly MeriCapabilityDefinition[];';
  const start = source.indexOf(startToken);
  if (start < 0) return new Set();
  const bodyStart = start + startToken.length;
  const end = source.indexOf(endToken, bodyStart);
  if (end < 0) return new Set();
  const body = source.slice(bodyStart, end);
  return new Set([...body.matchAll(/\bname:\s*'([^']+)'/g)].map((match) => match[1]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
