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
  const lockAt = stage1Sql.indexOf('LOCK TABLE public."clio_meri_memory_submissions" IN ACCESS EXCLUSIVE MODE;');
  const guardAt = stage1Sql.indexOf('DO $stage1_guard$');
  const alterAt = stage1Sql.indexOf('ALTER TABLE public."clio_meri_memory_submissions"');
  assert.ok(lockAt > stage1Sql.indexOf('SET LOCAL lock_timeout'));
  assert.ok(lockAt < guardAt && guardAt < alterAt);
  assert.match(stage1Sql, /public\."_prisma_migrations"/);
  assert.match(stage1Sql, /m\.finished_at IS NOT NULL/);
  assert.match(stage1Sql, /m\.rolled_back_at IS NULL/);
  assert.match(stage1Sql, /090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5/);
  assert.match(stage1Sql, /d70772020ba2cec0a4a590a62fa45c1922c774b77a0514836fbeb6204d3ecb97/);
  assert.match(stage1Sql, /r\.relrowsecurity AND r\.relforcerowsecurity/);
  assert.match(stage1Sql, /a\.atttypid = 'pg_catalog\.jsonb'::regtype[\s\S]*a\.attnotnull/);
  for (const column of [
    'tenant_id', 'candidate_id', 'candidate_sha256', 'proposer_user_id',
    'review_id', 'candidate', 'created_at',
  ]) {
    assert.match(stage1Sql, new RegExp(`\\('${column}', 'pg_catalog\\.`));
  }
  assert.match(stage1Sql, /a\.atttypmod = expected\.typmod[\s\S]*a\.attnotnull/);
  assert.match(stage1Sql, /\(d\.oid IS NOT NULL\) = expected\.has_default/);
  assert.match(stage1Sql, /pg_catalog\.pg_get_expr\(d\.adbin, d\.adrelid\)\) = 'CURRENT_TIMESTAMP'/);
  assert.match(stage1Sql, /clio_meri_memory_submissions_candidate_check/);
  assert.match(stage1Sql, /c\.convalidated/);
  assert.match(stage1Sql, /clio_meri_memory_submission_immutable/);
  assert.match(stage1Sql, /clio_meri_memory_submissions_isolation/);
  assert.match(stage1Sql, /ALTER TABLE public\."clio_meri_memory_submissions"\s+ALTER COLUMN "candidate" DROP NOT NULL;/);
  assert.equal((stage1Sql.match(/\bALTER TABLE\b/g) ?? []).length, 1);
  assert.ok(stage1Sql.indexOf('$stage1_guard$;') < stage1Sql.indexOf('ALTER TABLE'));
  assert.doesNotMatch(stage1Sql, /\b(?:DROP\s+(?:COLUMN|CONSTRAINT|TABLE)|TRUNCATE|DELETE\s+FROM|UPDATE\s+"?clio_meri_memory_submissions"?)\b/i);
});

test('stage 1 rejects extra constraints, conditional triggers and altered RLS policy', () => {
  for (const constraint of [
    'clio_meri_memory_submissions_pkey',
    'clio_meri_memory_submissions_review_id_key',
    'clio_meri_memory_submissions_tenant_fkey',
    'clio_meri_memory_submissions_sha_check',
    'clio_meri_memory_submissions_candidate_check',
  ]) {
    assert.match(original, new RegExp(`CONSTRAINT "${constraint}"`));
    assert.match(stage1Sql, new RegExp(`'${constraint}'`));
  }
  assert.match(stage1Sql, /FROM pg_catalog\.pg_constraint c\s+WHERE c\.conrelid = receipt_oid\s+\) <> 5/);
  assert.match(stage1Sql, /c\.conname = 'clio_meri_memory_submissions_sha_check'[\s\S]*c\.conkey = ARRAY\[a\.attnum\]::smallint\[\]/);
  assert.match(stage1Sql, /candidate_sha256::text~''\^\[0-9a-f\]\{64\}\$''::text/);
  assert.match(stage1Sql, /t\.tgqual IS NULL AND t\.tgattr = ''::pg_catalog\.int2vector/);
  assert.match(stage1Sql, /f\.prosrc[\s\S]*BEGINRAISEEXCEPTION/);
  assert.match(stage1Sql, /FROM pg_catalog\.pg_policy p WHERE p\.polrelid = receipt_oid\s+\) <> 1/);
  assert.match(stage1Sql, /p\.polpermissive[\s\S]*p\.polroles = ARRAY\[0\]::oid\[\]/);
  assert.equal((stage1Sql.match(/rls_bypassORtenant_id=current_tenant_id/g) ?? []).length, 2);
});
