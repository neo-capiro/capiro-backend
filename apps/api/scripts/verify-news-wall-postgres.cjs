'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
// Execute the actual shared helper against synthetic local PostgreSQL tables.
// Run outside Jest's VM because PGlite dynamically imports its WASM runtime.
const R = path.resolve(__dirname, '../../..');
const ts = require('typescript');
const { PGlite } = require('@electric-sql/pglite');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const helper = fs.readFileSync(path.join(R, 'apps/api/src/memory/memory-wall.helpers.ts'));
const sandboxModule = { exports: {} };
const compiled = ts.transpileModule(helper.toString(), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert(!compiled.diagnostics?.length);
vm.runInNewContext(
  compiled.outputText,
  { module: sandboxModule, exports: sandboxModule.exports },
  { timeout: 1000 },
);
const candidate = sandboxModule.exports.fetchAccessibleClientRevisionsForClerkActor;
assert.equal(typeof candidate, 'function');
const T = '10000000-0000-4000-8000-000000000001',
  T2 = '10000000-0000-4000-8000-000000000002';
const U = '20000000-0000-4000-8000-000000000001',
  U2 = '20000000-0000-4000-8000-000000000002';
const id = (n) => '30000000-0000-4000-8000-' + String(n).padStart(12, '0');
async function main() {
  const db = new PGlite();
  const results = [];
  try {
    await db.exec(`CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,status text,memory_wall boolean NOT NULL,name text);
   CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text UNIQUE);
   CREATE TABLE tenant_memberships(tenant_id uuid,user_id uuid,status text,role text);
   CREATE TABLE client_memory_access(tenant_id uuid,client_id uuid,user_id uuid);`);
    await db.query('INSERT INTO users VALUES($1,$2),($3,$4)', [
      U,
      'clerk_owner',
      U2,
      'clerk_other',
    ]);
    await db.query(
      "INSERT INTO tenant_memberships VALUES($1,$2,'active','admin'),($1,$3,'active','member')",
      [T, U, U2],
    );
    for (const [n, tenant, status, wall] of [
      [1, T, 'active', false],
      [2, T, 'active', true],
      [3, T, 'active', true],
      [4, T, 'archived', false],
      [5, T2, 'active', false],
      [6, T, 'active', true],
    ])
      await db.query('INSERT INTO clients VALUES($1,$2,$3,$4,$5)', [
        id(n),
        tenant,
        status,
        wall,
        'synthetic-' + n,
      ]);
    // Valid owner grant, another user's grant, and a mismatched-tenant grant.
    await db.query('INSERT INTO client_memory_access VALUES($1,$2,$3),($1,$4,$5),($6,$7,$3)', [
      T,
      id(2),
      U,
      id(3),
      U2,
      T2,
      id(6),
    ]);
    async function read(actor = 'clerk_owner', tenant = T) {
      let captured;
      const tx = {
        $queryRaw: async (strings, ...values) => {
          const sql = strings.reduce((s, part, i) => s + (i ? '$' + i : '') + part, '');
          captured = { sql, values };
          return (await db.query(sql, values)).rows;
        },
      };
      const actual = await candidate(tx, tenant, actor);
      assert.deepEqual(captured.values, [actor, tenant]);
      return actual;
    }
    async function check(name, expected, actor = 'clerk_owner', tenant = T) {
      assert.deepEqual(
        (await read(actor, tenant)).map((r) => r.id),
        expected.map(id),
      );
      results.push(name);
    }
    await check(
      'active membership sees public and explicitly granted clients; admin has no implicit wall access',
      [1, 2],
    );
    await check('other actor sees only own wall grant', [1, 3], 'clerk_other');
    await check('unknown Clerk actor fails closed', [], 'unknown');
    await check('database user UUID is not a Clerk identity', [], U);
    await check('injection-like actor remains a bound parameter', [], "' OR 1=1 --");
    await check('no membership in requested other tenant', [], 'clerk_owner', T2);
    const before = (await read())[0].revision;
    await db.query('UPDATE clients SET name=$1 WHERE id=$2', ['changed-synthetic-name', id(1)]);
    const after = (await read())[0].revision;
    assert.match(before, /^[a-f0-9]{32}$/);
    assert.notEqual(after, before);
    results.push('client revision hash changes with cached client content');
    await db.query(
      'DELETE FROM client_memory_access WHERE tenant_id=$1 AND client_id=$2 AND user_id=$3',
      [T, id(2), U],
    );
    await check('grant revocation takes effect on next read', [1]);
    await db.query("UPDATE tenant_memberships SET status='suspended' WHERE user_id=$1", [U]);
    await check('inactive membership hides public clients too', []);
    await db.query('DELETE FROM tenant_memberships WHERE user_id=$1', [U]);
    await check('removed membership fails closed', []);
    await db.query("INSERT INTO tenant_memberships VALUES($1,$2,'active','admin')", [T2, U]);
    await check('other-tenant membership cannot authorize original tenant', []);
    await check('valid other-tenant membership remains tenant scoped', [5], 'clerk_owner', T2);
    const report = {
      complete: true,
      checks: results,
      sourceSha256: sha(helper),
      scriptSha256: sha(fs.readFileSync(__filename)),
      scope: 'Synthetic PostgreSQL query cases; not live RLS or effective privileges',
    };
    console.log(JSON.stringify(report));
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
