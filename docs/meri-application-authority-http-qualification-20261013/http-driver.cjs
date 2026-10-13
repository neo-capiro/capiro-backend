'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHost, cacheRequire, digest, SOURCE_HEAD} = require('./critical-loader.cjs');
const {pathToFileURL} = require('node:url');
const IDS = Object.freeze({
  tenant:'a1000000-0000-4000-8000-000000000001',
  foreignTenant:'a1000000-0000-4000-8000-000000000002',
  user:'a2000000-0000-4000-8000-000000000001',
  otherUser:'a2000000-0000-4000-8000-000000000002',
  membership:'a3000000-0000-4000-8000-000000000001',
  client:'a4000000-0000-4000-8000-000000000001',
  foreignClient:'a4000000-0000-4000-8000-000000000002',
  conversation:'a5000000-0000-4000-8000-000000000001',
  grant:'a6000000-0000-4000-8000-000000000001',
  impersonation:'a7000000-0000-4000-8000-000000000001',
});
const ROUTES = Object.freeze({identity:'/api/clio/application-authority/identity',context:'/api/clio/application-authority/context'});
const CLAIM_SUB = 'fixture_clerk_actor';
const SESSION_ID = 'fixture_session_current';
const CREDENTIAL = 'fixture-local-only'; // synthetic, never emitted to receipts
function validatePrivateConfig(config) {
  assert.equal(config.sourceHead, SOURCE_HEAD);
  assert.match(config.databaseName, /^capiro_meri_http_20261013_[a-z0-9]+$/);
  assert.equal(config.systemIdentifier, '7695590366852821031');
  assert.equal(config.approvedOwnedDatabase, true);
  assert.ok(Number.isSafeInteger(config.databaseOid) && config.databaseOid > 0);
  assert.equal(config.databaseComment, 'owned disposable Meri HTTP qualification 20261013');
  const url = new URL(config.connectionUrl);
  assert.equal(url.protocol, 'postgresql:');
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), config.databaseName);
  assert.equal(url.searchParams.get('schema') ?? 'public', 'public');
  assert.equal(url.searchParams.get('connection_limit') ?? '1', '1');
  return url;
}
async function main(configPath, output) {
  if (!configPath || !output || fs.existsSync(output)) throw new Error('Private approved config and exclusive output required');
  const config = JSON.parse(fs.readFileSync(configPath,'utf8'));
  validatePrivateConfig(config);
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(__dirname,'critical-source-sha256.json'),'utf8'));
  const sdkCalls = {construct:0,verify:0,session:0,providerNetwork:0};
  let scenario = {};
  let prisma;
  let app;
  const sdk = {
    createClerkClient(options) {
      assert.equal(options.secretKey,''); sdkCalls.construct++;
      return {sessions:{getSession:async id => {
        sdkCalls.session++;
        assert.equal(id,SESSION_ID);
        scenario.sessionReads = (scenario.sessionReads ?? 0) + 1;
        if (scenario.duringSession) await scenario.duringSession(prisma, scenario.sessionReads);
        if (scenario.hang) return new Promise(() => {});
        if (scenario.sdkFailure) throw new Error('Deterministic SDK refusal');
        const now = Date.now();
        return {id:scenario.sessionId ?? SESSION_ID,userId:scenario.sessionUser ?? CLAIM_SUB,
          status:scenario.sessionStatus ?? 'active',createdAt:scenario.createdAt,
          expireAt:scenario.expireAt,abandonAt:scenario.abandonAt,
          actor:null};
      }}};
    },
    async verifyToken(token) {
      sdkCalls.verify++;
      if (token !== CREDENTIAL || scenario.verifyFailure) throw new Error('Deterministic token refusal');
      return {sub:CLAIM_SUB,sid:SESSION_ID,exp:Math.floor(Date.now()/1000)+90,
        iss:'https://fixture.clerk.invalid',capiro_tenant_id:IDS.tenant,
        capiro_tenant_slug:'http-fixture-a',org_id:'fixture_org_a',...(scenario.claims ?? {})};
    },
  };
  const host = createHost({sourceManifest,sdk,native:true,fixtureConfig:{NODE_ENV:'test',CLERK_SECRET_KEY:'',CLERK_JWT_ISSUER:'https://fixture.clerk.invalid'}});
  const PrismaService = host.load(path.join(host.API_ROOT,'src/prisma/prisma.service.ts')).PrismaService;
  prisma = new PrismaService({datasources:{db:{url:config.connectionUrl}}});
  const receipts = [];
  const results = [];
  const nativeFetch = globalThis.fetch;
  let port;
  const fetchOwned = (url, options) => {
    const target = new URL(url);
    assert.equal(target.protocol,'http:');assert.equal(target.hostname,'127.0.0.1');
    assert.equal(target.port,String(port));
    assert.ok(Object.values(ROUTES).includes(target.pathname) || target.pathname === '/api/meri/application-authority/identity');
    assert.equal(target.search,'');assert.equal(target.username,'');assert.equal(target.password,'');
    return nativeFetch(target, {...options,redirect:'error'});
  };
  // No critical/unrelated HTTP constructor may escape the owned listener.
  // Prisma's native socket uses only the separately fenced connection URL.
  globalThis.fetch=fetchOwned;
  const https=require('node:https');const originalHttpsRequest=https.request;
  const originalHttpsGet=https.get;
  https.request=https.get=()=>{throw new Error('External HTTPS refused in fixture');};
  let targetIdentity;
  try {
    // First query is read-only target fencing. No fixture write precedes it.
    await prisma.$connect();
    const rows = await prisma.$queryRaw`SELECT current_database() AS "databaseName",d.oid::int AS "databaseOid",obj_description(d.oid,'pg_database') AS "databaseComment",system_identifier::text AS "systemIdentifier",current_user AS "currentUser",session_user AS "sessionUser",r.rolsuper AS "superuser",r.rolbypassrls AS "bypassRls",inet_server_addr()::text AS "serverAddress",version() AS version FROM pg_database d CROSS JOIN pg_control_system() CROSS JOIN pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user`;
    assert.equal(rows.length,1);targetIdentity=rows[0];
    for (const key of ['databaseName','databaseOid','databaseComment','systemIdentifier']) assert.equal(targetIdentity[key],config[key],`Owned target mismatch: ${key}`);
    assert.match(targetIdentity.version,/PostgreSQL 16\.15/);
    const {Test} = cacheRequire('@nestjs/testing');
    const module = await Test.createTestingModule({imports:[host.FixturePortsModule,host.AppModule]})
      .overrideProvider(PrismaService).useValue(prisma).compile();
    app = module.createNestApplication({bodyParser:false,logger:false});
    host.load(path.join(host.API_ROOT,'src/bootstrap/configure-api-http-app.ts')).configureApiHttpApp(app,{
      serviceHeader:'meri-owned-http-fixture',releaseShaHeader:SOURCE_HEAD,
      includeClerkRawBody:true,includeRecallRawBody:true,includeTangoRawBody:true,
      includeEmailSignatureLargeBody:true,defaultJsonLimit:'1mb',
    });
    await app.init();
    await app.listen(0,'127.0.0.1');
    port=app.getHttpServer().address().port;
    const MeriService=host.load(path.join(host.API_ROOT,'src/meri/meri.service.ts')).MeriService;
    const {RAW_MERI_SERVICE}=host.load(path.join(host.API_ROOT,'src/meri/meriv3-runtime.proxy.ts'));
    assert.notEqual(module.get(MeriService),module.get(RAW_MERI_SERVICE));
    assert.ok(module.get(RAW_MERI_SERVICE) instanceof MeriService);
    async function reset() {
      const now=Date.now();
      scenario={createdAt:now-60_000,expireAt:now+180_000,abandonAt:now+120_000};
      await prisma.clientMemoryAccess.deleteMany({});
      await prisma.impersonationSession.deleteMany({});
      await prisma.clioConversation.deleteMany({});
      await prisma.auditLog.deleteMany({});
      await prisma.tenantMembership.deleteMany({});
      await prisma.client.deleteMany({});
      await prisma.user.deleteMany({});
      await prisma.tenant.deleteMany({});
      await prisma.tenant.create({data:{id:IDS.tenant,slug:'http-fixture-a',name:'Synthetic A',status:'active',clerkOrgId:'fixture_org_a'}});
      await prisma.tenant.create({data:{id:IDS.foreignTenant,slug:'http-fixture-b',name:'Synthetic B',status:'active',clerkOrgId:'fixture_org_b'}});
      await prisma.user.create({data:{id:IDS.user,clerkUserId:CLAIM_SUB,email:'fixture-a@invalid.invalid'}});
      await prisma.user.create({data:{id:IDS.otherUser,clerkUserId:'fixture_other_actor',email:'fixture-b@invalid.invalid'}});
      await prisma.tenantMembership.create({data:{id:IDS.membership,tenantId:IDS.tenant,userId:IDS.user,role:'standard_user',status:'active'}});
      await prisma.client.create({data:{id:IDS.client,tenantId:IDS.tenant,name:'Synthetic client A',memoryWall:false}});
      await prisma.client.create({data:{id:IDS.foreignClient,tenantId:IDS.foreignTenant,name:'Synthetic foreign client',memoryWall:false}});
      await prisma.clioConversation.create({data:{id:IDS.conversation,tenantId:IDS.tenant,userId:IDS.user,clientId:IDS.client,title:'Synthetic authority fixture'}});
    }
    async function request(caseName, route, bodyUtf8, {token=true,headers={},expected=200}={}) {
      const sentAtMs=Date.now();
      const response=await fetchOwned(`http://127.0.0.1:${port}${route}`,{
        method:'POST',body:bodyUtf8,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${CREDENTIAL}`} : {}),...headers},
      });
      const actualBody=await response.text();const receivedAtMs=Date.now();
      const receipt={source:{capiroHead:SOURCE_HEAD,capiroTree:'77a6cc091e6bfa02afa8b9e558a7d2e2a1e523a2',meriHead:config.meriHead},case:caseName,
        request:{method:'POST',path:route,body:bodyUtf8,sentAtMs,sha256:digest(Buffer.from(bodyUtf8))},
        response:{status:response.status,headers:Object.fromEntries(response.headers),bodyUtf8:actualBody,receivedAtMs,sha256:digest(Buffer.from(actualBody))},
        expected:{status:expected},sessionReads:scenario.sessionReads??0};
      receipts.push(receipt);assert.equal(response.status,expected,`${caseName}: ${actualBody}`);
      if (expected===200) {assert.match(response.headers.get('content-type'),/^application\/json; charset=utf-8$/i);assert.equal(response.headers.get('cache-control'),'no-store');}
      else if (![400,413].includes(expected)) {
        if (Object.values(ROUTES).includes(route)) assert.equal(response.headers.get('cache-control'),'no-store');
      }
      return {receipt,json:()=>JSON.parse(actualBody)};
    }
    async function check(name, action) {
      try {await reset();await action();results.push({name,passed:true});console.log(`PASS ${name}`);}
      catch(error){results.push({name,passed:false,error:error.message});console.error(`FAIL ${name}: ${error.stack}`);}
      await new Promise(resolve=>setTimeout(resolve,60)); // retain original 30/s throttler
    }
    const contextBody=()=>JSON.stringify({identitySha256:'a'.repeat(64),conversationId:IDS.conversation,clientId:IDS.client});
    await check('identity real POST200 and canonical principal',async()=>{const {json}=await request('identity-valid',ROUTES.identity,'{}');assert.deepEqual(json().principal,{tenantId:IDS.tenant,actorId:IDS.user});assert.equal(scenario.sessionReads,1);});
    await check('context current owned client POST200 echo-only correlation',async()=>{const {json}=await request('context-valid',ROUTES.context,contextBody());assert.equal(json().identitySha256,'a'.repeat(64));assert.equal(json().selectedClientId,IDS.client);assert.equal(scenario.sessionReads,2);});
    await check('wrong meri alias has no route',()=>request('wrong-route','/api/meri/application-authority/identity','{}',{expected:404}));
    await check('missing bearer401',()=>request('missing-bearer',ROUTES.identity,'{}',{token:false,expected:401}));
    await check('invalid token401',async()=>{scenario.verifyFailure=true;await request('invalid-token',ROUTES.identity,'{}',{expected:401});});
    await check('missing sid401 before SDK online',async()=>{scenario.claims={sid:undefined};await request('missing-sid',ROUTES.identity,'{}',{expected:401});assert.equal(scenario.sessionReads??0,0);});
    await check('foreign issuer401',async()=>{scenario.claims={iss:'https://foreign.invalid'};await request('foreign-issuer',ROUTES.identity,'{}',{expected:401});});
    await check('client_portal_user role refused by actual RolesGuard',async()=>{await prisma.tenantMembership.update({where:{id:IDS.membership},data:{role:'client_portal_user'}});await request('role-client-portal',ROUTES.identity,'{}',{expected:403});assert.equal(scenario.sessionReads??0,0);});
    await check('revoked native session identity401',async()=>{scenario.sessionStatus='revoked';await request('session-revoked',ROUTES.identity,'{}',{expected:401});});
    await check('revoked native session context403',async()=>{scenario.sessionStatus='revoked';await request('context-session-revoked',ROUTES.context,contextBody(),{expected:403});});
    await check('session user binding identity401',async()=>{scenario.sessionUser='fixture_foreign_actor';await request('session-user-mismatch',ROUTES.identity,'{}',{expected:401});});
    await check('session ID binding identity401',async()=>{scenario.sessionId='fixture_different_session';await request('session-id-mismatch',ROUTES.identity,'{}',{expected:401});});
    await check('expired native session401',async()=>{scenario.expireAt=Date.now()-1;await request('expired-session',ROUTES.identity,'{}',{expected:401});});
    await check('SDK failure401 without cached receipt',async()=>{scenario.sdkFailure=true;await request('sdk-failure',ROUTES.identity,'{}',{expected:401});});
    await check('SDK caller deadline bounds refusal no cancellation claim',async()=>{scenario.hang=true;const {receipt}=await request('sdk-timeout',ROUTES.identity,'{}',{expected:401});const elapsed=receipt.response.receivedAtMs-receipt.request.sentAtMs;assert.ok(elapsed>=1900 && elapsed<6000,`elapsed=${elapsed}`);});
    await check('membership revoked during SDK await403',async()=>{scenario.duringSession=async db=>{await db.tenantMembership.update({where:{id:IDS.membership},data:{status:'removed'}});};await request('membership-mid-read-revoked',ROUTES.identity,'{}',{expected:403});});
    await check('tenant inactive during SDK await403',async()=>{scenario.duringSession=async db=>{await db.tenant.update({where:{id:IDS.tenant},data:{status:'suspended'}});};await request('tenant-mid-read-inactive',ROUTES.identity,'{}',{expected:403});});
    await check('Clerk user mapping changed during SDK await403',async()=>{scenario.duringSession=async db=>{await db.user.update({where:{id:IDS.user},data:{clerkUserId:'fixture_rebound'}});};await request('mapping-mid-read-changed',ROUTES.identity,'{}',{expected:403});});
    await check('membership role changed during SDK await403',async()=>{scenario.duringSession=async db=>{await db.tenantMembership.update({where:{id:IDS.membership},data:{role:'user_admin'}});};await request('role-mid-read-changed',ROUTES.identity,'{}',{expected:403});});
    for (const [label,body] of [['array','[]'],['null','null'],['primitive','42'],['constructor','{"constructor":{}}'],['prototype','{"__proto__":{}}'],['extra','{"extra":true}']]) await check(`identity closed HTTP JSON ${label}`,()=>request(`identity-${label}`,ROUTES.identity,body,{expected:400}));
    await check('malformed JSON parser400',()=>request('invalid-json',ROUTES.identity,'{',{expected:400}));
    await check('oversize default parser413',()=>request('oversize-json',ROUTES.identity,JSON.stringify({a:'x'.repeat(1024*1024)}),{expected:413}));
    await check('context missing hash400',()=>request('context-missing-hash',ROUTES.context,JSON.stringify({conversationId:IDS.conversation,clientId:IDS.client}),{expected:400}));
    await check('context selector object400',()=>request('context-object-id',ROUTES.context,JSON.stringify({identitySha256:'a'.repeat(64),conversationId:IDS.conversation,clientId:{id:IDS.client}}),{expected:400}));
    await check('context extra JSON constructor400',()=>request('context-extra',ROUTES.context,JSON.stringify({identitySha256:'a'.repeat(64),conversationId:IDS.conversation,clientId:IDS.client,constructor:null}),{expected:400}));
    await check('foreign client selector cannot grant403',()=>request('foreign-client-selector',ROUTES.context,JSON.stringify({identitySha256:'a'.repeat(64),conversationId:IDS.conversation,clientId:IDS.foreignClient}),{expected:403}));
    await check('same tenant walled client no grant403',async()=>{await prisma.client.update({where:{id:IDS.client},data:{memoryWall:true}});await request('wall-no-grant',ROUTES.context,contextBody(),{expected:403});});
    await check('same tenant current wall grant200',async()=>{await prisma.client.update({where:{id:IDS.client},data:{memoryWall:true}});await prisma.clientMemoryAccess.create({data:{id:IDS.grant,tenantId:IDS.tenant,clientId:IDS.client,userId:IDS.user}});await request('wall-current-grant',ROUTES.context,contextBody());});
    await check('foreign tenant grant for same client does not authorize403',async()=>{await prisma.client.update({where:{id:IDS.client},data:{memoryWall:true}});await prisma.clientMemoryAccess.create({data:{id:IDS.grant,tenantId:IDS.foreignTenant,clientId:IDS.client,userId:IDS.user}});await request('wall-foreign-tenant-grant',ROUTES.context,contextBody(),{expected:403});});
    await check('other actor conversation403',async()=>{await prisma.clioConversation.update({where:{id:IDS.conversation},data:{userId:IDS.otherUser}});await request('conversation-other-actor',ROUTES.context,contextBody(),{expected:403});});
    await check('archived conversation403',async()=>{await prisma.clioConversation.update({where:{id:IDS.conversation},data:{archivedAt:new Date()}});await request('conversation-archived',ROUTES.context,contextBody(),{expected:403});});
    await check('inactive conversation403',async()=>{await prisma.clioConversation.update({where:{id:IDS.conversation},data:{status:'inactive'}});await request('conversation-inactive',ROUTES.context,contextBody(),{expected:403});});
    await check('client binding changes during second session await403',async()=>{scenario.duringSession=async(db,n)=>{if(n===2) await db.clioConversation.update({where:{id:IDS.conversation},data:{clientId:IDS.foreignClient}});};await request('conversation-rebound-mid-read',ROUTES.context,contextBody(),{expected:403});});
    await check('wall revoked during second session await403',async()=>{await prisma.client.update({where:{id:IDS.client},data:{memoryWall:true}});await prisma.clientMemoryAccess.create({data:{id:IDS.grant,tenantId:IDS.tenant,clientId:IDS.client,userId:IDS.user}});scenario.duringSession=async(db,n)=>{if(n===2)await db.clientMemoryAccess.deleteMany({where:{clientId:IDS.client}});};await request('wall-revoked-mid-read',ROUTES.context,contextBody(),{expected:403});});
    await check('malformed persisted prospect scope403',async()=>{await prisma.clioConversation.update({where:{id:IDS.conversation},data:{metadata:{bizdevProspectScope:{prospectId:'bad'}}}});await request('malformed-prospect-scope',ROUTES.context,contextBody(),{expected:403});});
    await check('RP scope cannot transfer bound client403',async()=>{await prisma.clioConversation.update({where:{id:IDS.conversation},data:{metadata:{researchPortfolioScope:{kind:'research_portfolio'}}}});await request('incompatible-rp-scope',ROUTES.context,contextBody(),{expected:403});});
    if(config.privateClientConsumer) {
      await check('unchanged private Meri client consumes actual HTTP receipts test-only mapping',async()=>{
        const consumer=await import(pathToFileURL(config.privateClientConsumer).href);
        assert.equal(typeof consumer.consumeOwnedHttp,'function');
        const capture=await consumer.consumeOwnedHttp({origin:'https://capiro-fixture.invalid',credential:CREDENTIAL,
          fetchImpl:(url,options)=>{
            const input=new URL(url);assert.equal(input.origin,'https://capiro-fixture.invalid');
            assert.ok(Object.values(ROUTES).includes(input.pathname));assert.equal(input.search,'');assert.equal(input.hash,'');
            return fetchOwned(`http://127.0.0.1:${port}${input.pathname}`,options);
          },conversationId:IDS.conversation,clientId:IDS.client});
        assert.equal(capture.identity.principal.tenantId,IDS.tenant);assert.equal(capture.identity.principal.actorId,IDS.user);
        assert.equal(capture.context.selectedClientId,IDS.client);
        receipts.push({case:'private-client-consumer',actualConsumer:capture});
      });
    }
    const settings=await prisma.withTenant(IDS.tenant,tx=>tx.$queryRaw`SELECT current_user AS "currentUser",session_user AS "sessionUser",current_setting('app.current_tenant',true) AS "tenantGuc",current_setting('app.bypass_rls',true) AS "bypassGuc"`);
    const tables=await prisma.$queryRaw`SELECT c.relname,r.rolname AS owner,c.relrowsecurity AS "rowSecurity",c.relforcerowsecurity AS "forceRowSecurity",pg_has_role(current_user,c.relowner,'MEMBER') AS "ownerMembership" FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`;
    const receipt={sourceHead:SOURCE_HEAD,sourceTree:'77a6cc091e6bfa02afa8b9e558a7d2e2a1e523a2',actualLoopbackHttp:true,nativePrisma:true,
      wholeAppBootstrap:false,fullMigrations:false,liveClerk:false,TLS:false,currentRunAuthority:false,
      targetIdentity,settings,tables,sourceReads:host.reads,unrelatedBlockedImports:host.blocked,hostPortCalls:host.hostCalls,sdkCalls,
      cases:results,total:results.length,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,receipts};
    fs.writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    if(receipt.failed) process.exitCode=1;
  } finally {
    globalThis.fetch=nativeFetch;
    https.request=originalHttpsRequest;https.get=originalHttpsGet;
    if(app) await app.close();
    await prisma?.$disconnect();
  }
}
module.exports={IDS,ROUTES,validatePrivateConfig,main};
if(require.main===module) main(process.argv[2],process.argv[3]).catch(error=>{console.error(error.stack);process.exitCode=1;});
