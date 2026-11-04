'use strict';

// Release-only, disposable PostgreSQL 16 qualification. No production connection,
// Prisma deploy, migration replay, provider call, or persistent fixture cleanup.
// All fixture DDL/data/role creation lives in one transaction and is rolled back.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');

const migrations = [
  ['20290110010000_portfolio_subject_facts', '6484e231fb905bd7f09278272bfc9261b506a6af4fe82e624944e973f5e10036'],
  ['20290110020000_portfolio_capabilities_relationships', '770a9ae1acd62ae8bbf3ed58ff56dd48acd18b213cbd12027378d85f501878ae'],
  ['20290110030000_portfolio_geography', 'a40c03d838a294b247bec844a68ea8ac6ac9bac62e1b29aad2e471e4208fbf74'],
  ['20290110040000_portfolio_import_inputs', 'ef5af4bdb80d17984de92d81effb678c584a52407eaba63e3e11dd8747c00ee2'],
  ['20290110050000_portfolio_capability_documents', '360188f56505ea9cd962a685861419e219083f620fe99e021576db1746f9c48e'],
  ['20290110060000_portfolio_unknown_support', '479d90ed6aa64ca7c6145b6fedaafa88776de96e9b5ce7267bd77d42c71a2d40'],
];
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [tenant, otherTenant, actor, client, sibling, otherClient, prospect, capability, otherCapability,
  otherTenantCapability, target, otherTarget, facility, otherFacility, direct, converted, wrong, quarantined,
  entity, run] = [1, 2, 3, 11, 12, 21, 31, 41, 42, 43, 51, 52, 61, 62, 71, 72, 73, 74, 81, 91].map(id);
const tables = ['profile_fact', 'profile_fact_conflict', 'profile_entity_candidate', 'profile_attachment_link',
  'client_portfolio_proposals', 'client_capability_terms', 'client_capability_tracking', 'client_target_supports',
  'client_facility_capabilities', 'client_capability_documents'];
let checks = 0;
async function main() {
  assert.equal(process.env.PORTFOLIO_NATIVE_FIXTURE, 'isolated-disposable-pg16');
  const url = new URL(process.env.PORTFOLIO_NATIVE_TEST_DATABASE_URL || '');
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.pathname, '/portfolio_pr472');
  assert.equal(url.hostname, process.env.PORTFOLIO_NATIVE_EXPECTED_HOST);
  assert(['localhost', '127.0.0.1', 'portfolio-postgres'].includes(url.hostname), 'Use the isolated fixture alias');
  const db = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
  await db.connect();
  const q = (sql, args) => db.query(sql, args);
  const rows = async (sql, args) => (await q(sql, args)).rows;
  async function check(name, fn) { await fn(); checks++; console.log(JSON.stringify({ check: name, result: 'PASS' })); }
  async function rejects(sql, codes, args) {
    await q('SAVEPOINT expected_refusal');
    let error;
    try { await q(sql, args); } catch (e) { error = e; }
    await q('ROLLBACK TO SAVEPOINT expected_refusal');
    await q('RELEASE SAVEPOINT expected_refusal');
    assert(error && codes.includes(error.code), `Expected SQLSTATE ${codes}, received ${error?.code || 'success'}`);
  }
  let begun = false;
  try {
    assert.equal(Math.floor(Number((await rows('SHOW server_version_num'))[0].server_version_num) / 10000), 16);
    assert.equal((await rows('SELECT current_database() name'))[0].name, 'portfolio_pr472');
    assert.equal(Number((await rows("SELECT count(*) n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S')"))[0].n), 0, 'Fixture database must be empty');
    await q('BEGIN'); begun = true;
    await q("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'");
    await q(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
      CREATE ROLE capiro_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$`);
    const role = (await rows("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='capiro_app'"))[0];
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    // Minimal pre-expansion source contracts from the existing PGlite fixtures.
    // This proves the six SQL migrations and constraints, not a full serving-schema rehearsal.
    await q(`
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id',true),'')::uuid $$;
      CREATE FUNCTION current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE TABLE tenants(id uuid PRIMARY KEY);
      CREATE TABLE canonical_entities(id uuid PRIMARY KEY);
      CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),name text,website text,description text,product_description text,uei text,cage_code text,naics_codes text[] DEFAULT '{}',psc_codes text[] DEFAULT '{}',status text DEFAULT 'active',memory_wall boolean DEFAULT false,UNIQUE(tenant_id,id));
      CREATE TABLE business_development_prospects(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),display_name text,website text,description text,UNIQUE(tenant_id,id));
      CREATE TABLE client_memory_access(tenant_id uuid,client_id uuid,user_id uuid);
      CREATE TABLE engagement_attachments(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid,prospect_id uuid,source text,lifecycle_status text);
      CREATE TABLE client_profile_fill_run(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid NOT NULL,created_at timestamptz DEFAULT now(),UNIQUE(id,tenant_id,client_id));
      CREATE TABLE client_profile_fill_task(id uuid PRIMARY KEY,run_id uuid NOT NULL,tenant_id uuid NOT NULL,client_id uuid NOT NULL,FOREIGN KEY(run_id,tenant_id,client_id) REFERENCES client_profile_fill_run(id,tenant_id,client_id));
      CREATE TABLE client_profile_fill_extension_task(LIKE client_profile_fill_task INCLUDING ALL);
      ALTER TABLE client_profile_fill_extension_task ADD FOREIGN KEY(run_id,tenant_id,client_id) REFERENCES client_profile_fill_run(id,tenant_id,client_id);
      CREATE TABLE client_profile_fill_finding(LIKE client_profile_fill_task INCLUDING ALL);
      ALTER TABLE client_profile_fill_finding ADD FOREIGN KEY(run_id,tenant_id,client_id) REFERENCES client_profile_fill_run(id,tenant_id,client_id);
      CREATE TABLE client_capabilities(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid NOT NULL,name text);
      CREATE TABLE client_targets(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid NOT NULL,source_directory text,member_id text);
      CREATE UNIQUE INDEX client_targets_client_member_key ON client_targets(client_id,member_id);
      CREATE TABLE client_facilities(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,client_id uuid NOT NULL,congressional_district text);
      CREATE TABLE firm_import_jobs(id uuid PRIMARY KEY,request_digest text NOT NULL);
      GRANT USAGE ON SCHEMA public TO capiro_app;
      GRANT SELECT ON clients,client_memory_access,engagement_attachments TO capiro_app;
      INSERT INTO tenants VALUES('${tenant}'),('${otherTenant}'); INSERT INTO canonical_entities VALUES('${entity}');
      INSERT INTO clients(id,tenant_id,name) VALUES('${client}','${tenant}','Legacy client'),('${sibling}','${tenant}','Sibling'),('${otherClient}','${otherTenant}','Other tenant');
      INSERT INTO business_development_prospects(id,tenant_id,display_name) VALUES('${prospect}','${tenant}','Legacy prospect');
      INSERT INTO client_profile_fill_run(id,tenant_id,client_id) VALUES('${run}','${tenant}','${client}');
      INSERT INTO client_profile_fill_task VALUES('${id(92)}','${run}','${tenant}','${client}');
      INSERT INTO client_profile_fill_extension_task VALUES('${id(93)}','${run}','${tenant}','${client}');
      INSERT INTO client_profile_fill_finding VALUES('${id(94)}','${run}','${tenant}','${client}');
      INSERT INTO client_capabilities VALUES('${capability}','${tenant}','${client}','Existing capability'),('${otherCapability}','${tenant}','${sibling}','Sibling capability'),('${otherTenantCapability}','${otherTenant}','${otherClient}','Other capability');
      INSERT INTO client_targets VALUES('${target}','${tenant}','${client}','congress','member-a'),('${otherTarget}','${otherTenant}','${otherClient}','congress','member-b');
      INSERT INTO client_facilities VALUES('${facility}','${tenant}','${client}','02'),('${otherFacility}','${otherTenant}','${otherClient}','03');
      INSERT INTO firm_import_jobs VALUES('${id(95)}','original-digest');
      INSERT INTO engagement_attachments VALUES
        ('${direct}','${tenant}','${client}',NULL,'capability:${capability}','ready'),
        ('${converted}','${tenant}',NULL,'${prospect}','capability:${capability}','legacy_ready'),
        ('${wrong}','${tenant}','${sibling}',NULL,'capability:${capability}','ready'),
        ('${quarantined}','${tenant}','${client}',NULL,'capability:${capability}','quarantined');
    `);
    const applied = [];
    for (const [name, sha256] of migrations) {
      const sql = readFileSync(path.join(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(createHash('sha256').update(sql).digest('hex'), sha256);
      await check(`apply exact ${name}`, () => q(sql)); applied.push({ name, sha256 });
      if (name === migrations[0][0]) {
        await check('legacy client/prospect provenance and existing run/task rows preserved', async () => {
          assert.equal(Number((await rows("SELECT count(*) n FROM profile_fact WHERE origin='legacy' AND status='approved' AND is_current AND source_url IS NULL AND confidence IS NULL AND approved_at IS NULL"))[0].n), 4);
          for (const table of ['client_profile_fill_run','client_profile_fill_task','client_profile_fill_extension_task','client_profile_fill_finding'])
            assert.equal(Number((await rows(`SELECT count(*) n FROM ${table} WHERE tenant_id=$1 AND client_id=$2 AND prospect_id IS NULL`, [tenant, client]))[0].n), 1);
        });
        await q('INSERT INTO profile_attachment_link(tenant_id,client_id,prospect_id,attachment_id) VALUES($1,$2,$3,$4)', [tenant, client, prospect, converted]);
      }
      if (name === migrations[1][0]) {
        await q(`INSERT INTO client_target_supports(tenant_id,client_id,target_id,capability_id,stance,evidence,history,approved_by_user_id,approved_at,version)
          VALUES($1,$2,$3,$4,'supportive','["source"]','["person review"]',$5,'2026-01-01T00:00:00Z',7)`, [tenant,client,target,capability,actor]);
      }
    }
    await check('capability/target/facility/import expansion preserves legacy values and honest defaults', async () => {
      assert.deepEqual((await rows('SELECT name,lifecycle,review_status,provenance,version FROM client_capabilities WHERE id=$1',[capability]))[0],
        {name:'Existing capability',lifecycle:'unspecified',review_status:'legacy',provenance:[],version:1});
      assert.deepEqual((await rows('SELECT relationship_status,stance,office_term,version,history FROM client_targets WHERE id=$1',[target]))[0],
        {relationship_status:'uncontacted',stance:'unknown',office_term:'unknown',version:1,history:[]});
      assert.deepEqual((await rows('SELECT congressional_district,site_verification_status,country,geographic_resolution_jsonb FROM client_facilities WHERE id=$1',[facility]))[0],
        {congressional_district:'02',site_verification_status:'unverified',country:null,geographic_resolution_jsonb:null});
      assert.deepEqual((await rows('SELECT request_digest,request_jsonb FROM firm_import_jobs'))[0],{request_digest:'original-digest',request_jsonb:null});
    });
    await check('unknown stance migration preserves reviewed history/version and expands default', async () => {
      assert.deepEqual((await rows('SELECT stance,history,version FROM client_target_supports'))[0],{stance:'supportive',history:['person review'],version:7});
      assert.equal((await rows("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='client_target_supports' AND column_name='stance'"))[0].column_default,"'unknown'::text");
      await q(`INSERT INTO client_target_supports(tenant_id,client_id,target_id,capability_id,evidence,approved_by_user_id,approved_at) VALUES($1,$2,$3,$4,'["source"]',$5,now())`,[otherTenant,otherClient,otherTarget,otherTenantCapability,actor]);
      assert.equal((await rows('SELECT stance FROM client_target_supports WHERE tenant_id=$1',[otherTenant]))[0].stance,'unknown');
      for(const stance of ['unknown','interested','supportive','champion','declined']) await q('UPDATE client_target_supports SET stance=$1 WHERE tenant_id=$2',[stance,otherTenant]);
      await rejects("UPDATE client_target_supports SET stance='invented'",['23514']);
      await rejects('UPDATE client_target_supports SET stance=NULL',['23502']);
    });
    await check('capability document backfill includes direct/converted ready files only', async () => {
      assert.deepEqual((await rows('SELECT attachment_id FROM client_capability_documents ORDER BY attachment_id')).map(r=>r.attachment_id),[direct,converted]);
      await rejects('INSERT INTO client_capability_documents(tenant_id,client_id,capability_id,attachment_id) VALUES($1,$2,$3,$4)',['23514'],[tenant,client,capability,wrong]);
      await rejects('INSERT INTO client_capability_documents(tenant_id,client_id,capability_id,attachment_id) VALUES($1,$2,$3,$4)',['23503'],[tenant,sibling,capability,wrong]);
    });
    await check('prospect run/task scope and mixed subject foreign keys refuse invalid subjects', async () => {
      await q('INSERT INTO client_profile_fill_run(id,tenant_id,prospect_id) VALUES($1,$2,$3)',[id(96),tenant,prospect]);
      await q('INSERT INTO client_profile_fill_task(id,run_id,tenant_id,prospect_id) VALUES($1,$2,$3,$4)',[id(97),id(96),tenant,prospect]);
      await rejects('INSERT INTO client_profile_fill_run(id,tenant_id,client_id,prospect_id) VALUES($1,$2,$3,$4)',['23514'],[id(98),tenant,client,prospect]);
      await rejects('INSERT INTO client_profile_fill_run(id,tenant_id,prospect_id) VALUES($1,$2,$3)',['23503'],[id(98),otherTenant,prospect]);
      await rejects('INSERT INTO client_profile_fill_task(id,run_id,tenant_id,prospect_id) VALUES($1,$2,$3,$4)',['23503'],[id(98),run,tenant,prospect]);
    });
    await check('new compound facility/capability scope and import shape constraints are enforced', async () => {
      await q('INSERT INTO client_facility_capabilities(tenant_id,client_id,facility_id,capability_id) VALUES($1,$2,$3,$4)',[tenant,client,facility,capability]);
      await rejects('INSERT INTO client_facility_capabilities(tenant_id,client_id,facility_id,capability_id) VALUES($1,$2,$3,$4)',['23503'],[tenant,client,facility,otherCapability]);
      for(const value of ['[]','{}','{"schemaVersion":2,"websites":{}}','{"schemaVersion":1,"websites":[]}'])
        await rejects('UPDATE firm_import_jobs SET request_jsonb=$1::jsonb',['23514'],[value]);
      await q(`UPDATE firm_import_jobs SET request_jsonb='{"schemaVersion":1,"websites":{}}'`);
      await rejects("UPDATE client_facilities SET site_verification_status='invented'",['23514']);
    });
    await q(`INSERT INTO profile_fact(tenant_id,client_id,field_key,value_jsonb,origin,status,origin_id) VALUES($1,$2,'name','"Proposal"','research','pending','candidate')`,[tenant,client]);
    await q(`INSERT INTO profile_fact_conflict(tenant_id,client_id,field_key,current_fact_id,proposed_fact_id)
      SELECT $1,$2,'name',a.id,b.id FROM profile_fact a,profile_fact b WHERE a.client_id=$2 AND a.is_current AND b.origin_id='candidate'`,[tenant,client]);
    await q('INSERT INTO profile_entity_candidate(tenant_id,client_id,canonical_entity_id) VALUES($1,$2,$3)',[tenant,client,entity]);
    const proposal=(await rows(`INSERT INTO client_portfolio_proposals(tenant_id,client_id,kind,dedupe_key,payload,evidence) VALUES($1,$2,'capability','candidate','{}','["source"]') RETURNING id`,[tenant,client]))[0].id;
    const term=(await rows(`INSERT INTO client_capability_terms(tenant_id,client_id,capability_id,kind,value,evidence,approved_by_user_id,approved_at) VALUES($1,$2,$3,'keyword','test','["source"]',$4,now()) RETURNING id`,[tenant,client,capability,actor]))[0].id;
    await q(`INSERT INTO client_capability_tracking(tenant_id,client_id,capability_id,item_kind,item_id,term_ids) VALUES($1,$2,$3,'bill','fixture',$4::jsonb)`,[tenant,client,capability,JSON.stringify([term])]);
    await check('review history and approved-term scope guards retain provenance', async () => {
      await q(`UPDATE client_portfolio_proposals SET status='rejected',version=2,review_history='["rejected"]' WHERE id=$1`,[proposal]);
      await rejects(`UPDATE client_portfolio_proposals SET version=3,review_history='[]' WHERE id=$1`,['23514'],[proposal]);
      await rejects(`UPDATE client_portfolio_proposals SET version=3,status='approved' WHERE id=$1`,['23514'],[proposal]);
      await rejects(`INSERT INTO client_capability_tracking(tenant_id,client_id,capability_id,item_kind,item_id,term_ids) VALUES($1,$2,$3,'bill','wrong',$4::jsonb)`,['23514'],[tenant,sibling,otherCapability,JSON.stringify([term])]);
    });
    await check('every new table enables and forces RLS with ordinary-role grants', async () => {
      for (const table of tables) {
        const r=(await rows('SELECT relrowsecurity,relforcerowsecurity,has_table_privilege($1,oid,\'SELECT\') can_read FROM pg_class WHERE oid=$2::regclass',['capiro_app',table]))[0];
        assert.deepEqual(r,{relrowsecurity:true,relforcerowsecurity:true,can_read:true},table);
      }
    });
    await q('SET LOCAL ROLE capiro_app');
    await q("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[tenant,actor]);
    await check('ordinary app role reads own rows and cannot see another tenant on any new table', async () => {
      assert.equal((await rows('SELECT current_user name'))[0].name,'capiro_app');
      for(const table of tables) {
        const visible=await rows(`SELECT tenant_id FROM ${table}`);
        assert(visible.length>0,`${table} fixture has own rows`);
        assert(visible.every(r=>r.tenant_id===tenant),`${table} tenant fence`);
      }
      await rejects(`INSERT INTO profile_fact(tenant_id,client_id,field_key,value_jsonb,origin,status,origin_id) VALUES($1,$2,'x','1','person','approved','cross')`,['42501'],[otherTenant,otherClient]);
      await rejects(`INSERT INTO client_portfolio_proposals(tenant_id,client_id,kind,dedupe_key,payload,evidence) VALUES($1,$2,'capability','cross','{}','["source"]')`,['42501'],[otherTenant,otherClient]);
    });
    await q("SELECT set_config('app.tenant_id',$1,true)",[otherTenant]);
    await check('changing tenant hides original-tenant rows on every new table', async () => {
      for(const table of tables) assert((await rows(`SELECT tenant_id FROM ${table}`)).every(r=>r.tenant_id===otherTenant),table);
    });
    await q('RESET ROLE'); await q('UPDATE clients SET memory_wall=true WHERE id=$1',[client]);
    await q('SET LOCAL ROLE capiro_app'); await q("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
    await check('ethical wall blocks capability/proposal/relationship/facility/document children', async () => {
      for(const table of tables.slice(4)) assert.equal((await rows(`SELECT id FROM ${table}`)).length,0,table);
      await rejects(`INSERT INTO client_portfolio_proposals(tenant_id,client_id,kind,dedupe_key,payload,evidence) VALUES($1,$2,'capability','walled','{}','["source"]')`,['42501'],[tenant,client]);
    });
    await q('RESET ROLE'); await q('INSERT INTO client_memory_access VALUES($1,$2,$3)',[tenant,client,actor]); await q('SET LOCAL ROLE capiro_app');
    await check('explicit current actor wall grant restores children', async () => {
      for(const table of tables.slice(4)) assert((await rows(`SELECT id FROM ${table}`)).length>0,table);
    });
    await q('RESET ROLE');
    await check('file reassignment and converted-link removal remove only old associations', async () => {
      await q('UPDATE engagement_attachments SET client_id=$1 WHERE id=$2',[sibling,direct]);
      assert.equal((await rows('SELECT id FROM client_capability_documents WHERE attachment_id=$1',[direct])).length,0);
      assert.equal((await rows('SELECT id FROM client_capability_documents WHERE attachment_id=$1',[converted])).length,1);
      await q('DELETE FROM profile_attachment_link WHERE attachment_id=$1',[converted]);
      assert.equal((await rows('SELECT id FROM client_capability_documents WHERE attachment_id=$1',[converted])).length,0);
      assert.equal(Number((await rows('SELECT count(*) n FROM engagement_attachments'))[0].n),4,'source files preserved');
    });
    await q('ROLLBACK'); begun=false;
    assert.equal(Number((await rows("SELECT count(*) n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S')"))[0].n),0);
    console.log(JSON.stringify({ result:'PASS', checks, postgresMajor:16, migrations:applied, rollbackConfirmed:true,
      limitations:['Minimal pre-expansion schema, not a full serving database clone','No application E2E, provider, deployment or image acceptance'] }));
  } finally {
    try { if(begun) await q('ROLLBACK'); } finally { await db.end(); }
  }
}
main().catch(error => { console.error(JSON.stringify({ result:'FAIL', checks, sqlState:error.code || null, error:error.message })); process.exitCode=1; });
