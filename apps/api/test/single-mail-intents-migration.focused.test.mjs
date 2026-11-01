import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Source invariants only: no database client, SQL execution or PostgreSQL validity claim.
// Native fresh/pre-applied/adversarial cases must be run by the allocated database owner.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const normalize = (sql) => sql.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim();
const source = normalize(read('../prisma/migrations/20281028090000_single_mail_intents/migration.sql'));
const proposal = normalize(read('../../../docs/a1/mail/single-mail-intents.sql'));
const consumer = read('../src/engagement/single-mail-ledger.ts');
const fresh = source.match(/DO \$create\$ BEGIN IF to_regclass\('public.single_mail_intents'\) IS NULL THEN (.*?) END IF; END \$create\$;/)?.[1];
assert.ok(fresh, 'all persistent DDL must be inside the absent-public-table branch');

test('fresh DDL is exactly the manual proposal with explicit public qualification', () => {
  assert.equal(fresh.replaceAll('public.', ''), proposal);
});

test('temporary reference preserves every column, check, conflict key, index and policy', () => {
  const reference = source.match(/CREATE TEMP TABLE pg_temp\._single_mail_intents_contract (.*?) DO \$validate\$/)?.[1];
  assert.ok(reference);
  const referenceDDL = `CREATE TABLE single_mail_intents ${reference}`
    .replaceAll('pg_temp._single_mail_intents_contract', 'single_mail_intents')
    .replace(' ON COMMIT DROP', '').trim();
  const withoutForeignKeyAndFlags = proposal
    .replace(' REFERENCES tenants(id) ON DELETE CASCADE', '')
    .replace('ALTER TABLE single_mail_intents ENABLE ROW LEVEL SECURITY; ', '')
    .replace('ALTER TABLE single_mail_intents FORCE ROW LEVEL SECURITY; ', '');
  assert.equal(referenceDDL, withoutForeignKeyAndFlags);
  assert.match(consumer, /ON CONFLICT \(tenant_id, actor_id, request_key\) DO NOTHING/);
});

test('inspection is atomic, locked and refuses existing-object mutation', () => {
  assert.ok(source.startsWith('BEGIN; SET LOCAL search_path = pg_catalog, pg_temp;'));
  assert.ok(source.endsWith('END $validate$; COMMIT;'));
  assert.doesNotMatch(source, /CREATE (?:TABLE|INDEX) IF NOT EXISTS|\b(?:GRANT|REVOKE|TRUNCATE|DROP TABLE|DROP POLICY|DELETE FROM|INSERT INTO|UPDATE public\.)\b/i);
  const outsideFresh = source.replace(fresh, '');
  assert.doesNotMatch(outsideFresh, /(?:CREATE TABLE|ALTER TABLE|CREATE POLICY\s+\w+ ON|ON) public\./);
  assert.match(outsideFresh, /LOCK TABLE public\.single_mail_intents IN ACCESS EXCLUSIVE MODE;/);
  assert.match(outsideFresh, /target <> 'public\.single_mail_intents'::regclass/);
  assert.match(outsideFresh, /t\.relrowsecurity AND t\.relforcerowsecurity/);
  assert.match(outsideFresh, /t\.relkind = 'r' AND t\.relpersistence = 'p' AND NOT t\.relispartition/);
  assert.match(outsideFresh, /inhrelid = target OR inhparent = target/);
  assert.match(outsideFresh, /pg_rewrite WHERE ev_class = target/);
  assert.match(outsideFresh, /pg_trigger WHERE tgrelid = target AND NOT tgisinternal/);
});

test('the comparison includes all definitions and aborts on any differing section', () => {
  assert.equal((source.match(/SELECT jsonb_agg\(definition ORDER BY definition\)/g) ?? []).length, 4);
  assert.match(source, /FROM \(VALUES \(target\), \(reference\)\) AS relation\(oid\)/);
  assert.match(source, /FOREACH section IN ARRAY ARRAY\['columns', 'constraints', 'indexes', 'policies'\]/);
  assert.match(source, /IF actual -> section IS DISTINCT FROM expected -> section THEN RAISE EXCEPTION/);
  assert.match(source, /a\.attrelid = relation\.oid AND a\.attnum > 0/);
  for (const field of ['attname', 'atttypid', 'atttypmod', 'attcollation', 'attnotnull', 'attisdropped', 'attidentity', 'attgenerated', 'attislocal', 'attinhcount']) {
    assert.ok(source.includes(`a.${field}`), field);
  }
  assert.match(source, /pg_get_expr\(d\.adbin, d\.adrelid, false\)/);
});

test('missing/deferrable/not-valid/weakened keys or checks cannot be skipped by name', () => {
  assert.match(source, /FROM pg_constraint c WHERE c\.conrelid = relation\.oid AND c\.contype <> 'f'/);
  for (const field of ['contype', 'conkey', 'condeferrable', 'condeferred', 'convalidated', 'connoinherit', 'conislocal', 'coninhcount', 'conparentid']) {
    assert.ok(source.includes(`c.${field}`), field);
  }
  assert.match(source, /pg_get_expr\(c\.conbin, c\.conrelid, false\)/);
});

test('same-name index must have the full usable definition, including order and predicate', () => {
  assert.match(source, /ic\.relname = 'single_mail_intents_actor_recent', ic\.relkind, am\.amname/);
  assert.match(source, /WHERE i\.indrelid = relation\.oid/);
  for (const field of ['indnatts', 'indnkeyatts', 'indisunique', 'indisprimary', 'indisexclusion', 'indimmediate', 'indisvalid', 'indisready', 'indislive', 'indkey', 'indcollation', 'indclass', 'indoption', 'indexprs', 'indpred']) {
    assert.ok(source.includes(`i.${field}`), field);
  }
});

test('the entire effective policy set is compared, including roles, command and both predicates', () => {
  assert.match(source, /p\.polname, p\.polcmd, p\.polpermissive, p\.polroles/);
  assert.match(source, /pg_get_expr\(p\.polqual, p\.polrelid, false\)/);
  assert.match(source, /pg_get_expr\(p\.polwithcheck, p\.polrelid, false\)/);
  assert.match(source, /FROM pg_policy p WHERE p\.polrelid = relation\.oid \)/);
  assert.doesNotMatch(source, /(?:WHERE|AND)\s+p\.polname\s*=/);
});

test('exactly one enforced tenant cascade FK is allowed; actor/mailbox FKs are refused', () => {
  assert.match(source, /count\(\*\) FROM pg_constraint WHERE conrelid = target AND contype = 'f'\) <> 1/);
  assert.match(source, /c\.conkey = ARRAY\[2\]::smallint\[\]/);
  assert.match(source, /a\.attrelid = 'public\.tenants'::regclass AND a\.attname = 'id'/);
  assert.match(source, /c\.confrelid = 'public\.tenants'::regclass AND c\.confkey = ARRAY\[a\.attnum\]/);
  assert.match(source, /c\.confdeltype = 'c' AND c\.confupdtype = 'a' AND c\.confmatchtype = 's'/);
  assert.match(source, /c\.convalidated AND NOT c\.condeferrable AND NOT c\.condeferred/);
  assert.match(source, /c\.conrelid = target AND c\.contype = 'f' AND t\.tgenabled <> 'O'/);
  assert.match(source, /RAISE EXCEPTION 'single_mail_intents compatibility: tenant foreign key differs/);
});
