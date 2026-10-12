'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { apiRequire, verifyBindings, loadCanonical } = require('./canonical-loader.cjs');
const { assembleFixture } = require('./fixture-assembly.cjs');
const SOURCE_HEAD = '277053c8196dc1be4789c42ea304b0de0553fe00';
const TARGET = Object.freeze({
  dataDirectory: '/tmp/capiro-native-pg-pr2429-20261012/data',
  socketDirectory: '/tmp/capiro-native-pg-socket-pr2429-20261012',
  port: 5432, user: 'agent', database: 'postgres',
  systemIdentifier: '7695922344929406966', listenAddresses: '', inetServerAddr: null,
});
const SCHEMA = 'capiro_native_contract_pr2429_20261012';
const OWNER = 'capiro_native_contract_owner_20261012';
const APP = 'capiro_app';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const I = { tenant: id(1), otherTenant: id(2), user: id(3), otherUser: id(4), client: id(5), otherClient: id(6), objective: id(7), otherObjective: id(8), revision: id(9), draft: id(10), version: id(11), session: id(12), request: id(13), grant: id(14), collaborator: id(15) };
const ctx = { tenantId: I.tenant, userId: I.user, clerkUserId: 'user_native_synthetic', tenantSlug: 'native-synthetic', role: 'standard_user' };

function validateTarget(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Verified target receipt required');
  for (const key of ['dataDirectory', 'user', 'database', 'systemIdentifier', 'listenAddresses', 'inetServerAddr'])
    if (receipt[key] !== TARGET[key]) throw new Error(`Verified target mismatch: ${key}`);
  if (!receipt.version?.startsWith('PostgreSQL 16.15 ') || receipt.publicTables !== 0)
    throw new Error('Exact fresh PostgreSQL target receipt required');
  if ('password' in receipt || 'connectionString' in receipt || 'url' in receipt)
    throw new Error('Credential/URL input refused');
  if (fs.realpathSync(TARGET.dataDirectory) !== TARGET.dataDirectory || fs.realpathSync(TARGET.socketDirectory) !== TARGET.socketDirectory)
    throw new Error('Owned target path must not be a symlink');
  return TARGET;
}
function boundTag(strings, values) {
  assert(Array.isArray(strings) && Array.isArray(strings.raw), 'Tagged SQL required');
  assert.equal(strings.length, values.length + 1);
  return { text: strings.map((s, i) => s + (i < values.length ? `$${i + 1}` : '')).join(''), values };
}
function adapter(client, observer = async () => {}) {
  async function query(text, values = [], execute = false) {
    const result = await client.query(text, values);
    await observer({ text, values, result });
    return execute ? result.rowCount : result.rows;
  }
  const tx = {
    $queryRaw: (strings, ...values) => { const q = boundTag(strings, values); return query(q.text, q.values); },
    $executeRaw: (strings, ...values) => { const q = boundTag(strings, values); return query(q.text, q.values, true); },
    $queryRawUnsafe: (text, ...values) => query(text, values),
    client: { findFirst: async (args) => {
      assert.deepEqual(Object.keys(args.where).sort(), ['id', 'tenantId']);
      assert.deepEqual(Object.keys(args.select).sort(), ['description', 'id', 'name', 'sectorTag', 'status', 'updatedAt', 'website']);
      return (await query(`SELECT id,name,website,description,sector_tag AS "sectorTag",status,updated_at AS "updatedAt" FROM clients WHERE id=$1::uuid AND tenant_id=$2::uuid LIMIT 1`, [args.where.id, args.where.tenantId]))[0] ?? null;
    } },
    syncRun: { findFirst: async (args) => {
      assert.deepEqual(Object.keys(args.where), ['source']);
      assert.deepEqual(args.orderBy, { startedAt: 'desc' });
      assert.deepEqual(Object.keys(args.select).sort(), ['errorCount', 'finishedAt', 'rowsUpdated', 'source', 'startedAt', 'stats', 'status']);
      return (await query(`SELECT source,started_at AS "startedAt",finished_at AS "finishedAt",rows_updated AS "rowsUpdated",error_count AS "errorCount",stats_jsonb AS stats,status FROM sync_run WHERE source=$1 ORDER BY started_at DESC LIMIT 1`, [args.where.source]))[0] ?? null;
    } },
  };
  return tx;
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function guardedPending(promise) { return promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })); }
async function expectCode(action, code) { await assert.rejects(action, (e) => e.code === code, `Expected ${code}`); }

async function runNative(receipt, output) {
  validateTarget(receipt);
  const manifest = verifyBindings();
  assert.equal(manifest.sourceHead, SOURCE_HEAD);
  const owners = loadCanonical();
  const { Client } = apiRequire('pg'); // Driver loaded only after explicit --run and target guard.
  const open = new Set();
  const results = [];
  let admin;
  let schemaCreated = false;
  let rolesCreated = false;
  async function connect(label) {
    const client = new Client({ host: TARGET.socketDirectory, port: TARGET.port, user: TARGET.user,
      database: TARGET.database, password: '', ssl: false, application_name: `capiro-native-contract-${label}`,
      connectionTimeoutMillis: 3000, query_timeout: 15000 });
    await client.connect(); open.add(client);
    const [actual] = (await client.query(`SELECT current_setting('data_directory') AS "dataDirectory",current_setting('listen_addresses') AS "listenAddresses",inet_server_addr() AS "inetServerAddr",current_user AS "user",current_database() AS "database",system_identifier::text AS "systemIdentifier" FROM pg_control_system()`)).rows;
    for (const key of ['dataDirectory', 'listenAddresses', 'inetServerAddr', 'user', 'database', 'systemIdentifier'])
      assert.equal(actual[key], TARGET[key], `Connected target mismatch: ${key}`);
    await client.query(`SET statement_timeout='12s'; SET lock_timeout='10s'; SET TIME ZONE 'UTC'; SET search_path=${SCHEMA},public;`);
    return client;
  }
  async function close(client) { open.delete(client); await client.end(); }
  async function appTransaction(fn, actor = ctx, observer) {
    const client = await connect('app');
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${APP}`);
      await client.query(`SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true),set_config('app.bypass_rls','off',true)`, [actor.tenantId, actor.userId]);
      const result = await fn(adapter(client, observer), client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { await close(client); }
  }
  const nativePrisma = {
    withTenantUser: (tenantId, userId, fn) => appTransaction(fn, { ...ctx, tenantId, userId }),
    $transaction: async (fn, options) => {
      assert.equal(options?.isolationLevel, 'RepeatableRead');
      const client = await connect('calendar');
      try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); const value = await fn(adapter(client)); await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { await close(client); }
    },
  };
  const repository = new owners.repository();
  const authorization = new owners.authorization(nativePrisma);
  const forbidden = new Proxy({}, { get() { throw new Error('External provider/reference port refused'); } });
  const engine = new owners.engine(nativePrisma, repository, authorization, forbidden, forbidden);
  const calendar = new owners.calendar(nativePrisma);
  const hash = (snapshot) => createHash('sha256').update(owners.workspace.canonicalWorkspaceSnapshot(snapshot)).digest('hex');
  const snapshot = { docTitle: 'Synthetic saved newsletter', config: { clientId: I.client, sections: ['Update'], sectionContent: { Update: '<p>Exact synthetic text.</p>' } }, documents: [{ id: id(16), body: { blocks: [] } }] };
  const stageInput = () => ({ requestId: I.request, draftId: I.draft, versionId: I.version, snapshotHash: hash(snapshot), expectedStateVersion: 1 });
  const objectiveInput = { clientId: I.client, objectiveId: I.objective, objectiveVersion: 1 };
  const wsInput = { tenantId: I.tenant, userId: I.user, clerkUserId: ctx.clerkUserId, draftId: I.draft, versionId: I.version };
  async function record(name, fn) {
    try { const details = await fn(); results.push({ name, status: 'PASS', details: details ?? null }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, status: 'FAIL', error: { message: error.message, code: error.code ?? null, stack: error.stack } }); console.error(`FAIL ${name}: ${error.code ?? ''} ${error.message}`); throw error; }
  }
  async function seed() {
    await admin.query(`INSERT INTO tenants(id) VALUES($1),($2);`, [I.tenant, I.otherTenant]);
    await admin.query(`INSERT INTO users(id,clerk_user_id) VALUES($1,$2),($3,'user_native_other')`, [I.user, ctx.clerkUserId, I.otherUser]);
    await admin.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'standard_user','active'),($3,$4,'standard_user','active')`, [I.tenant,I.user,I.otherTenant,I.otherUser]);
    await admin.query(`INSERT INTO clients(id,tenant_id,name,memory_wall) VALUES($1,$2,'synthetic A',true),($3,$4,'synthetic B',false)`, [I.client,I.tenant,I.otherClient,I.otherTenant]);
    await admin.query(`INSERT INTO client_memory_access(id,tenant_id,client_id,user_id) VALUES($1,$2,$3,$4)`, [I.grant,I.tenant,I.client,I.user]);
    for (const [objective, tenant, client] of [[I.objective,I.tenant,I.client],[I.otherObjective,I.otherTenant,I.otherClient]]) {
      await admin.query(`INSERT INTO client_objectives(id,tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash) VALUES($1,$2,$3,$4,gen_random_uuid(),repeat('a',64))`, [objective,tenant,client,I.user]);
      await admin.query(`INSERT INTO client_objective_revisions(id,tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot) VALUES($1,$2,$3,$4,1,'create',$5,'{}')`, [objective === I.objective ? I.revision : id(19),tenant,client,objective,I.user]);
    }
    await admin.query(`INSERT INTO ws_draft(id,tenant_id,owner_id,doc_title,config,updated_at) VALUES($1,$2,$3,'Synthetic saved newsletter',$4::jsonb,now())`, [I.draft,I.tenant,ctx.clerkUserId,JSON.stringify(snapshot.config)]);
    await admin.query(`INSERT INTO ws_doc_version(id,tenant_id,draft_id,author_id,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)`, [I.version,I.tenant,I.draft,ctx.clerkUserId,JSON.stringify(snapshot)]);
    const spec = owners.campaign.createBlankCampaignSpecV1();
    spec.sponsor = { kind: 'client', label: null, clientRefs: [{ clientId: I.client }] };
    await admin.query(`INSERT INTO outreach_sessions(id,tenant_id,created_by_user_id) VALUES($1,$2,$3)`, [I.session,I.tenant,I.user]);
    await admin.query(`INSERT INTO outreach_state_versions(tenant_id,session_id,version,schema_version,spec_jsonb,spec_hash,created_by_user_id) VALUES($1,$2,1,$3,$4::jsonb,$5,$6)`, [I.tenant,I.session,spec.schemaVersion,JSON.stringify(spec),owners.campaign.hashCampaignSpecV1(spec),I.user]);
  }
  async function rows(sql, params = []) { return (await admin.query(sql,params)).rows; }
  async function waitBlocked(waiter, blocker) {
    const until = Date.now()+4000;
    while (Date.now()<until) {
      const [row] = await rows(`SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked`, [waiter,blocker]);
      if (row.blocked) return;
      await new Promise((r) => setTimeout(r,25));
    }
    throw new Error('Expected native row-lock wait was not observed');
  }
  try {
    admin = await connect('admin');
    assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1`,[SCHEMA]))[0].n,0,'Fixture schema must be absent');
    const existing = await rows(`SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])`,[[APP,OWNER]]);
    assert.equal(existing.length,0,'Fresh synthetic roles required; refuse adoption of unknown roles');
    // Root authorized these task-only NOLOGIN roles. No password/LOGIN/DB create.
    await admin.query(`CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; CREATE ROLE ${APP} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${OWNER}; GRANT USAGE ON SCHEMA ${SCHEMA} TO ${APP};`);
    schemaCreated = true;
    rolesCreated = true;
    await record('strict synthetic application role has no owner membership or bypass',async()=>{
      const [role] = await rows(`SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,pg_has_role($1,$2,'MEMBER') AS owner_member FROM pg_roles WHERE rolname=$1`,[APP,OWNER]);
      assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolbypassrls:false,rolinherit:false,rolcreatedb:false,rolcreaterole:false,owner_member:false}); return role;
    });
    await admin.query(`SET ROLE ${OWNER}`);
    for (const part of assembleFixture()) await admin.query(part.sql);
    await admin.query('RESET ROLE');
    await seed();
    await record('Objective tenant RLS, missing GUC and foreign write',async()=>{
      const visible=await appTransaction((tx)=>tx.$queryRawUnsafe('SELECT id FROM client_objectives ORDER BY id'));
      assert.deepEqual(visible,[{id:I.objective}]);
      await appTransaction(async(tx,client)=>{await client.query(`SELECT set_config('app.current_tenant','',true)`);assert.deepEqual(await tx.$queryRawUnsafe('SELECT id FROM client_objectives'),[]);});
      await expectCode(()=>appTransaction((tx)=>tx.$queryRawUnsafe(`INSERT INTO client_objectives(tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash) VALUES($1,$2,$3,gen_random_uuid(),repeat('a',64))`,I.otherTenant,I.otherClient,I.user)),'42501');
    });
    await record('Objective constraints and immutable revision locking privileges',async()=>{
      await expectCode(()=>appTransaction((tx)=>tx.$queryRawUnsafe(`UPDATE client_objectives SET status='ready' WHERE id=$1`,I.objective)),'23514');
      await expectCode(()=>appTransaction((tx)=>tx.$queryRawUnsafe(`INSERT INTO client_objectives(tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash) VALUES($1,$2,$3,gen_random_uuid(),repeat('a',64))`,I.tenant,I.otherClient,I.user)),'23503');
      await appTransaction(async(tx)=>assert.equal((await tx.$queryRawUnsafe('SELECT id FROM client_objective_revisions WHERE id=$1',I.revision))[0].id,I.revision));
      for (const text of ['SELECT id FROM client_objective_revisions FOR SHARE','UPDATE client_objective_revisions SET snapshot=\'{}\'','DELETE FROM client_objective_revisions']) await expectCode(()=>appTransaction((tx)=>tx.$queryRawUnsafe(text)),'42501');
    });
    await record('actual Objective owner requires live actor, same client and current revision',async()=>{
      assert.equal((await appTransaction((tx)=>owners.objective.requireClientObjectiveDestinationRevision(tx,ctx,objectiveInput))).objectiveRevisionId,I.revision);
      await expectCode(()=>appTransaction((tx)=>owners.objective.requireClientObjectiveDestinationRevision(tx,{...ctx,clerkUserId:'user_native_other'},objectiveInput)),'OBJECTIVE_DESTINATION_NOT_FOUND');
      await expectCode(()=>appTransaction((tx)=>owners.objective.requireClientObjectiveDestinationRevision(tx,ctx,{...objectiveInput,objectiveVersion:2})),'OBJECTIVE_VERSION_CONFLICT');
      await expectCode(()=>appTransaction((tx)=>owners.objective.requireClientObjectiveDestinationRevision(tx,ctx,{...objectiveInput,clientId:I.otherClient})),'OBJECTIVE_DESTINATION_NOT_FOUND');
    });
    await record('actual Workspace saved bytes/hash and immutable version',async()=>{
      const value=await appTransaction((tx)=>owners.workspace.workspaceSavedOutreachRevisionWithinTx(tx,wsInput));
      assert.equal(hash(value.snapshot),hash(snapshot));assert.equal(value.contentSkeleton.body,'Update\nExact synthetic text.');
      await expectCode(()=>appTransaction((tx)=>tx.$queryRawUnsafe(`UPDATE ws_doc_version SET label='changed' WHERE id=$1`,I.version)),'23514');
    });
    await record('actual Outreach concurrent duplicate stages produce one durable mutation/receipt',async()=>{
      const [a,b]=await Promise.all([engine.stageSavedNewsletter(ctx,I.session,stageInput()),engine.stageSavedNewsletter(ctx,I.session,stageInput())]);
      assert.equal(a.receiptId,b.receiptId);assert.equal([a,b].filter(x=>x.replayed).length,1);
      assert.equal((await rows('SELECT count(*)::int AS n FROM outreach_state_versions WHERE session_id=$1',[I.session]))[0].n,2);
      assert.equal((await rows('SELECT count(*)::int AS n FROM outreach_events WHERE command_batch_id=$1',[I.request]))[0].n,1);
      return {receiptId:a.receiptId,stateVersion:a.stateVersion};
    });
    await record('stage wrong hash and request reuse cannot write or reinterpret receipt',async()=>{
      await expectCode(()=>engine.stageSavedNewsletter(ctx,I.session,{...stageInput(),snapshotHash:'0'.repeat(64)}),'OUTREACH_STATE_CONFLICT');
      await expectCode(()=>engine.stageSavedNewsletter(ctx,I.session,{...stageInput(),expectedStateVersion:2}),'OUTREACH_COMMAND_ID_REUSE');
      assert.equal((await rows('SELECT count(*)::int AS n FROM outreach_state_versions WHERE session_id=$1',[I.session]))[0].n,2);
    });
    await record('current grant revocation refuses Objective, Workspace and durable-stage replay',async()=>{
      await admin.query('DELETE FROM client_memory_access WHERE id=$1',[I.grant]);
      await expectCode(()=>appTransaction((tx)=>owners.objective.requireClientObjectiveDestinationRevision(tx,ctx,objectiveInput)),'OBJECTIVE_DESTINATION_NOT_FOUND');
      await assert.rejects(()=>appTransaction((tx)=>owners.workspace.workspaceSavedOutreachRevisionWithinTx(tx,wsInput)),owners.workspace.WorkspaceRevisionUnavailable);
      await expectCode(()=>engine.stageSavedNewsletter(ctx,I.session,stageInput()),'OUTREACH_REFERENCE_UNAUTHORIZED');
      await admin.query('INSERT INTO client_memory_access(id,tenant_id,client_id,user_id) VALUES($1,$2,$3,$4)',[I.grant,I.tenant,I.client,I.user]);
    });
    await record('native reader client SHARE versus writer grant DELETE/client UPDATE deadlock',async()=>{
      const reader=await connect('deadlock-reader'),writer=await connect('deadlock-writer');
      const clientLocked=deferred(),resumeGrant=deferred();
      try {
        for(const client of [reader,writer]){await client.query('BEGIN');await client.query(`SET LOCAL ROLE ${APP}`);await client.query(`SELECT set_config('app.current_tenant',$1,true),set_config('app.bypass_rls','off',true)`,[I.tenant]);}
        const read=guardedPending(owners.objective.requireClientObjectiveDestinationRevision(adapter(reader,async({text})=>{if(text.includes('FOR SHARE OF t,m,u,c')){clientLocked.resolve();await resumeGrant.promise;}}),ctx,objectiveInput));
        await Promise.race([clientLocked.promise,read.then(x=>{throw x.error??new Error('Reader completed before client barrier');})]);
        await writer.query('DELETE FROM client_memory_access WHERE id=$1',[I.grant]);
        resumeGrant.resolve();
        await waitBlocked(reader.processID,writer.processID);
        const write=guardedPending(writer.query('UPDATE clients SET memory_wall=false WHERE id=$1',[I.client]));
        // Roll back whichever is chosen as victim before awaiting the survivor.
        const first=await Promise.race([read.then(value=>({which:'reader',value})),write.then(value=>({which:'writer',value}))]);
        assert.equal(first.value.ok,false);assert.equal(first.value.error.code,'40P01');
        await (first.which==='reader'?reader:writer).query('ROLLBACK');
        const all=await Promise.all([read,write]);
        await reader.query('ROLLBACK');await writer.query('ROLLBACK');
        assert.equal((await rows('SELECT count(*)::int AS n FROM client_memory_access WHERE id=$1',[I.grant]))[0].n,1);
        return {victim:first.which,sqlstate:first.value.error.code,outcomes:all.map(x=>x.ok?'survived':x.error.code),partialWritesCommitted:false};
      } finally { resumeGrant.resolve(); await reader.query('ROLLBACK');await writer.query('ROLLBACK');await close(reader);await close(writer); }
    });
    await record('Core rich newsletter receipt RLS uses distinct legacy identifiers',async()=>{
      for(const tenant of [I.tenant,I.otherTenant])await admin.query(`INSERT INTO newsletter_account_invitations(id,tenant_id,document_id,author_id,email,organization_id,account_role,status) VALUES($1,$2,$3,'user_synthetic','synthetic@example.invalid','org_synthetic','member','waiting')`,[tenant===I.tenant?id(41):id(42),tenant,id(43)]);
      assert.equal((await appTransaction((tx)=>tx.$queryRawUnsafe('SELECT id FROM newsletter_account_invitations'))).length,1);
      await expectCode(()=>appTransaction((tx)=>tx.$queryRawUnsafe(`INSERT INTO newsletter_account_invitations(id,tenant_id,document_id,author_id,email,organization_id,account_role,status) VALUES($1,$2,$3,'user_synthetic','synthetic@example.invalid','org_synthetic','member','waiting')`,id(44),I.otherTenant,id(43))),'42501');
      await expectCode(()=>appTransaction((tx)=>tx.$queryRawUnsafe(`UPDATE newsletter_account_invitations SET attempted_at=now(),attempt_kind=NULL`)),'23514');
      const tables=await rows(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname`,[SCHEMA,['newsletter_account_invitations','newsletter_invitation_email_deliveries','newsletter_review_email_deliveries','newsletter_recipient_access','newsletter_subscriptions']]);
      assert.equal(tables.length,5);assert(tables.every(t=>t.relrowsecurity&&t.relforcerowsecurity));return tables;
    });
    await record('actual global calendar evidence and Repeatable Read snapshot',async()=>{
      const now=new Date();
      const evidence=owners.evidence.buildEffectiveDateEvidence({document_number:'2026-12345',type:'RULE',publication_date:'2026-10-01',effective_on:'2026-10-15',pdf_url:'https://www.govinfo.gov/content/pkg/FR-2026-10-01/pdf/2026-12345.pdf',correction_of:null,corrections:[]},now);
      await admin.query(`INSERT INTO federal_register_document(document_number,type,title,publication_date,effective_date,effective_date_evidence,effective_date_observed_at) VALUES('2026-12345','RULE','Synthetic public rule','2026-10-01','2026-10-15',$1::jsonb,$2)`,[JSON.stringify(evidence),now]);
      await expectCode(()=>admin.query(`UPDATE federal_register_document SET effective_date_evidence=jsonb_set(effective_date_evidence,'{dateKind}','"publication"')`),'23514');
      const counted=deferred(),continueRead=deferred();
      const original=nativePrisma.$transaction;
      nativePrisma.$transaction=async(fn,options)=>{
        assert.equal(options.isolationLevel,'RepeatableRead');const c=await connect('repeatable-calendar');
        try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const value=await fn(adapter(c,async({text})=>{if(text.includes('SELECT count(*) AS total')){counted.resolve();await continueRead.promise;}}));await c.query('COMMIT');return value;}
        catch(e){await c.query('ROLLBACK');throw e;}finally{await close(c);}
      };
      try {
        const pending=guardedPending(calendar.getEffectiveDateCalendar({dateFrom:'2026-10-01',dateTo:'2026-11-01'}));
        await Promise.race([counted.promise,pending.then(x=>{throw x.error??new Error('Calendar completed before count barrier');})]);
        const changed=owners.evidence.buildEffectiveDateEvidence({...{document_number:'2026-12345',type:'RULE',publication_date:'2026-10-01',effective_on:'2026-10-20',pdf_url:'https://www.govinfo.gov/content/pkg/FR-2026-10-01/pdf/2026-12345.pdf'},correction_of:'https://www.federalregister.gov/api/v1/documents/2026-11111.json',corrections:[]},new Date(),evidence);
        await admin.query(`UPDATE federal_register_document SET effective_date='2026-10-20',effective_date_evidence=$1::jsonb,effective_date_observed_at=$2`,[JSON.stringify(changed),changed.observedAt]);
        continueRead.resolve();const result=await pending;assert(result.ok,result.error?.message);
        assert.equal(result.value.pagination.totalCandidates,1);assert.equal(result.value.data[0].date,'2026-10-15');assert.equal(result.value.coverage.complete,false);
        nativePrisma.$transaction=original;
        const next=await calendar.getEffectiveDateCalendar({dateFrom:'2026-10-01',dateTo:'2026-11-01'});
        assert.equal(next.data.length,0);assert.equal(next.coverage.refreshRequired,true);assert.equal(changed.previous.evidenceHash,evidence.evidenceHash);
      }finally{continueRead.resolve();nativePrisma.$transaction=original;}
    });
  } catch (error) { if(!results.some(r=>r.status==='FAIL'))results.push({name:'setup or fixture',status:'FAIL',error:{message:error.message,code:error.code??null,stack:error.stack}}); }
  finally {
    for(const client of [...open])if(client!==admin){try{await client.query('ROLLBACK');}catch{}await close(client);}
    if(admin){if(schemaCreated){await admin.query('RESET ROLE');await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);}if(rolesCreated)await admin.query(`DROP ROLE ${APP}; DROP ROLE ${OWNER}`);await close(admin);}
    // Only roles created in this invocation are dropped; no DROP OWNED/reset.
  }
  const receiptOut={sourceHead:SOURCE_HEAD,target:TARGET,schema:SCHEMA,ownerRole:OWNER,appRole:APP,nativePostgres:true,nativePrisma:false,fullMigrationReplay:false,productionRoleHardening:false,loadedCanonicalFiles:owners.loadedFiles,results,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length};
  fs.writeFileSync(output,JSON.stringify(receiptOut,null,2)+'\n');
  if(receiptOut.failed)process.exitCode=1;
  return receiptOut;
}
async function main(args) {
  if(args.length===1&&args[0]==='--plan'){
    const binding=verifyBindings();const parts=assembleFixture();
    console.log(JSON.stringify({sourceHead:binding.sourceHead,sourceTree:binding.sourceTree,sourceBindings:binding.entries.length,fixtureParts:parts.map(p=>({source:p.source,qualification:p.qualification,bytes:Buffer.byteLength(p.sql)})),target:TARGET,runAuthorized:false,databaseDriverLoaded:false,nativeTestsRun:false},null,2));return;
  }
  if(args.length!==5||args[0]!=='--run'||args[1]!=='--verified-target'||args[3]!=='--output')throw new Error('Usage: --plan OR --run --verified-target <root receipt> --output <new owned receipt>');
  const output=path.resolve(args[4]);
  if(!output.startsWith(path.join(__dirname,'evidence')+path.sep)||fs.existsSync(output))throw new Error('New packet-owned output required; never overwrite raw evidence');
  await runNative(JSON.parse(fs.readFileSync(args[2],'utf8')),output);
}
module.exports={TARGET,SOURCE_HEAD,validateTarget,boundTag,adapter,main};
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.stack);process.exitCode=1;});
