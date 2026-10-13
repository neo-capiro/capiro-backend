import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {classifyReviewedHygienePaths, RAW_ARCHIVES, RAW_ARCHIVE_SOURCE} from '../lib/reviewed-source-hygiene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const archives = () => new Map(RAW_ARCHIVES.map(([file]) => [file,
  execFileSync('git', ['show', `${RAW_ARCHIVE_SOURCE}:${file}`], {cwd: ROOT})]));

test('only four immutable published raw observations are classified; source and normal docs remain checked', () => {
  const ordinary = ['scripts/ci/source.spec.mjs', 'docs/README.md', 'docs/evidence/new.patch',
    'docs/cleanup-newsletter-canonical-builder-20261013/evidence/new.stdout',
    ':(exclude)scripts/ci/source.spec.mjs'];
  const raw = RAW_ARCHIVES.map(([file]) => file);
  const result = classifyReviewedHygienePaths([...raw, ...ordinary], archives());
  assert.deepEqual(result.classifiedRawPaths, raw);
  assert.deepEqual(result.checkedPaths, ordinary);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.checkedPaths));
});

test('changed archive bytes, invented source exclusions, incomplete or extra identities refuse', () => {
  for (const [file] of RAW_ARCHIVES) {
    const modified = archives();
    modified.set(file, Buffer.concat([modified.get(file), Buffer.from('\n')]));
    assert.throws(() => classifyReviewedHygienePaths([file], modified), /identity mismatch/);
    const sameLength = archives();
    const value = Buffer.from(sameLength.get(file)); value[0] ^= 1; sameLength.set(file, value);
    assert.throws(() => classifyReviewedHygienePaths([file], sameLength), /identity mismatch/);
  }
  const missing = archives(); missing.delete(RAW_ARCHIVES[0][0]);
  assert.throws(() => classifyReviewedHygienePaths([], missing), /four exact/);
  const extra = archives(); extra.set('scripts/unreviewed.mjs', Buffer.from(' '));
  assert.throws(() => classifyReviewedHygienePaths(['scripts/unreviewed.mjs'], extra), /four exact/);
  const invented = archives(); invented.delete(RAW_ARCHIVES[0][0]); invented.set('scripts/unreviewed.mjs', Buffer.alloc(0));
  assert.throws(() => classifyReviewedHygienePaths([], invented), /identity mismatch/);
});

test('duplicate, traversal, nonliteral, unbounded and coercible paths refuse without running coercion', () => {
  for (const paths of [['a', 'a'], ['../a'], ['/a'], ['a//b'], ['a/./b'], ['a\\b'],
    ['a\nb'], ['a\0b'], ['x'.repeat(4097)], [null], new Array(100001).fill('a')])
    assert.throws(() => classifyReviewedHygienePaths(paths, archives()), /literal repository paths/);
  const dangerous = {toString() {throw new Error('coercion executed');}};
  assert.throws(() => classifyReviewedHygienePaths([dangerous], archives()), /literal repository paths/);
});

test('local CLI requires explicit bounded mode and exact base; help and bad args do not touch Git', () => {
  const owner = path.join(ROOT, 'scripts/lib/reviewed-source-hygiene.mjs');
  const cases = [[[], 2], [['--help'], 0], [['--run'], 2],
    [['--run', '--base', 'HEAD'], 2], [['--run', '--base', 'a'.repeat(40), '--exclude', 'docs/**'], 2]];
  for (const [args, expected] of cases) {
    const result = spawnSync(process.execPath, ['--no-addons', owner, ...args],
      {cwd: ROOT, encoding: 'utf8', env: {PATH: '/nonexistent'}});
    assert.equal(result.status, expected);
    assert.match(result.stdout + result.stderr, /Usage:/);
  }
});
