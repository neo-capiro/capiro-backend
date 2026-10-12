import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Qualification of an exact-byte Core input relocation, not an application
// suite. No imports of Jest, fixture materialization, Prisma or API runtime.
// Original source at Core 1e99f0921b207318c6d2abf03927b5c4daa5768b:
// apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json
// blob 2f8a2cb0f733016078b2f9f54418f77962f1d069. This test reads only
// backend-owned inputs; the preserved original Web copy is not a prerequisite.
const fixtureUrl = new URL('./__fixtures__/engagement-current-ui-surface-manifest.v1.json', import.meta.url);
const readerUrl = new URL('./engagement-phase3-read-materialization.spec.ts', import.meta.url);
const ownedLiteral = '__fixtures__/engagement-current-ui-surface-manifest.v1.json';
const originalLiteral = '../../web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json';
const fixtureSha256 = '39423247a62ae040d8dbc6c977597df2b0a58b338e74b70795d1c115c61b58ac';
const originalReaderSha256 = 'e2a7d26bbc33bbd8140aba1194dca04990619ce28be159a1ac434e729fb7bcff';
const caseNames = [
  'materializes every unique current UI read without an unresolved placeholder',
  'binds the current mail-thread detail read to an owned synthetic row',
  'adds the required attachment parent instead of accepting a matching 400',
  'binds named nested parameters to the row that actually owns data',
  'uses the real send-intent fixture and the deliberate no-job absence',
  'negative controls fail on fixture drift, path drift, and unknown parameters',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assertOwnedFixture(bytes) {
  assert.equal(bytes.length, 183851);
  assert.equal(sha256(bytes), fixtureSha256);
  const gitBlob = createHash('sha1')
    .update(Buffer.from('blob ' + bytes.length + '\0'))
    .update(bytes)
    .digest('hex');
  assert.equal(gitBlob, '2f8a2cb0f733016078b2f9f54418f77962f1d069');
}

function assertReaderOnlyRelocated(source) {
  const needle = "'" + ownedLiteral + "'";
  assert.equal(source.split(needle).length - 1, 1, 'one backend-owned fixture path');
  assert.equal(source.includes(originalLiteral), false, 'no remaining Web fixture reader');
  const restored = source.replace(needle, "'" + originalLiteral + "'");
  assert.equal(sha256(Buffer.from(restored)), originalReaderSha256,
    'every original byte except the single path literal remains unchanged');
}

test('backend-owned fixture preserves the complete immutable Core blob and byte identity', () => {
  assertOwnedFixture(readFileSync(fixtureUrl));
});

test('the exact Core JSON workload, route ownership and classifications remain present', () => {
  const bytes = readFileSync(fixtureUrl);
  assertOwnedFixture(bytes);
  const value = JSON.parse(bytes.toString('utf8'));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.requests.length, 237);
  assert.equal(value.routeCoverage.length, 129);
  assert.deepEqual(value.totals, {
    surfaces: 13,
    consumerFiles: 48,
    requests: 237,
    routesTotal: 129,
    routesConsumed: 96,
    routesApiOnly: 33,
    read: 84,
    safeLocalWrite: 72,
    externalAction: 81,
  });
  assert.equal(value.requests.filter((row) => row.classification === 'read').length, 84);
  assert.equal(value.requests.filter((row) => row.classification === 'safe_local_write').length, 72);
  assert.equal(value.requests.filter((row) => row.classification === 'external_action').length, 81);
  assert.ok(value.requests.some((row) => row.routeManifestKey === 'GET /api/engagement/mail-threads/:id'));
  assert.ok(value.routeCoverage.some((row) => row.routeManifestKey === 'GET /api/engagement/outreach/jobs/:id'));
});

test('existing API reader changes exactly one literal while preserving all six case identities and all assertions', () => {
  const source = readFileSync(readerUrl, 'utf8');
  assertReaderOnlyRelocated(source);
  const currentCases = [...source.matchAll(/\btest\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(currentCases, caseNames);
  assert.equal(path.resolve(path.dirname(fileURLToPath(readerUrl)), ownedLiteral),
    fileURLToPath(fixtureUrl));
});

test('qualification rejects fixture bytes, case bodies and reader-path drift without importing the API suite', () => {
  const bytes = readFileSync(fixtureUrl);
  const altered = Buffer.from(bytes);
  altered[0] ^= 1;
  assert.throws(() => assertOwnedFixture(altered));
  const source = readFileSync(readerUrl, 'utf8');
  assert.throws(() => assertReaderOnlyRelocated(source.replace(ownedLiteral, '__fixtures__/missing.json')));
  assert.throws(() => assertReaderOnlyRelocated(source.replace('toBeGreaterThanOrEqual(25)', 'toBeGreaterThanOrEqual(1)')));
  assert.throws(() => assertReaderOnlyRelocated(source.replace(caseNames[1], 'removed mail-thread ownership case')));
});
