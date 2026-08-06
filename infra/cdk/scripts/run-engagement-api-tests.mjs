#!/usr/bin/env node
/**
 * Runs every engagement-api-*.spec.ts file under infra/cdk/test/ through
 * ts-node, one at a time, and aggregates the result.
 *
 * infra/cdk has no jest/vitest. ts-node type-checks on execution, so each
 * spec is both a unit-test run and a typecheck of the file it imports. This
 * runner exists only to give `pnpm test:engagement-api` one command instead
 * of a fragile chain of `&&`-joined invocations in package.json.
 *
 * Usage: node scripts/run-engagement-api-tests.mjs
 * Exit: 0 every spec reported "# fail 0" · 1 at least one spec failed
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(CDK_ROOT, 'test');

const specs = readdirSync(TEST_DIR)
  .filter((name) => name.startsWith('engagement-api-') && name.endsWith('.spec.ts'))
  .sort();

if (specs.length === 0) {
  console.error('FAIL  no engagement-api-*.spec.ts files found under infra/cdk/test/');
  process.exit(1);
}

let totalPass = 0;
let totalFail = 0;
const failedSpecs = [];

for (const spec of specs) {
  const relative = path.join('test', spec);
  console.log(`\n==> ${relative}`);
  let output;
  let status = 0;
  try {
    output = execFileSync(
      'pnpm',
      ['exec', 'ts-node', '--prefer-ts-exts', relative],
      { cwd: CDK_ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
    );
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  process.stdout.write(output);

  const passMatch = /^# pass (\d+)$/m.exec(output);
  const failMatch = /^# fail (\d+)$/m.exec(output);
  const pass = passMatch ? Number(passMatch[1]) : 0;
  const fail = failMatch ? Number(failMatch[1]) : status === 0 ? 0 : 1;

  totalPass += pass;
  totalFail += fail;
  if (fail > 0 || status !== 0) failedSpecs.push(relative);
}

console.log(`\n${specs.length} spec file(s), ${totalPass} passed, ${totalFail} failed`);
if (failedSpecs.length > 0) {
  console.error(`FAIL  ${failedSpecs.join(', ')}`);
  console.error('\nENGAGEMENT_API_CDK_TESTS_FAILED');
  process.exit(1);
}
console.log('\nENGAGEMENT_API_CDK_TESTS_PASSED');
