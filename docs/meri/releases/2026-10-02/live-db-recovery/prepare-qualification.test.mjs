import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateArchive, validateBuild, ROOT, RELATIVE, TESTED, ARCHIVE_HASHES, SOURCE_HASHES } from './prepare-qualification.mjs';

// Real archived test/review evidence is read only. Build fixtures deliberately use
// the previous successful release to test validation, never to issue qualification.
const repo = 'C:/dev/cap-meri-fixture-hardening';
const archiveCommit = 'd77cbe69da8329784c60135c1af7112d34c39900';
const show = file => execFileSync('git', ['show', `${archiveCommit}:${file}`], { cwd: repo, windowsHide: true });
const archive = new Map(Object.keys(ARCHIVE_HASHES).map(file => [file, show(RELATIVE + file)]));
const sources = new Map(Object.keys(SOURCE_HASHES).map(file => [file, show(file)]));
test('actual immutable integrated archive proves all counts, exits, reviews and current source hashes', () => {
  assert.equal(validateArchive(f => archive.get(f), f => sources.get(f)).jestPassed, 65);
});
test('a changed source file rejects despite unchanged passing receipts', () => {
  const bad = new Map(sources); bad.set('apps/api/src/intelligence/intelligence.service.ts', Buffer.from('changed'));
  assert.throws(() => validateArchive(f => archive.get(f), f => bad.get(f)), /Source changed/);
});
test('a rewritten reviewer exit rejects even if the summary still says PASS', () => {
  const bad = new Map(archive); bad.set('bill-review/bill-keyword-deadline-kimi-exit.json', Buffer.from('{"exitCode":1}'));
  assert.throws(() => validateArchive(f => bad.get(f), f => sources.get(f)), /Archived evidence changed/);
});
test('missing real PostgreSQL evidence cannot be replaced by a summary', () => {
  const bad = new Map(archive); bad.set('integrated-bill-postgres.log', Buffer.from('{}'));
  assert.throws(() => validateArchive(f => bad.get(f), f => sources.get(f)), /Archived evidence changed/);
});

const old = 'C:/dev/cap-meri-foundation-evidence/oct02-first-approval-continuation';
const read = file => JSON.parse(readFileSync(`${old}/${file}`, 'utf8'));
function fixture() {
  const input = read('reviewed-build-input.json'); input.testedCodeSha = TESTED;
  const start = read('api-build-start.json'); const result = read('api-build-readback.json');
  return { input, start, result, recipe: readFileSync(`${ROOT}/api.buildspec.yml`), helper: readFileSync(`${ROOT}/build-qualified-source.py`), now: Date.parse(result.observedAt) + 1000 };
}
const validate = f => validateBuild(f.input, f.start, f.result, f.recipe, f.helper, f.now);
test('complete source/digest/native observer binding is accepted in a pure fixture', () => assert.equal(validate(fixture()).buildStatus, 'SUCCEEDED'));
for (const [name, mutate] of [
  ['wrong resolved source', f => { f.result.resolvedSourceSha = '0'.repeat(40); }],
  ['failed build', f => { f.result.buildStatus = 'FAILED'; }],
  ['missing runtime marker', f => { f.result.executedMarkers.shift(); }],
  ['duplicated marker', f => { f.result.executedMarkers.push(f.result.executedMarkers[0]); }],
  ['different ECR digest', f => { f.result.imageDigest = `sha256:${'0'.repeat(64)}`; }],
  ['stale readback', f => { f.now += 5 * 3600000; }],
  ['different observer (cannot prove native ARM)', f => { f.helper = Buffer.from('changed'); }],
  ['Actions actually ran jobs', f => { f.start.actionRun.jobs.push({ conclusion: 'failure' }); }],
  ['missing required build phase', f => { f.result.phases = f.result.phases.filter(p => p.phase !== 'BUILD'); }],
]) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => validate(f)); });
