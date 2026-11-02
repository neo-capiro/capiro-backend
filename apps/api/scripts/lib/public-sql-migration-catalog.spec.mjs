import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverMigrationDirectories } from './pe-phase-9-migration-discovery.mjs';

const api = fileURLToPath(new URL('../../', import.meta.url));
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const migrationName = '20281031160000_public_sql_hearing_projections';
const predecessor = '20281031150000_defproc_qualified_sam_actions_v2';
const relativeSql = `apps/api/prisma/migrations/${migrationName}/migration.sql`;
const sql = readFileSync(join(repository, relativeSql));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('canonical migration is byte-identical to the independently accepted DB package', () => {
  assert.equal(sql.length, 17761);
  assert.equal(digest(sql), '62afa66c7bacd1a3d1ade46802cdda07b89157ab2fa2b122d2b0766c6aa9dede');
});

test('existing catalog discovery finds the assigned successor exactly once after Lane 6', () => {
  const names = discoverMigrationDirectories(join(api, 'prisma/migrations'));
  assert.deepEqual(names.filter((name) => name.startsWith('20281031160000_')), [migrationName]);
  assert.ok(names.includes(predecessor));
  assert.ok(names.indexOf(migrationName) > names.indexOf(predecessor));
});

test('exact-path Git attributes preserve the accepted SQL bytes across checkouts', () => {
  const attributes = readFileSync(join(repository, '.gitattributes'), 'utf8').split(/\r?\n/);
  assert.ok(attributes.includes(`${relativeSql} -text`));
});

test('migration installs exactly the four accepted restricted projections', () => {
  const matrixBytes = readFileSync(join(repository, 'docs/public-sql-coverage-20261031/VIEW-MATRIX.json'));
  assert.equal(digest(matrixBytes), 'a9fefe48b79cc55d3c49f636e4cb459fac49639c12255a23c5a4b223b697a00d');
  const matrix = JSON.parse(matrixBytes.toString('utf8'));
  const views = [...sql.toString('utf8').matchAll(/^CREATE VIEW public\.(\w+) WITH \(security_barrier=true, security_invoker=false\) AS$/gm)]
    .map((match) => match[1]);
  assert.equal(views.length, 4);
  assert.deepEqual(views, matrix.relations.map((relation) => relation.viewName));
});
