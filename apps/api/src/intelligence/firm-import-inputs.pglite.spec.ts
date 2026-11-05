import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importRequestSha256 } from './firm-import-job.contracts.js';

it('adds import inputs without changing legacy identities, scope, or persisted request recovery', async () => {
  const db = new PGlite();
  const tenant = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  const actor = '20000000-0000-4000-8000-000000000001';
  const legacyHash = importRequestSha256(7, [10]);
  try {
    await db.exec(`CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$;
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE ROLE capiro_app;
      INSERT INTO tenants VALUES('${tenant}'),('${other}'); INSERT INTO users VALUES('${actor}');`);
    await db.exec(
      readFileSync(
        resolve(
          process.cwd(),
          'prisma/migrations/20281030140000_firm_import_job_status/migration.sql',
        ),
        'utf8',
      ),
    );
    await db.query(
      `INSERT INTO firm_import_jobs(tenant_id,requested_by_user_id,request_key,request_sha256,lda_registrant_id,requested_ids) VALUES($1,$2,'legacy',$3,7,ARRAY[10])`,
      [tenant, actor, legacyHash],
    );
    await db.exec(
      readFileSync(
        resolve(
          process.cwd(),
          'prisma/migrations/20290110040000_portfolio_import_inputs/migration.sql',
        ),
        'utf8',
      ),
    );
    expect(
      (
        await db.query(
          `SELECT request_sha256,request_jsonb FROM firm_import_jobs WHERE request_key='legacy'`,
        )
      ).rows,
    ).toEqual([{ request_sha256: legacyHash, request_jsonb: null }]);
    const request = { schemaVersion: 1, websites: { '10': 'https://company.example/' } };
    const insert = `INSERT INTO firm_import_jobs(tenant_id,requested_by_user_id,request_key,request_sha256,lda_registrant_id,requested_ids,request_jsonb) VALUES($1,$2,$3,$4,7,ARRAY[10],$5::jsonb)`;
    await db.query(insert, [
      tenant,
      actor,
      'website',
      importRequestSha256(7, [10], request.websites),
      JSON.stringify(request),
    ]);
    expect(
      (await db.query(`SELECT request_jsonb FROM firm_import_jobs WHERE request_key='website'`))
        .rows,
    ).toEqual([{ request_jsonb: request }]);
    for (const value of [
      'null',
      '[]',
      '{}',
      '{"schemaVersion":2,"websites":{}}',
      '{"schemaVersion":1,"websites":[]}',
    ])
      await expect(
        db.query(insert, [tenant, actor, 'invalid', legacyHash, value]),
      ).rejects.toThrow();
    await db.exec(`SET ROLE capiro_app; SET app.tenant_id='${other}'`);
    expect((await db.query('SELECT request_jsonb FROM firm_import_jobs')).rows).toEqual([]);
    await db.exec(`SET app.tenant_id='${tenant}'`);
    expect(
      (await db.query(`SELECT request_jsonb FROM firm_import_jobs WHERE request_key='website'`))
        .rows,
    ).toEqual([{ request_jsonb: request }]);
  } finally {
    await db.close();
  }
});
