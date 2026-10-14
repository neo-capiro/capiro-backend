'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../..');
require(path.join(root,'apps/api/node_modules/reflect-metadata'));
const {Test}=require(path.join(root,'apps/api/node_modules/@nestjs/testing'));
const {ValidationPipe}=require(path.join(root,'apps/api/node_modules/@nestjs/common'));
const {previewConfig}=require(path.join(root,'apps/api/dist/preview-readonly/preview.config.js'));
const {PreviewReadOnlyModule}=require(path.join(root,'apps/api/dist/preview-readonly/preview.module.js'));
const {previewRoutePolicy}=require(path.join(root,'apps/api/dist/preview-readonly/preview.route-policy.js'));
const {PrismaService}=require(path.join(root,'apps/api/dist/prisma/prisma.service.js'));
const {ClerkService}=require(path.join(root,'apps/api/dist/auth/clerk.service.js'));
const net=require('node:net');const originalConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const x=Array.isArray(args[0])?args[0][0]:args[0];const o=typeof x==='object'?x:{port:x,host:args[1]};if(o.host!=='127.0.0.1')throw Error('Non-loopback connection refused');return originalConnect.apply(this,args);};
const deny=()=>{throw Error('Provider access refused');};require('node:https').request=deny;global.fetch=deny;
let app;let ready=true;let databaseCalls=0;let authCalls=0;
const fakePrisma={withPreviewReadOnly:async(_tenant,fn)=>{databaseCalls++;if(!ready)throw Error('synthetic database unavailable');return fn({});}};
const fakeClerk={verifySessionToken:async()=>{authCalls++;throw Error('Unexpected auth call');},assertActiveApplicationAuthoritySession:async()=>{authCalls++;throw Error('Unexpected online call');}};
const config=previewConfig({CAPIRO_PREVIEW_READONLY:'true',PREVIEW_READONLY_DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1/synthetic',PREVIEW_TENANT_ID:'11111111-1111-4111-8111-111111111111',PREVIEW_CLERK_ORG_ID:'org_synthetic',CLERK_SECRET_KEY:'synthetic-test-input',CLERK_JWT_ISSUER:'https://synthetic.invalid',NODE_ENV:'test'});
async function get(port,url){return new Promise((resolve,reject)=>{const req=require('node:http').get({host:'127.0.0.1',port,path:url},res=>{let body='';res.on('data',x=>{body+=x});res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);});}
async function main(){
 const module=await Test.createTestingModule({imports:[PreviewReadOnlyModule.register(config)]}).overrideProvider(PrismaService).useValue(fakePrisma).overrideProvider(ClerkService).useValue(fakeClerk).compile();
 app=module.createNestApplication();app.use(previewRoutePolicy);app.setGlobalPrefix('api');app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));
 await app.init();await app.get(PrismaService).withPreviewReadOnly(config.preview.PREVIEW_TENANT_ID,async()=>undefined);
 await app.listen(0,'127.0.0.1');const port=app.getHttpServer().address().port;
 const initial=await get(port,'/api/__preview_liveness');assert.equal(initial.status,403);assert.equal(initial.headers['cache-control'],'no-store');assert.match(initial.body,/Preview route unavailable/);assert.equal(databaseCalls,1);assert.equal(authCalls,0);
 ready=false;const unavailable=await get(port,'/api/__preview_liveness');assert.equal(unavailable.status,403);assert.equal(databaseCalls,1);assert.equal(authCalls,0);
 const me=await get(port,'/api/me');assert.equal(me.status,401);assert.equal(databaseCalls,1);assert.equal(authCalls,0);
 fs.writeFileSync(path.join(__dirname,'liveness-results.json'),JSON.stringify({source_head:'111f269d749cae0249c2141779bd6d7deb93f45c',actual_emitted_preview_module_and_policy:true,requests:[{path:'/api/__preview_liveness',status:initial.status,auth_calls:0,database_calls:0},{path:'/api/__preview_liveness',status:unavailable.status,synthetic_database_unavailable:true,auth_calls:0,database_calls:0},{path:'/api/me',status:me.status}],startup_role_check_simulated:true,native_database_readiness_qualified:false,clerk_or_provider_called:false,only_loopback_http:true},null,2)+'\n');
 console.log(JSON.stringify({denied_path_status:403,while_database_unavailable_status:403,request_auth_calls:0,request_database_calls:0,native_readiness:false}));
}
main().catch(()=>{console.error('Synthetic liveness probe failed');process.exitCode=1;}).finally(async()=>{if(app)await app.close();});
