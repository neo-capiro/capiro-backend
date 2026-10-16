import assert from 'node:assert/strict';
import test from 'node:test';
import { outreachCodeScope } from './outreach-code-scope.mjs';

for (const [args, expected] of [
  [['--run'], 'full'],
  [['--run', '--backend-only'], 'backend-only'],
  [['--backend-only', '--run'], 'backend-only'],
]) test(`explicit Outreach code scope ${JSON.stringify(args)}`, () => {
  assert.equal(outreachCodeScope(args), expected);
});
for (const args of [[], ['--backend-only'], ['--run', '--run'],
  ['--run', '--backend-only', '--backend-only'], ['--run', '--frontend-only'],
  ['--run', '--backend-only=true'], ['--run', '--Backend-only'],
  ['--run', ' --backend-only'], ['--run', '--help'], ['--run', 'unknown']]) {
  test(`malformed Outreach code scope refuses before dispatch ${JSON.stringify(args)}`, () => {
    assert.throws(() => outreachCodeScope(args));
  });
}
