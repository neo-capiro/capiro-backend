import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePhase3ScopeBase } from './engagement-phase3-scope-base.mjs';
const sha = 'a'.repeat(40);
test('uses the actual origin/main merge base against the requested end', () => {
  const calls = [];
  assert.equal(
    resolvePhase3ScopeBase({
      end: 'reviewed-head',
      git(args) {
        calls.push(args);
        return sha;
      },
    }),
    sha,
  );
  assert.deepEqual(calls, [
    ['rev-parse', '--verify', '--quiet', 'origin/main'],
    ['merge-base', 'origin/main', 'reviewed-head'],
  ]);
});
test('retains explicit historical scope when requested', () => {
  assert.equal(
    resolvePhase3ScopeBase({
      explicitBase: 'historical',
      git(args) {
        assert.deepEqual(args, ['rev-parse', 'historical^{commit}']);
        return sha;
      },
    }),
    sha,
  );
});
test('uses verified local main only when origin/main is unavailable', () => {
  const calls = [];
  assert.equal(
    resolvePhase3ScopeBase({
      git(args) {
        calls.push(args);
        if (args.at(-1) === 'origin/main') throw new Error('missing');
        return sha;
      },
    }),
    sha,
  );
  assert.deepEqual(calls.at(-1), ['merge-base', 'main', 'HEAD']);
});
test('fails closed when no main ref exists', () => {
  assert.throws(
    () =>
      resolvePhase3ScopeBase({
        git() {
          throw new Error('missing');
        },
      }),
    /verified origin\/main or main/,
  );
});
test('does not replace a failed merge-base operation with HEAD or a stale ref', () => {
  assert.throws(
    () =>
      resolvePhase3ScopeBase({
        git(args) {
          if (args[0] === 'merge-base') throw new Error('history incomplete');
          return sha;
        },
      }),
    /history incomplete/,
  );
});
test('fails closed on malformed merge-base output', () => {
  assert.throws(
    () =>
      resolvePhase3ScopeBase({
        git(args) {
          return args[0] === 'merge-base' ? 'HEAD' : sha;
        },
      }),
    /Invalid Phase 3 merge base/,
  );
});
test('explicit invalid commit resolution remains a failure', () => {
  assert.throws(
    () =>
      resolvePhase3ScopeBase({
        explicitBase: 'bad-ref',
        git() {
          throw new Error('invalid commit');
        },
      }),
    /invalid commit/,
  );
});
