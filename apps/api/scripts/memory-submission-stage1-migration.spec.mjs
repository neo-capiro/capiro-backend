import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrations = new URL('../prisma/migrations/', import.meta.url);
const originalPath = new URL(
  '20281018020000_clio_meri_memory_submissions/migration.sql', migrations,
);
const stage1Path = new URL(
  '20281018090000_clio_meri_memory_submissions_content_free/migration.sql', migrations,
);
const original = readFileSync(fileURLToPath(originalPath), 'utf8');
const stage1 = readFileSync(fileURLToPath(stage1Path), 'utf8');
const originalLf = original.replace(/\r\n/g, '\n');
const stage1Sql = stage1.replace(/^--.*$/gm, '');

test('historical receipt migration remains the original payload-bearing source', () => {
  const digest = createHash('sha256').update(originalLf).digest('hex');
  assert.equal(digest, '090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5');
  const crlfDigest = createHash('sha256')
    .update(originalLf.replace(/\n/g, '\r\n'))
    .digest('hex');
  assert.equal(crlfDigest, 'd70772020ba2cec0a4a590a62fa45c1922c774b77a0514836fbeb6204d3ecb97');
  assert.match(original, /"candidate" JSONB NOT NULL/);
  assert.match(original, /clio_meri_memory_submissions_candidate_check/);
  assert.match(original, /BEFORE UPDATE ON "clio_meri_memory_submissions"\s+FOR EACH ROW/);
});

test('stage 1 is guarded, bounded, transactional and data-preserving', () => {
  assert.match(stage1Sql, /\bBEGIN;[\s\S]*\bCOMMIT;/);
  assert.match(stage1Sql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(stage1Sql, /SET LOCAL statement_timeout = '30s'/);
  assert.match(stage1Sql, /public\."_prisma_migrations"/);
  assert.match(stage1Sql, /m\.finished_at IS NOT NULL/);
  assert.match(stage1Sql, /m\.rolled_back_at IS NULL/);
  assert.match(stage1Sql, /090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5/);
  assert.match(stage1Sql, /d70772020ba2cec0a4a590a62fa45c1922c774b77a0514836fbeb6204d3ecb97/);
  assert.match(stage1Sql, /r\.relrowsecurity AND r\.relforcerowsecurity/);
  assert.match(stage1Sql, /a\.atttypid = 'pg_catalog\.jsonb'::regtype[\s\S]*a\.attnotnull/);
  assert.match(stage1Sql, /clio_meri_memory_submissions_candidate_check/);
  assert.match(stage1Sql, /clio_meri_memory_submission_immutable/);
  assert.match(stage1Sql, /clio_meri_memory_submissions_isolation/);
  assert.match(stage1Sql, /ALTER TABLE public\."clio_meri_memory_submissions"\s+ALTER COLUMN "candidate" DROP NOT NULL;/);
  assert.equal((stage1Sql.match(/\bALTER TABLE\b/g) ?? []).length, 1);
  assert.ok(stage1Sql.indexOf('$stage1_guard$;') < stage1Sql.indexOf('ALTER TABLE'));
  assert.doesNotMatch(stage1Sql, /\b(?:DROP\s+(?:COLUMN|CONSTRAINT|TABLE)|TRUNCATE|DELETE\s+FROM|UPDATE\s+"?clio_meri_memory_submissions"?)\b/i);
});
