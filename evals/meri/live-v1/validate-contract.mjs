import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cases } from './cases.mjs';
import { frozenFixture, FIXTURE_VERSION } from './fixture.mjs';
import { sha256Bytes, sha256Stable, sha256Text } from './lib/stable.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const [defaultAppendix, defaultLock] = await Promise.all([
  readFile(new URL('./source/appendix-f.md', import.meta.url), 'utf8'),
  readFile(new URL('./contract-lock.json', import.meta.url), 'utf8').then(JSON.parse),
]);

export function expectedCaseIds() {
  return Array.from({ length: 75 }, (_, index) => String(index + 1).padStart(2, '0'));
}

export function parseAppendixCases(markdown) {
  const rows = [];
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^\| (\d{2}) \| “(.+)” \| (.+) \| (.+) \|$/u.exec(line);
    if (match) {
      rows.push({ id: match[1], prompt: match[2], setup: match[3], rowPassCondition: match[4] });
    }
  }
  return rows;
}

function hasNonemptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

export function validateContract({
  caseManifest = cases,
  fixture = frozenFixture,
  lock = defaultLock,
  appendix = defaultAppendix,
} = {}) {
  const errors = [];
  const reject = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const expectedIds = expectedCaseIds();
  const ids = caseManifest.map((testCase) => testCase?.id);
  const parsedRows = parseAppendixCases(appendix);
  const parsedById = new Map(parsedRows.map((row) => [row.id, row]));
  const fixtureSourceIds = new Set(Object.keys(fixture?.sources ?? {}));

  reject(Array.isArray(caseManifest), 'manifest must be an array');
  reject(caseManifest.length === 75, `manifest must contain exactly 75 cases; received ${caseManifest.length}`);
  reject(new Set(ids).size === ids.length, 'manifest contains duplicate case IDs');
  reject(JSON.stringify(ids) === JSON.stringify(expectedIds), 'manifest IDs must be exactly sequential 01..75 in order');
  reject(parsedRows.length === 75, `frozen Appendix F must contain exactly 75 case rows; received ${parsedRows.length}`);
  reject(new Set(parsedRows.map((row) => row.id)).size === 75, 'frozen Appendix F contains duplicate or missing case IDs');
  reject(lock?.schemaVersion === 1, 'contract lock schemaVersion must be 1');
  reject(sha256Text(appendix) === lock?.contractSourceSha256, 'frozen Appendix F source hash drift');
  reject(sha256Stable(fixture) === lock?.fixtureSha256, 'frozen fixture hash drift');
  reject(fixture?.version === FIXTURE_VERSION, 'fixture version drift');
  reject(fixture?.clock?.local === '2026-09-26 12:00 America/New_York', 'frozen local clock drift');
  reject(fixture?.clock?.instant === '2026-09-26T16:00:00.000Z', 'frozen instant drift');
  reject(fixture?.actors?.PAT?.currentRoles?.includes('ordinary_actor'), 'Pat current role is missing');
  reject(fixture?.actors?.PRIYA?.currentRoles?.includes('institutional_memory_reviewer'), 'Priya reviewer role is missing');
  reject(fixture?.actors?.ELI?.ethicalWalls?.includes('BLUEHAVEN'), 'Eli ethical wall is missing');

  const artifact = fixture?.sources?.['ARTIFACT-BRIEF-1']?.facts;
  if (artifact) {
    const actualByteHash = sha256Bytes(Buffer.from(artifact.utf8Bytes, 'utf8'));
    reject(actualByteHash === artifact.byteSha256, 'ARTIFACT-BRIEF-1 raw byte hash drift');
  } else {
    errors.push('ARTIFACT-BRIEF-1 fixture is missing');
  }

  reject(
    JSON.stringify(Object.keys(lock?.promptSha256 ?? {}).sort()) === JSON.stringify([...expectedIds].sort()),
    'prompt hash lock must contain exactly IDs 01..75',
  );

  for (const testCase of caseManifest) {
    if (!testCase || typeof testCase !== 'object') {
      errors.push('manifest contains a malformed non-object case');
      continue;
    }
    const prefix = `case ${String(testCase.id)}`;
    reject(testCase.source?.appendix === 'F', `${prefix}: source appendix must be F`);
    reject(testCase.fixtureVersion === FIXTURE_VERSION, `${prefix}: fixtureVersion drift`);
    reject(typeof testCase.category === 'string' && testCase.category.length > 0, `${prefix}: category is required`);
    reject(['api', 'workspace', 'research'].includes(testCase.surface), `${prefix}: invalid surface`);
    reject(Object.hasOwn(fixture.actors, testCase.actor), `${prefix}: actor is not in frozen fixture`);
    reject(testCase.client === null || Object.hasOwn(fixture.clients, testCase.client), `${prefix}: client is not in frozen fixture`);
    reject(typeof testCase.prompt === 'string' && testCase.prompt.length > 0, `${prefix}: prompt is required`);
    reject(typeof testCase.setup === 'string' && testCase.setup.length > 0, `${prefix}: setup is required`);
    reject(hasNonemptyStrings(testCase.sourceIds), `${prefix}: sourceIds must be non-empty strings`);
    reject(hasNonemptyStrings(testCase.exactFacts), `${prefix}: exactFacts must be non-empty strings`);
    reject(Array.isArray(testCase.requiredSources), `${prefix}: requiredSources must be an array`);
    reject(Array.isArray(testCase.forbiddenSources), `${prefix}: forbiddenSources must be an array`);
    reject(!(testCase.requiredSources ?? []).some((sourceId) => (testCase.forbiddenSources ?? []).includes(sourceId)), `${prefix}: a source cannot be both required and forbidden`);
    reject(testCase.expectedOperation && typeof testCase.expectedOperation.description === 'string', `${prefix}: expectedOperation is required`);
    reject(Array.isArray(testCase.terminal?.allowed) && testCase.terminal.allowed.length > 0, `${prefix}: terminal.allowed is required`);
    reject(Array.isArray(testCase.hardGates) && testCase.hardGates.length >= 2, `${prefix}: global and row hard gates are required`);
    reject(testCase.humanRubric?.target === 8 && testCase.humanRubric?.minimumPerDimension === 1, `${prefix}: human rubric threshold drift`);

    for (const sourceId of [...(testCase.sourceIds ?? []), ...(testCase.requiredSources ?? []), ...(testCase.forbiddenSources ?? [])]) {
      reject(fixtureSourceIds.has(sourceId), `${prefix}: unknown fixture source ID ${sourceId}`);
    }

    const sourceRow = parsedById.get(testCase.id);
    reject(Boolean(sourceRow), `${prefix}: missing from frozen Appendix F`);
    if (sourceRow) {
      reject(testCase.prompt === sourceRow.prompt, `${prefix}: prompt is not verbatim Appendix F`);
      reject(testCase.setup === sourceRow.setup, `${prefix}: setup is not verbatim Appendix F`);
      const rowGate = testCase.hardGates?.find((gate) => gate.id === `${testCase.id}-observable-pass-condition`);
      reject(rowGate?.assertion === sourceRow.rowPassCondition, `${prefix}: observable pass condition drift or weakening`);
    }
    reject(sha256Text(testCase.prompt) === lock?.promptSha256?.[testCase.id], `${prefix}: prompt hash drift`);
  }

  return {
    valid: errors.length === 0,
    errors,
    caseCount: caseManifest.length,
    contractSourceSha256: sha256Text(appendix),
    fixtureSha256: sha256Stable(fixture),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = validateContract();
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}
