/**
 * End-to-end test of the node:test structured reporter against a REAL Node test
 * runner on an isolated fixture spec (a simulated runner process, not a
 * workspace suite). Proves the reporter is loadable by `--test-reporter` and
 * that nested suites + duplicates survive a real run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTER = path.join(HERE, 'node-test-reporter.mjs');

test('node:test reporter: real Node run over nested describe preserves names and multiplicity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-reporter-'));
  const spec = path.join(dir, 'fixture.test.mjs');
  fs.writeFileSync(
    spec,
    `import { describe, it } from 'node:test';
import assert from 'node:assert';
describe('outer', () => {
  describe('inner', () => {
    it('deep', () => assert.ok(true));
    it('todo case', { todo: true }, () => {});
  });
  it.skip('skipped case', () => {});
  it('duplicate', () => assert.ok(true));
  it('duplicate', () => assert.ok(true));
});
`,
  );
  const out = path.join(dir, 'report.json');
  const childEnv = { ...process.env, TEST_PROOF_OUT_FILE: out };
  // A child `node --test` spawned from inside a test run inherits the parent's
  // test context and would refuse to run; strip it.
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter', pathToFileURL(REPORTER).href, spec], {
      encoding: 'utf8',
      env: childEnv,
    });
    assert.equal(r.status, 0, r.stderr);
    if (!fs.existsSync(out)) {
      assert.fail(`reporter produced no file; status=${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
    }
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    const names = report.tests.map((t) => t.fullName).sort();
    assert.deepEqual(names, [
      'outer > duplicate',
      'outer > duplicate',
      'outer > inner > deep',
      'outer > inner > todo case',
      'outer > skipped case',
    ]);
    assert.equal(report.tests.filter((t) => t.fullName === 'outer > duplicate').length, 2);
    assert.equal(report.tests.find((t) => t.fullName === 'outer > inner > todo case').status, 'todo');
    assert.equal(report.tests.find((t) => t.fullName === 'outer > skipped case').status, 'skipped');
    assert.ok(!names.includes('fixture.test.mjs'), 'the root file node is not a test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
