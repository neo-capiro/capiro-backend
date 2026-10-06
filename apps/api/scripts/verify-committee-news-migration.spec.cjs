const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

for (const [name, url, message] of [
  ['missing fixture setting', '', 'is required'],
  [
    'remote host',
    'postgresql://legiwatch_test:fixture@database.example/capiro',
    'Only owned localhost',
  ],
  [
    'wrong local identity',
    'postgresql://postgres:fixture@localhost/capiro',
    'disposable CI fixture identity',
  ],
  [
    'application database',
    'postgresql://legiwatch_test:fixture@localhost/production',
    'Unexpected fixture service',
  ],
]) {
  test(`migration rehearsal rejects ${name} before database access`, () => {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'verify-committee-news-migration.cjs')],
      {
        env: { ...process.env, LEGIWATCH_MIGRATION_REHEARSAL_DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(result.stdout, '');
  });
}
