import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it('scopes real capability attachments, backfills only usable owners, and removes moved links', async () => {
  const db = new PGlite();
  const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [
    tenant,
    otherTenant,
    client,
    otherClient,
    capability,
    otherCapability,
    direct,
    converted,
    wrong,
    quarantined,
    actor,
    prospect,
  ] = Array.from({ length: 12 }, (_, i) => id(i + 1));
  try {
    await db.exec(`
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$;
      CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE ROLE capiro_app;
      CREATE TABLE clients(tenant_id uuid,id uuid,status text DEFAULT 'active',memory_wall boolean DEFAULT false,PRIMARY KEY(tenant_id,id));
      CREATE TABLE client_memory_access(tenant_id uuid,client_id uuid,user_id uuid);
      CREATE TABLE client_capabilities(tenant_id uuid,client_id uuid,id uuid,PRIMARY KEY(tenant_id,client_id,id));
      CREATE TABLE engagement_attachments(tenant_id uuid,id uuid,client_id uuid,prospect_id uuid,source text,lifecycle_status text,PRIMARY KEY(tenant_id,id));
      CREATE TABLE profile_attachment_link(tenant_id uuid,client_id uuid,prospect_id uuid,attachment_id uuid);
      GRANT SELECT ON clients,client_memory_access,engagement_attachments,profile_attachment_link TO capiro_app;
      INSERT INTO clients(tenant_id,id) VALUES('${tenant}','${client}'),('${tenant}','${otherClient}');
      INSERT INTO client_capabilities VALUES('${tenant}','${client}','${capability}'),('${tenant}','${otherClient}','${otherCapability}');
      INSERT INTO engagement_attachments VALUES
        ('${tenant}','${direct}','${client}',NULL,'capability:${capability}','ready'),
        ('${tenant}','${converted}',NULL,'${prospect}','capability:${capability}','legacy_ready'),
        ('${tenant}','${wrong}','${otherClient}',NULL,'capability:${capability}','ready'),
        ('${tenant}','${quarantined}','${client}',NULL,'capability:${capability}','quarantined');
      INSERT INTO profile_attachment_link VALUES('${tenant}','${client}','${prospect}','${converted}');
    `);
    await db.exec(
      readFileSync(
        resolve(
          process.cwd(),
          'prisma/migrations/20290110050000_portfolio_capability_documents/migration.sql',
        ),
        'utf8',
      ),
    );
    expect(
      (
        await db.query(
          'SELECT attachment_id FROM client_capability_documents ORDER BY attachment_id',
        )
      ).rows,
    ).toEqual([{ attachment_id: direct }, { attachment_id: converted }]);
    const insert =
      'INSERT INTO client_capability_documents(tenant_id,client_id,capability_id,attachment_id) VALUES($1,$2,$3,$4)';
    await expect(db.query(insert, [tenant, client, capability, wrong])).rejects.toThrow(
      'different profile',
    );
    await expect(db.query(insert, [tenant, otherClient, capability, wrong])).rejects.toThrow();
    await expect(db.query(insert, [otherTenant, client, capability, direct])).rejects.toThrow();
    // Newly confirmed documents may be quarantined; readiness is checked before research.
    await db.query(insert, [tenant, client, capability, quarantined]);
    await db.exec(
      `SET ROLE capiro_app; SET app.tenant_id='${otherTenant}'; SET app.user_id='${actor}'`,
    );
    expect((await db.query('SELECT id FROM client_capability_documents')).rows).toHaveLength(0);
    await db.exec(`SET app.tenant_id='${tenant}'`);
    expect((await db.query('SELECT id FROM client_capability_documents')).rows).toHaveLength(3);
    await db.exec(
      `RESET ROLE; UPDATE clients SET memory_wall=true WHERE id='${client}'; SET ROLE capiro_app`,
    );
    expect((await db.query('SELECT id FROM client_capability_documents')).rows).toHaveLength(0);
    await expect(db.query(insert, [tenant, client, capability, direct])).rejects.toThrow();
    await db.exec(
      `RESET ROLE; INSERT INTO client_memory_access VALUES('${tenant}','${client}','${actor}'); SET ROLE capiro_app`,
    );
    expect((await db.query('SELECT id FROM client_capability_documents')).rows).toHaveLength(3);
    await db.exec(
      `RESET ROLE; UPDATE engagement_attachments SET client_id='${otherClient}' WHERE id='${direct}'`,
    );
    expect(
      (
        await db.query('SELECT id FROM client_capability_documents WHERE attachment_id=$1', [
          direct,
        ])
      ).rows,
    ).toHaveLength(0);
    await db.exec(
      `UPDATE profile_attachment_link SET client_id='${otherClient}' WHERE attachment_id='${converted}'`,
    );
    expect(
      (
        await db.query('SELECT id FROM client_capability_documents WHERE attachment_id=$1', [
          converted,
        ])
      ).rows,
    ).toHaveLength(0);
    await db.exec(
      `UPDATE profile_attachment_link SET client_id='${client}' WHERE attachment_id='${converted}'`,
    );
    await db.query(insert, [tenant, client, capability, converted]);
    await db.exec(`DELETE FROM profile_attachment_link WHERE attachment_id='${converted}'`);
    expect(
      (
        await db.query('SELECT id FROM client_capability_documents WHERE attachment_id=$1', [
          converted,
        ])
      ).rows,
    ).toHaveLength(0);
    await db.exec(`DELETE FROM engagement_attachments WHERE id='${quarantined}'`);
    expect((await db.query('SELECT id FROM client_capability_documents')).rows).toHaveLength(0);
  } finally {
    await db.close();
  }
});
