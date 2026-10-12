import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20281011010000_client_objectives/migration.sql'),
  'utf8',
);
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const clientA = '33333333-3333-4333-8333-333333333333';
const clientB = '44444444-4444-4444-8444-444444444444';
const actor = '55555555-5555-4555-8555-555555555555';
const objectiveA = '66666666-6666-4666-8666-666666666666';
const objectiveB = '77777777-7777-4777-8777-777777777777';

describe('Objective migration on local ephemeral PostgreSQL (PGlite)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE capiro_app;
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $$;
      CREATE TABLE tenants(id uuid PRIMARY KEY);
      CREATE TABLE clients(id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), UNIQUE(tenant_id,id));
    `);
    await db.query('INSERT INTO tenants VALUES ($1), ($2)', [tenantA, tenantB]);
    await db.query('INSERT INTO clients VALUES ($1,$2),($3,$4)', [
      clientA,
      tenantA,
      clientB,
      tenantB,
    ]);
    await db.exec(migration);
    await db.query(
      `INSERT INTO client_objectives(id,tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash)
      VALUES($1,$2,$3,$4,gen_random_uuid(),repeat('a',64)),($5,$6,$7,$4,gen_random_uuid(),repeat('b',64))`,
      [objectiveA, tenantA, clientA, actor, objectiveB, tenantB, clientB],
    );
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });
  afterEach(async () => {
    await db.exec('RESET ROLE');
  });

  test('migration is LF-exact and additive: both preexisting clients remain unchanged', async () => {
    expect(migration).not.toContain('\r');
    expect((await db.query('SELECT id FROM clients ORDER BY id')).rows).toEqual([
      { id: clientA },
      { id: clientB },
    ]);
  });

  test('composite foreign key rejects a client from another tenant even for the database owner', async () => {
    await expect(
      db.query(
        `INSERT INTO client_objectives(tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash) VALUES($1,$2,$3,gen_random_uuid(),repeat('c',64))`,
        [tenantA, clientB, actor],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('real SQL allows partial drafts and refuses Ready until exactly four fields exist', async () => {
    await expect(
      db.query(`UPDATE client_objectives SET status='ready' WHERE id=$1`, [objectiveA]),
    ).rejects.toMatchObject({ code: '23514' });
    await db.query(
      `UPDATE client_objectives SET outcome='Extend authority',government_problem='Authority expires',
      ask_type='meri_propose',minimum_win='One year',status='ready' WHERE id=$1`,
      [objectiveA],
    );
    expect(
      (await db.query('SELECT status,limits FROM client_objectives WHERE id=$1', [objectiveA]))
        .rows,
    ).toEqual([{ status: 'ready', limits: '' }]);
  });

  test('runtime role sees only its tenant and cannot write a foreign tenant', async () => {
    await db.exec('SET ROLE capiro_app');
    await db.query(`SELECT set_config('app.current_tenant',$1,false)`, [tenantA]);
    expect((await db.query('SELECT id FROM client_objectives')).rows).toEqual([{ id: objectiveA }]);
    expect(
      (
        await db.query('UPDATE client_objectives SET limits=$1 WHERE id=$2 RETURNING id', [
          'forbidden',
          objectiveB,
        ])
      ).rows,
    ).toEqual([]);
    await expect(
      db.query(
        `INSERT INTO client_objectives(tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash) VALUES($1,$2,$3,gen_random_uuid(),repeat('c',64))`,
        [tenantB, clientB, actor],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  test('revision scope and unique version preserve lineage; runtime role cannot rewrite revisions', async () => {
    await db.query(
      `INSERT INTO client_objective_revisions(tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
      VALUES($1,$2,$3,1,'create',$4,'{}')`,
      [tenantA, clientA, objectiveA, actor],
    );
    await expect(
      db.query(
        `INSERT INTO client_objective_revisions(tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
      VALUES($1,$2,$3,1,'edit',$4,'{}')`,
        [tenantA, clientA, objectiveA, actor],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      db.query(
        `INSERT INTO client_objective_revisions(tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
      VALUES($1,$2,$3,2,'edit',$4,'{}')`,
        [tenantB, clientB, objectiveA, actor],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await db.exec('SET ROLE capiro_app');
    await db.query(`SELECT set_config('app.current_tenant',$1,false)`, [tenantA]);
    await expect(
      db.query('UPDATE client_objective_revisions SET snapshot=$1', ['{}']),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(db.query('DELETE FROM client_objective_revisions')).rejects.toMatchObject({
      code: '42501',
    });
    await db.query(`SELECT set_config('app.current_tenant',$1,false)`, [tenantB]);
    expect((await db.query('SELECT id FROM client_objective_revisions')).rows).toEqual([]);
  });

  test('creation key deduplicates retries within the same tenant/client', async () => {
    const result = await db.query(
      `INSERT INTO client_objectives(tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash)
      SELECT tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash FROM client_objectives WHERE id=$1
      ON CONFLICT DO NOTHING RETURNING id`,
      [objectiveA],
    );
    expect(result.rows).toEqual([]);
    expect(
      (await db.query('SELECT id FROM client_objectives WHERE tenant_id=$1', [tenantA])).rows,
    ).toEqual([{ id: objectiveA }]);
  });

  test('version predicate admits one edit and refuses a competing stale edit', async () => {
    const first = await db.query(
      'UPDATE client_objectives SET version=version+1,limits=$1 WHERE id=$2 AND version=1 RETURNING version',
      ['First', objectiveA],
    );
    const competing = await db.query(
      'UPDATE client_objectives SET version=version+1,limits=$1 WHERE id=$2 AND version=1 RETURNING version',
      ['Second', objectiveA],
    );
    expect(first.rows).toEqual([{ version: 2 }]);
    expect(competing.rows).toEqual([]);
    expect(
      (await db.query('SELECT limits FROM client_objectives WHERE id=$1', [objectiveA])).rows,
    ).toEqual([{ limits: 'First' }]);
  });

  test('revision failure rolls back its Objective write in the same real transaction', async () => {
    await db.exec('BEGIN');
    try {
      await db.query('UPDATE client_objectives SET version=2 WHERE id=$1', [objectiveB]);
      const insert = `INSERT INTO client_objective_revisions(tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
        VALUES($1,$2,$3,2,'edit',$4,'{}')`;
      await db.query(insert, [tenantB, clientB, objectiveB, actor]);
      await expect(db.query(insert, [tenantB, clientB, objectiveB, actor])).rejects.toMatchObject({
        code: '23505',
      });
    } finally {
      await db.exec('ROLLBACK');
    }
    expect(
      (await db.query('SELECT version FROM client_objectives WHERE id=$1', [objectiveB])).rows,
    ).toEqual([{ version: 1 }]);
    expect(
      (
        await db.query('SELECT id FROM client_objective_revisions WHERE objective_id=$1', [
          objectiveB,
        ])
      ).rows,
    ).toEqual([]);
  });
});
