import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const source = await readFile(new URL('./history-release-selected-client-owner.ts', import.meta.url), 'utf8');
const url = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const { assertSelectedClientHistoryReleaseWithinTx: authorize,
  HistoryReleaseSelectedClientUnavailable: Unavailable } = await import(url);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1), actor = id(2), clientA = id(3), clientB = id(4);
const conversationA = id(5), conversationB = id(6), grant = id(7);
const principal = { tenantId: tenant, actorId: actor };
const subject = (conversationId, clientId, overrides = {}) => ({
  conversationId, clientId,
  scopes: [{ tenantId: tenant, kind: 'client', resourceId: clientId, policyRevision: 'policy-owned-by-meri' }],
  ...overrides,
});
const list = [subject(conversationB, clientB), subject(conversationA, clientA)];
const denied = error => error instanceof Unavailable;

test('selected-client history leaf checks an entire vector with deterministic, explicitly scoped locks', async t => {
  // Disposable in-process PostgreSQL. It qualifies predicates and lock SQL,
  // not application role privileges or production concurrency scheduling.
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,status text,memory_wall boolean);
      CREATE TABLE client_memory_access(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,user_id uuid);
      CREATE TABLE clio_conversations(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,client_id uuid,
        status text,archived_at timestamptz,metadata_jsonb jsonb);
    `);
    await db.query('INSERT INTO clients VALUES ($1,$2,$3,$4),($5,$2,$3,$6)',
      [clientA, tenant, 'active', false, clientB, true]);
    await db.query('INSERT INTO client_memory_access VALUES ($1,$2,$3,$4)', [grant, tenant, clientB, actor]);
    await db.query('INSERT INTO clio_conversations VALUES ($1,$2,$3,$4,$5,NULL,$6),($7,$2,$3,$8,$5,NULL,$6)',
      [conversationA, tenant, actor, clientA, 'active', '{}', conversationB, clientB]);

    const sqlTrace = [];
    const tx = { async $queryRaw(parts, ...values) {
      const sql = parts.reduce((joined, part, index) => joined + (index ? `$${index}` : '') + part, '');
      sqlTrace.push({ sql, values });
      return (await db.query(sql, values)).rows;
    } };
    const expectDenied = async (route, subjects) => assert.rejects(authorize(tx, principal, route, subjects), denied);

    await t.test('success locks owned conversations, then clients and required grant in sorted order', async () => {
      await authorize(tx, principal, 'list', list);
      assert.equal(sqlTrace.length, 5);
      assert.deepEqual(sqlTrace.map(x => x.values.at(-1)),
        [conversationA, conversationB, clientA, clientB, actor]);
      assert(sqlTrace.every(x => x.sql.includes('FOR SHARE')));
      assert(sqlTrace[0].sql.includes('user_id = $2::uuid'));
      assert(sqlTrace[2].sql.includes('tenant_id = $1::uuid'));
      assert(sqlTrace[4].sql.includes('user_id = $3::uuid'));
      sqlTrace.length = 0;
    });

    await t.test('empty list and one-subject transcript are possible; empty transcript is denied', async () => {
      await authorize(tx, principal, 'list', []);
      assert.equal(sqlTrace.length, 0);
      await authorize(tx, principal, 'transcript', [list[0]]);
      await expectDenied('transcript', []);
      sqlTrace.length = 0;
    });

    await t.test('unsupported shape, scope, duplicates and overflow fail before any SQL', async () => {
      const invalid = [
        [subject(conversationA, null)],
        [subject(conversationA, clientA, { scopes: [] })],
        [subject(conversationA, clientA, { scopes: [
          { tenantId: tenant, kind: 'public', resourceId: clientA, policyRevision: 'x' }] })],
        [subject(conversationA, clientA, { scopes: [
          { tenantId: id(99), kind: 'client', resourceId: clientA, policyRevision: 'x' }] })],
        [subject(conversationA, clientA, { scopes: [
          { tenantId: tenant, kind: 'client', resourceId: clientB, policyRevision: 'x' }] })],
        [list[0], list[0]],
        Array.from({ length: 101 }, (_, i) => subject(id(i + 100), clientA)),
      ];
      for (const subjects of invalid) await expectDenied('list', subjects);
      assert.equal(sqlTrace.length, 0);
    });

    await t.test('tenant, owner, selected client, active/archive and walled access must all hold', async () => {
      const cases = [
        ['clients', clientA, 'tenant_id', id(91)],
        ['clients', clientA, 'status', 'archived'],
        ['clio_conversations', conversationA, 'tenant_id', id(91)],
        ['clio_conversations', conversationA, 'user_id', id(91)],
        ['clio_conversations', conversationA, 'client_id', clientB],
        ['clio_conversations', conversationA, 'status', 'inactive'],
        ['clio_conversations', conversationA, 'archived_at', '2026-10-18T00:00:00Z'],
      ];
      for (const [table, row, column, value] of cases) {
        const prior = (await db.query(`SELECT ${column} FROM ${table} WHERE id=$1`, [row])).rows[0][column];
        await db.query(`UPDATE ${table} SET ${column}=$1 WHERE id=$2`, [value, row]);
        await expectDenied('list', list);
        await db.query(`UPDATE ${table} SET ${column}=$1 WHERE id=$2`, [prior, row]);
      }
      await db.query('DELETE FROM client_memory_access WHERE id=$1', [grant]);
      await expectDenied('list', list);
      await db.query('INSERT INTO client_memory_access VALUES ($1,$2,$3,$4)', [grant, tenant, clientB, actor]);
      sqlTrace.length = 0;
    });

    await t.test('prospect and research-portfolio metadata remain closed without their transaction-aware owners', async () => {
      for (const key of ['bizdevProspectScope', 'researchPortfolioScope']) {
        await db.query('UPDATE clio_conversations SET metadata_jsonb=$1 WHERE id=$2',
          [JSON.stringify({ [key]: { id: id(40) } }), conversationA]);
        await expectDenied('list', list);
      }
      await db.query('UPDATE clio_conversations SET metadata_jsonb=$1 WHERE id=$2', ['{}', conversationA]);
    });
  } finally {
    await db.close();
  }
});
