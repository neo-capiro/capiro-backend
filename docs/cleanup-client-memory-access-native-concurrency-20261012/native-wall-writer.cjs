'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '../..');
const apiRequire = createRequire(path.join(ROOT, 'apps/api/package.json'));
const TARGET = Object.freeze({
  dataDirectory: '/tmp/capiro-native-pg-pr2429-20261012/data',
  socketDirectory: '/tmp/capiro-native-pg-socket-pr2429-20261012',
  port: 5432, user: 'agent', database: 'postgres',
  systemIdentifier: '7695922344929406966', listenAddresses: '', inetServerAddr: null,
});
const SCHEMA = 'capiro_wall_writer_20261012';
const OWNER = 'capiro_wall_writer_owner_20261012';
const APP = 'capiro_wall_writer_app_20261012';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const I = { tenant: id(1), otherTenant: id(2), reader: id(3), admin: id(4), client: id(5), otherClient: id(6), peerClient: id(7), a: id(8), b: id(9), objective: id(10), revision: id(11) };
const writerCtx = { tenantId: I.tenant, userId: I.admin, role: 'user_admin' };
const readerCtx = { tenantId: I.tenant, userId: I.reader, clerkUserId: 'user_wall_reader' };

// Exact reviewed baseline protocol, including realpath and credential refusal.
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
function verifyBindings() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'source-bindings.json'), 'utf8'));
  assert.equal(manifest.sourceHead, '926b269ad6e3b5ed789b5d18f55306df310d046c');
  assert.deepEqual(manifest.entries.map(row => row.path).sort(), ['apps/api/src/clients/clients.service.ts', 'packages/shared/src/client-objective-destination.ts']);
  for (const entry of manifest.entries) {
    const bytes = fs.readFileSync(path.join(ROOT, entry.path));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Source changed: ${entry.path}`);
  }
  assert.deepEqual(manifest.runnerFiles.map(row=>row.path).sort(), ['fixture.sql','native-wall-writer.cjs']);
  for(const entry of manifest.runnerFiles){
    const bytes=fs.readFileSync(path.join(__dirname,entry.path));
    assert.equal(bytes.length,entry.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,`Runner source changed: ${entry.path}`);
  }
  const original = fs.readFileSync(path.join(__dirname, '../cleanup-client-memory-access-lock-order-20261012/evidence/clients.service.before.ts.txt'));
  assert.equal(createHash('sha256').update(original).digest('hex'), manifest.originalServiceSha256);
  return manifest;
}
function loadOwners() {
  verifyBindings();
  const ts = apiRequire('typescript');
  const nest = apiRequire('@nestjs/common');
  function writer(text) {
    const file = ts.createSourceFile('clients.service.ts', text, ts.ScriptTarget.Latest, true);
    const owner = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ClientsService');
    const methods = owner?.members.filter(node => ts.isMethodDeclaration(node) && node.name.getText(file) === 'setMemoryAccess');
    assert.equal(methods?.length, 1);
    const sandbox = { module: { exports: {} }, NotFoundException: nest.NotFoundException, BadRequestException: nest.BadRequestException };
    const emitted = ts.transpileModule(`class Fragment { constructor(prisma) { this.prisma=prisma; } ${methods[0].getText(file)} } module.exports=Fragment;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInThisContext('(function(module,NotFoundException,BadRequestException){' + emitted + '\n})')(
      sandbox.module, sandbox.NotFoundException, sandbox.BadRequestException,
    );
    return sandbox.module.exports;
  }
  const readerText = fs.readFileSync(path.join(ROOT, 'packages/shared/src/client-objective-destination.ts'), 'utf8');
  const module = { exports: {} };
  const refused = name => { throw new Error(`Canonical reader runtime import refused: ${name}`); };
  vm.runInThisContext('(function(exports,module,require){' + ts.transpileModule(readerText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText + '\n})')(
    module.exports, module, refused,
  );
  return {
    candidate: writer(fs.readFileSync(path.join(ROOT, 'apps/api/src/clients/clients.service.ts'), 'utf8')),
    original: writer(fs.readFileSync(path.join(__dirname, '../cleanup-client-memory-access-lock-order-20261012/evidence/clients.service.before.ts.txt'), 'utf8')),
    reader: module.exports.requireClientObjectiveDestinationRevision,
  };
}
function keys(value, expected) { assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); }
function adapter(client, events = [], observer = async () => {}) {
  async function query(stage, text, values = []) {
    events.push({ stage, phase: 'issued', text, values });
    const result = await client.query(text, values);
    events.push({ stage, phase: 'completed', rowCount: result.rowCount });
    await observer({ stage, text, values, result });
    return result.rows;
  }
  return {
    $queryRaw: (strings, ...values) => { const q = boundTag(strings, values); return query('raw', q.text, q.values); },
    client: {
      findFirst: async args => {
        keys(args, ['where', 'select']); keys(args.where, ['id', 'tenantId']); assert.deepEqual(args.select, { id: true, memoryWall: true });
        return (await query('client', 'SELECT id,memory_wall AS "memoryWall" FROM clients WHERE id=$1::uuid AND tenant_id=$2::uuid LIMIT 1', [args.where.id, args.where.tenantId]))[0] ?? null;
      },
      update: async args => {
        keys(args, ['where', 'data']); keys(args.where, ['id']); keys(args.data, ['memoryWall']);
        return query('update', 'UPDATE clients SET memory_wall=$2 WHERE id=$1::uuid RETURNING id,memory_wall AS "memoryWall"', [args.where.id, args.data.memoryWall]);
      },
    },
    tenantMembership: { findMany: async args => {
      keys(args, ['where', 'select']); keys(args.where, ['tenantId', 'userId']); keys(args.where.userId, ['in']); assert.deepEqual(args.select, { userId: true });
      return query('members', 'SELECT user_id AS "userId" FROM tenant_memberships WHERE tenant_id=$1::uuid AND user_id=ANY($2::uuid[])', [args.where.tenantId, args.where.userId.in]);
    } },
    clientMemoryAccess: {
      findMany: async args => {
        keys(args, ['where', 'select']); keys(args.where, ['tenantId', 'clientId']); assert.deepEqual(args.select, { userId: true });
        return query('roster', 'SELECT user_id AS "userId" FROM client_memory_access WHERE tenant_id=$1::uuid AND client_id=$2::uuid ORDER BY created_at,id', [args.where.tenantId, args.where.clientId]);
      },
      createMany: async args => {
        keys(args, ['data']); assert(Array.isArray(args.data) && args.data.length > 0);
        const values = []; const tuples = [];
        for (const row of args.data) {
          keys(row, ['tenantId', 'clientId', 'userId', 'grantedBy']);
          const start = values.length;
          values.push(row.tenantId, row.clientId, row.userId, row.grantedBy);
          tuples.push(`($${start + 1}::uuid,$${start + 2}::uuid,$${start + 3}::uuid,$${start + 4}::uuid)`);
        }
        return query('add', 'INSERT INTO client_memory_access(tenant_id,client_id,user_id,granted_by) VALUES ' + tuples.join(',') + ' RETURNING id', values);
      },
      deleteMany: async args => {
        keys(args, ['where']); keys(args.where, ['tenantId', 'clientId', 'userId']); keys(args.where.userId, ['in']);
        return query('remove', 'DELETE FROM client_memory_access WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND user_id=ANY($3::uuid[]) RETURNING id', [args.where.tenantId, args.where.clientId, args.where.userId.in]);
      },
    },
    auditLog: { create: async args => {
      keys(args, ['data']); const d = args.data;
      keys(d, ['tenantId', 'actorUserId', 'actorRole', 'action', 'entityType', 'entityId', 'before', 'after']);
      return query('audit', 'INSERT INTO audit_logs(tenant_id,actor_user_id,actor_role,action,entity_type,entity_id,before_json,after_json) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::jsonb,$8::jsonb) RETURNING id', [d.tenantId, d.actorUserId, d.actorRole, d.action, d.entityType, d.entityId, JSON.stringify(d.before), JSON.stringify(d.after)]);
    } },
  };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function settled(promise) { return promise.then(value => ({ ok: true, value }), error => ({ ok: false, error })); }
async function barrier(pause, pending) {
  await Promise.race([pause.promise, pending.then(result => { throw result.error ?? new Error('Operation completed before expected barrier'); })]);
}
function containment() {
  const net = require('node:net'); const connect = net.Socket.prototype.connect;
  const socket = path.join(TARGET.socketDirectory, `.s.PGSQL.${TARGET.port}`);
  net.Socket.prototype.connect = function (...args) {
    const options = args[0];
    const actual = typeof options === 'string' ? options : options?.path;
    if (actual !== socket) throw new Error('Native writer runner refused other socket/network target');
    return connect.apply(this, args);
  };
  for (const [name, methods] of [['node:http', ['request','get']], ['node:https', ['request','get']], ['node:dns', ['lookup','resolve','resolve4','resolve6']], ['node:child_process', ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork']]]) {
    for (const method of methods) require(name)[method] = () => { throw new Error(`Native writer runner refused ${name}.${method}`); };
  }
  global.fetch = () => { throw new Error('Native writer runner refused fetch'); };
}
async function runNative(targetReceipt, output) {
  validateTarget(targetReceipt);
  const binding = verifyBindings(); const owners = loadOwners();
  containment();
  const { Client } = apiRequire('pg');
  const open = new Set(); const verified = new Set(); const createdRoles = []; const results = []; const cleanupErrors = [];
  let admin; let schemaCreated = false;
  async function connect(label) {
    const c = new Client({ host: TARGET.socketDirectory, port: TARGET.port, user: TARGET.user, database: TARGET.database, password: '', ssl: false, application_name: `capiro-wall-writer-${label}`, connectionTimeoutMillis: 3000, query_timeout: 15000 });
    await c.connect(); open.add(c);
    const [actual] = (await c.query(`SELECT current_setting('data_directory') AS "dataDirectory",current_setting('listen_addresses') AS "listenAddresses",inet_server_addr() AS "inetServerAddr",current_user AS "user",current_database() AS "database",system_identifier::text AS "systemIdentifier",version() FROM pg_control_system()`)).rows;
    for (const key of ['dataDirectory','listenAddresses','inetServerAddr','user','database','systemIdentifier']) assert.equal(actual[key], TARGET[key]);
    assert(actual.version.startsWith('PostgreSQL 16.15 '));
    verified.add(c);
    await c.query(`SET statement_timeout='12s'; SET lock_timeout='10s'; SET TIME ZONE 'UTC'; SET search_path=${SCHEMA},public`);
    return c;
  }
  async function close(c) { open.delete(c); verified.delete(c); await c.end(); }
  async function begin(c, ctx = writerCtx) {
    await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${APP}`);
    await c.query(`SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true),set_config('app.bypass_rls','off',true)`, [ctx.tenantId, ctx.userId]);
  }
  const rows = async (sql, values = []) => (await admin.query(sql, values)).rows;
  async function waitBlocked(waiter, blocker) {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const [row] = await rows('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, blocker]);
      if (row.blocked) return { waiter, blocker, observed: true };
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Expected native client row-lock wait was not observed');
  }
  function write(Owner, c, input, events, observer, ctx = writerCtx, clientId = I.client) {
    const service = new Owner({ withTenant: async (tenant, callback) => { assert.equal(tenant, ctx.tenantId); return callback(adapter(c, events, observer)); } });
    return service.setMemoryAccess(ctx, clientId, input);
  }
  async function reset() {
    await admin.query('DELETE FROM audit_logs'); await admin.query('DELETE FROM client_memory_access');
    await admin.query('UPDATE clients SET memory_wall=true');
    await admin.query('INSERT INTO client_memory_access(tenant_id,client_id,user_id,granted_by) VALUES($1,$2,$3,$4)', [I.tenant,I.client,I.reader,I.admin]);
  }
  const roster = async () => (await rows('SELECT user_id::text AS id FROM client_memory_access WHERE client_id=$1 ORDER BY user_id', [I.client])).map(row => row.id);
  const audits = async () => rows('SELECT actor_user_id::text AS actor,actor_role AS role,before_json AS before,after_json AS after FROM audit_logs ORDER BY seq');
  async function record(name, fn) {
    try { const details = await fn(); results.push({ name, status: 'PASS', details }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, status: 'FAIL', error: { message: error.message, code: error.code ?? null, stack: error.stack } }); throw error; }
  }
  async function pair(fn) {
    const a = await connect('A'), b = await connect('B');
    try { return await fn(a,b); }
    finally { for (const c of [a,b]) { try { await c.query('ROLLBACK'); } finally { await close(c); } } }
  }
  try {
    admin = await connect('admin');
    assert.equal((await rows("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'"))[0].n,0);
    assert.equal((await rows('SELECT nspname FROM pg_namespace WHERE nspname=$1',[SCHEMA])).length,0);
    assert.equal((await rows('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[[APP,OWNER]])).length,0);
    for (const role of [OWNER,APP]) { await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`); createdRoles.push(role); }
    await admin.query(`CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${OWNER}`); schemaCreated=true;
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${APP}; SET ROLE ${OWNER}`);
    await admin.query(fs.readFileSync(path.join(__dirname,'fixture.sql'),'utf8'));
    await admin.query('RESET ROLE');
    const role = (await rows('SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,pg_has_role($1,$2,\'MEMBER\') AS owner_member FROM pg_roles WHERE rolname=$1',[APP,OWNER]))[0];
    assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolbypassrls:false,rolinherit:false,rolcreatedb:false,rolcreaterole:false,owner_member:false});
    await admin.query('INSERT INTO tenants(id) VALUES($1),($2)',[I.tenant,I.otherTenant]);
    for (const [user,clerk] of [[I.reader,'user_wall_reader'],[I.admin,'user_wall_admin'],[I.a,'user_wall_A'],[I.b,'user_wall_B']]) {
      await admin.query('INSERT INTO users(id,clerk_user_id) VALUES($1,$2)',[user,clerk]);
      await admin.query('INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,$3,\'active\')',[I.tenant,user,user===I.admin?'user_admin':'standard_user']);
    }
    await admin.query('INSERT INTO clients(id,tenant_id,name) VALUES($1,$2,\'fixture\'),($3,$4,\'foreign\'),($5,$2,\'peer\')',[I.client,I.tenant,I.otherClient,I.otherTenant,I.peerClient]);
    await admin.query('INSERT INTO client_objectives(id,tenant_id,client_id) VALUES($1,$2,$3)',[I.objective,I.tenant,I.client]);
    await admin.query('INSERT INTO client_objective_revisions(id,tenant_id,client_id,objective_id) VALUES($1,$2,$3,$4)',[I.revision,I.tenant,I.client,I.objective]);
    await record('original two-writer negative schedule leaves a union, not the last complete roster',async()=>{
      await reset();
      return pair(async(a,b)=>{
        await begin(a); await begin(b);
        const readA=deferred(),readB=deferred(),resumeA=deferred(),resumeB=deferred(); const eventsA=[],eventsB=[];
        const wa=settled(write(owners.original,a,{memoryWall:true,userIds:[I.a]},eventsA,async({stage})=>{if(stage==='roster'){readA.resolve();await resumeA.promise;}}));
        const wb=settled(write(owners.original,b,{memoryWall:true,userIds:[I.b]},eventsB,async({stage})=>{if(stage==='roster'){readB.resolve();await resumeB.promise;}}));
        try {
          await Promise.all([barrier(readA,wa),barrier(readB,wb)]);
          resumeA.resolve(); const ra=await wa; assert(ra.ok,ra.error?.message); await a.query('COMMIT');
          resumeB.resolve(); const rb=await wb; assert(rb.ok,rb.error?.message); await b.query('COMMIT');
          const final=await roster(); assert.deepEqual(final,[I.a,I.b].sort()); assert.notDeepEqual(final,[I.b]);
          const audit=await audits(); assert.equal(audit.length,2); assert.deepEqual(audit.map(x=>x.before.grantedUserIds),[[I.reader],[I.reader]]);
          return {eventsA,eventsB,final,audit,expectedOldDefectObserved:true};
        } finally {resumeA.resolve();resumeB.resolve();await Promise.all([wa,wb]);}
      });
    });
    for (const [first,last] of [[I.a,I.b],[I.b,I.a]]) await record(`candidate serializes complete writers ${first} then ${last}`,async()=>{
      await reset();
      return pair(async(a,b)=>{
        await begin(a);await begin(b);
        const acquired=deferred(),release=deferred(); const eventsA=[],eventsB=[];
        const wa=settled(write(owners.candidate,a,{memoryWall:true,userIds:[first]},eventsA,async({stage,text})=>{if(stage==='raw'&&text.includes('FOR UPDATE')){acquired.resolve();await release.promise;}}));
        await barrier(acquired,wa);
        const wb=settled(write(owners.candidate,b,{memoryWall:true,userIds:[last]},eventsB));
        try {
          const blocked=await waitBlocked(b.processID,a.processID);
          assert.deepEqual(eventsB.map(x=>[x.stage,x.phase]),[['raw','issued']]);
          release.resolve(); const ra=await wa;assert(ra.ok,ra.error?.message);await a.query('COMMIT');
          const rb=await wb;assert(rb.ok,rb.error?.message);await b.query('COMMIT');
          assert.deepEqual(await roster(),[last]);const audit=await audits();assert.equal(audit.length,2);
          assert.deepEqual(audit.map(x=>[x.before.grantedUserIds,x.after.grantedUserIds]),[[[I.reader],[first]],[[first],[last]]]);
          return {blocked,eventsA,eventsB,audit,final:await roster()};
        } finally {release.resolve();await Promise.all([wa,wb]);}
      });
    });
    await record('reader finishes before the blocked client-first writer; fresh reader denies revocation',async()=>{
      await reset();
      return pair(async(reader,writer)=>{
        await begin(reader,readerCtx);await begin(writer);
        const locked=deferred(),release=deferred(); const readerEvents=[],writerEvents=[];
        const read=settled(owners.reader(adapter(reader,readerEvents,async({text})=>{if(text.includes('FOR SHARE OF t,m,u,c')){locked.resolve();await release.promise;}}),readerCtx,{clientId:I.client,objectiveId:I.objective,objectiveVersion:1}));
        await barrier(locked,read);
        const writeOp=settled(write(owners.candidate,writer,{memoryWall:true,userIds:[]},writerEvents));
        try {
          const blocked=await waitBlocked(writer.processID,reader.processID);
          assert.deepEqual(writerEvents.map(x=>[x.stage,x.phase]),[['raw','issued']]);
          release.resolve();const r=await read;assert(r.ok,r.error?.message);await reader.query('COMMIT');
          const w=await writeOp;assert(w.ok,w.error?.message);await writer.query('COMMIT');assert.deepEqual(await roster(),[]);
          await begin(reader,readerCtx);
          await assert.rejects(()=>owners.reader(adapter(reader),readerCtx,{clientId:I.client,objectiveId:I.objective,objectiveVersion:1}),e=>e.code==='OBJECTIVE_DESTINATION_NOT_FOUND');
          await reader.query('ROLLBACK');
          return {blocked,readerEvents,writerEvents,audit:await audits(),freshReaderDenied:true,sqlstates:[]};
        } finally {release.resolve();await Promise.all([read,writeOp]);}
      });
    });
    await record('foreign and absent client return404 before membership/grant/audit work',async()=>{
      await reset();const c=await connect('boundary');const details=[];
      try {
        for(const clientId of [I.otherClient,id(999)]) {
          await begin(c);const events=[];
          await assert.rejects(()=>write(owners.candidate,c,{memoryWall:true,userIds:[I.a]},events,undefined,writerCtx,clientId),e=>e.getStatus()===404&&e.message==='Client not found');
          assert.deepEqual(events.map(x=>[x.stage,x.phase]),[['raw','issued'],['raw','completed']]);await c.query('ROLLBACK');details.push({clientId,events});
        }
        assert.deepEqual(await roster(),[I.reader]);assert.deepEqual(await audits(),[]);return details;
      } finally {await c.query('ROLLBACK');await close(c);}
    });
    await record('membership failure rolls back without changes and releases the client lock',async()=>{
      await reset();const a=await connect('rejection'),b=await connect('after-rejection');
      try {
        await begin(a);const events=[];
        await assert.rejects(()=>write(owners.candidate,a,{memoryWall:true,userIds:[id(999)]},events),e=>e.getStatus()===400);
        await a.query('ROLLBACK');assert.deepEqual(await roster(),[I.reader]);assert.deepEqual(await audits(),[]);
        await begin(b);await write(owners.candidate,b,{memoryWall:false,userIds:[I.a]},[]);await b.query('COMMIT');
        assert.deepEqual(await roster(),[I.a]);return {events,released:true,audit:await audits()};
      } finally {await a.query('ROLLBACK');await b.query('ROLLBACK');await close(a);await close(b);}
    });
    await record('another same-tenant client can finish while the first client remains locked',async()=>{
      await reset();
      return pair(async(a,b)=>{
        await begin(a);await begin(b);
        const acquired=deferred(),release=deferred();const eventsA=[],eventsB=[];let firstFinished=false;
        const wa=settled(write(owners.candidate,a,{memoryWall:true,userIds:[I.a]},eventsA,async({stage})=>{if(stage==='raw'){acquired.resolve();await release.promise;}})).then(result=>{firstFinished=true;return result;});
        await barrier(acquired,wa);
        try {
          const wb=settled(write(owners.candidate,b,{memoryWall:true,userIds:[I.b]},eventsB,undefined,writerCtx,I.peerClient));
          const result=await wb;assert(result.ok,result.error?.message);assert.equal(firstFinished,false);await b.query('COMMIT');
          assert.deepEqual((await rows('SELECT user_id::text AS id FROM client_memory_access WHERE client_id=$1',[I.peerClient])).map(row=>row.id),[I.b]);
          release.resolve();const first=await wa;assert(first.ok,first.error?.message);await a.query('COMMIT');
          return {eventsA,eventsB,peerCompletedBeforeFirst:true};
        } finally {release.resolve();await wa;}
      });
    });
    await record('post-audit adapter error rolls back all native writes and releases the client lock',async()=>{
      await reset();const a=await connect('adapter-fault'),b=await connect('after-fault');const events=[];
      try {
        await begin(a);
        await assert.rejects(()=>write(owners.candidate,a,{memoryWall:false,userIds:[I.a]},events,async({stage})=>{if(stage==='audit')throw new Error('synthetic after-audit adapter failure');}),/synthetic after-audit adapter failure/);
        await a.query('ROLLBACK');assert.deepEqual(await roster(),[I.reader]);assert.deepEqual(await audits(),[]);
        assert.equal((await rows('SELECT memory_wall AS wall FROM clients WHERE id=$1',[I.client]))[0].wall,true);
        await begin(b);await write(owners.candidate,b,{memoryWall:false,userIds:[I.b]},[]);await b.query('COMMIT');assert.deepEqual(await roster(),[I.b]);
        return {events,injectedAdapterFault:true,originalStateRestored:true,released:true};
      } finally {await a.query('ROLLBACK');await b.query('ROLLBACK');await close(a);await close(b);}
    });
  } catch(error) {
    if(!results.some(row=>row.status==='FAIL'))results.push({name:'setup/fixture',status:'FAIL',error:{message:error.message,code:error.code??null,stack:error.stack}});
  } finally {
    for(const c of [...open])if(c!==admin){if(verified.has(c))try{await c.query('ROLLBACK');}catch(error){cleanupErrors.push(error.message);}try{await close(c);}catch(error){cleanupErrors.push(error.message);}}
    if(admin){
      try {await admin.query('RESET ROLE');if(schemaCreated)await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);for(const role of [...createdRoles].reverse())await admin.query(`DROP ROLE ${role}`);
        assert.equal((await rows('SELECT nspname FROM pg_namespace WHERE nspname=$1',[SCHEMA])).length,0);
        assert.equal((await rows('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[[APP,OWNER]])).length,0);
        assert.equal((await rows("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'"))[0].n,0);
        assert.equal((await rows("SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'capiro-wall-writer-%' AND pid<>pg_backend_pid()")).length,0);
      }catch(error){cleanupErrors.push(error.message);}finally{try{await close(admin);}catch(error){cleanupErrors.push(error.message);}}
    }
  }
  const result={sourceHead:binding.sourceHead,target:TARGET,schema:SCHEMA,appRole:APP,ownerRole:OWNER,nativePostgres:true,nativePrisma:false,fullClientAuditLogSchema:false,fullMigrationReplay:false,productionRlsAcceptance:false,results,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,cleanupErrors,cleanupVerified:cleanupErrors.length===0&&schemaCreated};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});if(result.failed||cleanupErrors.length)process.exitCode=1;return result;
}
async function main(args) {
  if(args.length===1&&args[0]==='--plan'){
    const binding=verifyBindings();loadOwners();console.log(JSON.stringify({binding,target:TARGET,schema:SCHEMA,appRole:APP,ownerRole:OWNER,nativePrisma:false,driverLoaded:false,sqlExecuted:false,runAuthorized:false},null,2));return;
  }
  if(args.length!==5||args[0]!=='--run'||args[1]!=='--verified-target'||args[3]!=='--output')throw new Error('Usage: --plan OR --run --verified-target <root receipt> --output <new packet receipt>');
  const output=path.resolve(args[4]);const parent=path.join(__dirname,'evidence');
  if(path.dirname(output)!==parent||fs.existsSync(output)||fs.realpathSync(parent)!==parent)throw new Error('New unsymlinked packet-owned output required');
  await runNative(JSON.parse(fs.readFileSync(args[2],'utf8')),output);
}
module.exports={TARGET,SCHEMA,OWNER,APP,validateTarget,boundTag,adapter,verifyBindings,loadOwners,main};
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.stack);process.exitCode=1;});
