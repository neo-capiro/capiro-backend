const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { readFileSync } = require('node:fs');

test('committee news constraint migration bounds lock waiting inside one transaction', () => {
  const sql = readFileSync(
    path.join(
      __dirname,
      '../prisma/migrations/20281008020000_legiwatch_committee_news_update_type/migration.sql',
    ),
    'utf8',
  ).replace(/--[^\r\n]*/g, '');
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  assert.equal(
    statements.length,
    5,
    'Only transaction limits and the atomic constraint replacement',
  );
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements[1], "SET LOCAL lock_timeout = '5s'");
  assert.equal(statements[2], "SET LOCAL statement_timeout = '30s'");
  assert.match(
    statements[3],
    /^ALTER TABLE "committee_site_update"\s+DROP CONSTRAINT "committee_site_update_update_type_chk",\s+ADD CONSTRAINT "committee_site_update_update_type_chk" CHECK/,
  );
  assert.equal(statements[4], 'COMMIT');
});

test('reviewed committee URL authority uses a bounded atomic expansion', () => {
  const sql = readFileSync(
    path.join(
      __dirname,
      '../prisma/migrations/20281008030000_committee_url_official_review/migration.sql',
    ),
    'utf8',
  ).replace(/--[^\r\n]*/g, '');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements.length, 5);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements[1], "SET LOCAL lock_timeout = '5s'");
  assert.equal(statements[2], "SET LOCAL statement_timeout = '30s'");
  assert.match(
    statements[3],
    /^ALTER TABLE "congress_committee"\s+DROP CONSTRAINT "congress_committee_url_source_chk",\s+ADD CONSTRAINT "congress_committee_url_source_chk"\s+CHECK/,
  );
  assert.match(
    statements[3],
    /"url_source" IS NULL OR "url_source" IN \('congress_gov', 'community', 'official_review'\)/,
  );
  assert.equal(statements[4], 'COMMIT');
});

for (const scenario of ['committee-news', 'committee-url-provenance']) {
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
    test(`${scenario} rehearsal rejects ${name} before database access`, () => {
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, 'verify-committee-news-migration.cjs'), scenario],
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
}
