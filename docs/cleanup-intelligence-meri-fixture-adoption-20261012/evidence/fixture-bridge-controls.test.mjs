import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = 'd587441261fd356ee5144a8fc29cb2f771d062b8';
const published = '67fa9255b8a73f489d7a57c8fe270ed6d03fa016';
const git = (head, name) => execFileSync('git', ['show', `${head}:${name}`], { cwd: repository });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pairs = [
  ['apps/api/src/intelligence/__fixtures__/legacy-ui-contracts/IntelligenceMappingsPage.tsx.txt', 'apps/web/src/pages/settings/IntelligenceMappingsPage.tsx'],
  ['apps/api/src/intelligence/__fixtures__/legacy-ui-contracts/intelligence-mappings-shared.ts.txt', 'apps/web/src/pages/settings/intelligence-mappings-shared.ts'],
  ['apps/api/src/meri/__fixtures__/legacy-ui-contracts/components/chat/useMeriChatController.ts.txt', 'apps/web/src/components/chat/useMeriChatController.ts'],
  ['apps/api/src/meri/__fixtures__/legacy-ui-contracts/vnext/shell/AppShellUui/index.tsx.txt', 'apps/web/src/vnext/shell/AppShellUui/index.tsx'],
];
const readers = ['apps/api/src/intelligence/intelligence.mapping-governance.spec.ts',
  'apps/api/src/meri/meri-stream-launcher.fail-closed.spec.ts'];
const inverse = (name, bytes) => {
  const text = bytes.toString();
  if (name === readers[0]) return Buffer.from(text
    .replaceAll('__fixtures__/legacy-ui-contracts/IntelligenceMappingsPage.tsx.txt', '../../../web/src/pages/settings/IntelligenceMappingsPage.tsx')
    .replaceAll('__fixtures__/legacy-ui-contracts/intelligence-mappings-shared.ts.txt', '../../../web/src/pages/settings/intelligence-mappings-shared.ts'));
  return Buffer.from(text.replace("const WEB_ROOT = join(__dirname, '__fixtures__/legacy-ui-contracts');",
    "const WEB_ROOT = join(__dirname, '../../../web/src');")
    .replace('join(WEB_ROOT, `${rel}.txt`)', 'join(WEB_ROOT, rel)'));
};
const current = new Map([...pairs.map(([fixture]) => fixture), ...readers]
  .map(name => [name, fs.readFileSync(path.join(repository, name))]));
function problems(values) {
  const failures = [];
  for (const [fixture, web] of pairs) {
    const bytes = values.get(fixture);
    if (!bytes || hash(bytes) !== hash(git(baseline, web))) failures.push(`fixture parity: ${fixture}`);
  }
  for (const reader of readers) {
    const bytes = values.get(reader);
    if (!bytes || !bytes.equals(git(published, reader)) || !inverse(reader, bytes).equals(git(baseline, reader)))
      failures.push(`reader body/path/cases: ${reader}`);
  }
  return failures;
}
test('all four adopted fixtures match exact current Web and published code bytes', () => {
  assert.deepEqual(problems(current), []);
  for (const [fixture, web] of pairs) assert(git(published, fixture).equals(git(baseline, web)));
});
test('baseline RED captures the six unresolved fixture/reader transitions without executing UI', () => {
  const before = new Map(readers.map(name => [name, git(baseline, name)]));
  assert.equal(problems(before).length, 6);
  const receipt = { baseline, publishedCode: published, expectedTransitionRefusals: problems(before),
    frontendExecuted: false, deniedReportRead: false };
  fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'baseline-source-transition-red.json'), JSON.stringify(receipt, null, 2)+'\n');
});
for (const [fixture] of pairs) test(`refuses fixture byte drift: ${fixture}`, () => {
  const mutated = new Map(current); mutated.set(fixture, Buffer.concat([current.get(fixture), Buffer.from('\nmutated') ]));
  assert(problems(mutated).some(message => message.includes(fixture)));
});
for (const reader of readers) {
  test(`refuses fallback to live Web reader: ${reader}`, () => {
    const mutated = new Map(current); mutated.set(reader, git(baseline, reader));
    assert(problems(mutated).some(message => message.includes(reader)));
  });
  test(`refuses case/assertion body drift: ${reader}`, () => {
    const mutated = new Map(current); mutated.set(reader, Buffer.from(current.get(reader).toString().replace("toContain(", "not.toContain(")));
    assert(problems(mutated).some(message => message.includes(reader)));
  });
}
test('refuses a missing legacy data fixture', () => {
  const mutated = new Map(current); mutated.delete(pairs[0][0]);
  assert(problems(mutated).some(message => message.includes(pairs[0][0])));
});
test('existing before/after fake-authority and source test cases all remain passing', () => {
  const packet = path.dirname(fileURLToPath(import.meta.url));
  const before = JSON.parse(fs.readFileSync(path.join(packet, 'before-jest-results.json')));
  const after = JSON.parse(fs.readFileSync(path.join(packet, 'after-jest-results.json')));
  const names = result => result.testResults.flatMap(suite => suite.assertionResults.map(item =>
    ({ name: item.fullName, status: item.status }))).sort((a,b) => a.name.localeCompare(b.name));
  assert.equal(before.numPassedTests, 36); assert.equal(after.numPassedTests, 36);
  assert.equal(before.numFailedTests, 0); assert.equal(after.numFailedTests, 0);
  assert.deepEqual(names(before), names(after));
});
