/** Qualification-only glue; import is inert. Private PR52 source stays outside Git. */
import {readFileSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {types} from 'node:util';
const HEAD='4699fdea910ba25c809725630443198c8ae189e4';
const TREE='61c076225b4d9a3aba431a83342e028a3f7b60ca';
const STAGE='/tmp/capiro-meri-pr52-private-client-stage-20261013';
const BINDINGS_SHA='9fae1e1a2783cb98d8c013a70174b2d2c493842ebd8642c4c9f2ac03e92e9a04';
const PATHS=[
 'packages/contracts/action-authority-0.2/validate.mjs',
 'packages/contracts/commands-0.2/execution-boundary.mjs',
 'packages/contracts/retrieval-0.2/operation-contracts.mjs',
 'packages/contracts/validate.mjs', 'packages/contracts/meri.schema.json',
 'apps/control/action-host/application-adapters/authority-http.mjs',
 'packages/runtime/operation-lifetime.mjs',
];
const ORIGIN='https://capiro-fixture.invalid';
const SYNTHETIC={tenantId:'a1000000-0000-4000-8000-000000000001',actorId:'a2000000-0000-4000-8000-000000000001',
 conversationId:'a5000000-0000-4000-8000-000000000001',clientId:'a4000000-0000-4000-8000-000000000001'};
const responseGetters=Object.fromEntries(['status','headers','body','redirected'].map(k=>[k,Object.getOwnPropertyDescriptor(Response.prototype,k).get]));
async function observePositive(response,request){
 if(!response || types.isProxy(response) || !(response instanceof Response)) refused();
 if(responseGetters.status.call(response)!==200) return null; // No negative internal body export.
 const clone=Response.prototype.clone.call(response),body=responseGetters.body.call(clone);
 if(!body || responseGetters.redirected.call(response)) refused();
 const reader=body.getReader(),chunks=[];let size=0,complete=false;
 try {
  for(;;){
   if(request.signal.aborted) refused();
   const part=await reader.read();
   if(part.done){complete=true;break;}
   if(!(part.value instanceof Uint8Array) || (size+=part.value.byteLength)>16384) refused();
   chunks.push(part.value);
  }
 } finally {
  if(!complete){Promise.resolve(reader.cancel()).catch(()=>{});const original=responseGetters.body.call(response);if(original)Promise.resolve(original.cancel()).catch(()=>{});}
  reader.releaseLock();
 }
 const bytes=Buffer.concat(chunks),headers=responseGetters.headers.call(response),safeHeaders={};
 for(const name of ['content-type','cache-control','content-encoding','content-length']){
  const value=Headers.prototype.get.call(headers,name);if(value!==null)safeHeaders[name]=value;
 }
 if(safeHeaders['cache-control']!=='no-store') refused();
 return {source:{capiroHead:'bbb38185058fdc64c204da723943aee055b3dad3',capiroTree:'77a6cc091e6bfa02afa8b9e558a7d2e2a1e523a2',meriHead:HEAD,meriTree:TREE},
  request:{method:'POST',path:request.path,bodyUtf8:request.body,sentAtMs:request.sentAtMs,bodyBytes:Buffer.byteLength(request.body),bodySha256:hash(Buffer.from(request.body))},
  response:{status:200,headers:safeHeaders,bodyUtf8:new TextDecoder('utf-8',{fatal:true}).decode(bytes),receivedAtMs:Date.now(),bodyBytes:bytes.length,bodySha256:hash(bytes)}};
}

const ROUTES={identity:'/api/clio/application-authority/identity',context:'/api/clio/application-authority/context'};
const refused=()=>{throw Error('OWNED_HTTP_CONSUMER_REFUSED');};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function closed(value,keys){
 if(!value || typeof value!=='object' || types.isProxy(value) || Object.getPrototypeOf(value)!==Object.prototype) refused();
 const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
 if(names.length!==keys.length || names.some(k=>typeof k!=='string' || !keys.includes(k) || !descriptors[k].enumerable || !Object.hasOwn(descriptors[k],'value'))) refused();
 return Object.fromEntries(names.map(k=>[k,descriptors[k].value]));
}
function verifySource(){
 const raw=readFileSync(new URL('./CLIENT-STAGE-BINDINGS.json',import.meta.url));
 if(hash(raw)!==BINDINGS_SHA) refused();
 const b=JSON.parse(raw);
 if(b.sourceHead!==HEAD || b.sourceTree!==TREE || b.stage!==STAGE ||
    b.modules.length!==7 || b.modules.some((r,i)=>r.path!==PATHS[i]) ||
    b.dependencies.length!==3 || b.dependencies.map(r=>`${r.package}@${r.version}`).join('|')!=='ajv@8.20.0|ajv-formats@3.0.1|canonicalize@5.1.0') refused();
 for(const r of b.modules){const bytes=readFileSync(join(STAGE,r.path));if(bytes.length!==r.bytes || hash(bytes)!==r.sha256) refused();}
 if(realpathSync(join(STAGE,'node_modules'))!==b.cacheLink.target ||
    realpathSync(process.execPath)!==realpathSync(b.node.path) || process.version!==b.node.version || hash(readFileSync(process.execPath))!==b.node.sha256) refused();
 for(const r of b.dependencies){
  const bytes=readFileSync(r.metadataPath),entry=readFileSync(r.entryPath);
  if(bytes.length!==r.metadataBytes || hash(bytes)!==r.metadataSha256 || JSON.parse(bytes).version!==r.version || entry.length!==r.entryBytes || hash(entry)!==r.entrySha256) refused();
 }
 return b;
}
export async function consumeOwnedHttp(configuration){
 try {
  const {origin,credential,fetchImpl,conversationId,clientId}=closed(configuration,['origin','credential','fetchImpl','conversationId','clientId']);
  if(origin!==ORIGIN || credential!=='fixture-local-only' || typeof fetchImpl!=='function' || conversationId!==SYNTHETIC.conversationId || clientId!==SYNTHETIC.clientId) refused();
  verifySource(); // Complete fixed source/dependency inventory before private module import.
  const [wire,canonical,transport]=await Promise.all([
   import(pathToFileURL(join(STAGE,PATHS[0])).href),
   import(pathToFileURL(join(STAGE,PATHS[3])).href),
   import(pathToFileURL(join(STAGE,PATHS[5])).href),
  ]);
  wire.assertAuthorityIdentityRequest({});
  wire.assertAuthorityContextRequest({identitySha256:'0'.repeat(64),conversationId,clientId});
  let calls=0;const captures=[];
  const forward=async(url,options)=>{
   if(typeof url!=='string' || ![ORIGIN+ROUTES.identity,ORIGIN+ROUTES.context].includes(url)) refused();
   const o=closed(options,['method','redirect','credentials','cache','headers','body','signal']);
   const h=closed(o.headers,['authorization','content-type','accept']);
   if(o.method!=='POST' || o.redirect!=='error' || o.credentials!=='omit' || o.cache!=='no-store' ||
      h.authorization!==`Bearer ${credential}` || h['content-type']!=='application/json' || h.accept!=='application/json' ||
      typeof o.body!=='string' || types.isProxy(o.signal) || !(o.signal instanceof AbortSignal)) refused();
   (url.endsWith(ROUTES.identity)?wire.assertAuthorityIdentityRequest:wire.assertAuthorityContextRequest)(JSON.parse(o.body));
   if(++calls>2) refused();
   const request={path:url.slice(ORIGIN.length),body:o.body,sentAtMs:Date.now(),signal:o.signal};
   const response=await fetchImpl(url,options); // E alone maps these URLs to its owned listener.
   const capture=await observePositive(response,request);if(capture)captures.push(capture);
   return response; // SAME native object, never a synthesized/rewritten response.
  };
  const client=transport.createCapiroApplicationAuthorityClient({origin,fetchImpl:forward,now:Date.now,
   limits:{maxRequestMs:3000,maxResponseBytes:16384},enabled:true});
  const sentIdentityAtMs=Date.now(),deadlineMs=sentIdentityAtMs+3000;
  const identity=wire.assertAuthorityIdentityReceipt(await client.readIdentity({credential,deadlineMs}));
  const receivedIdentityAtMs=Date.now();
  if(identity.principal.tenantId!==SYNTHETIC.tenantId || identity.principal.actorId!==SYNTHETIC.actorId) refused();
  if(identity.checkedAtMs<sentIdentityAtMs || identity.checkedAtMs>receivedIdentityAtMs || identity.expiresAtMs<=receivedIdentityAtMs) refused();
  const identitySha256=canonical.canonicalSha256(identity),sentContextAtMs=Date.now();
  const context=wire.assertAuthorityContextReceipt(await client.readContext({credential,deadlineMs,identitySha256,conversationId,clientId}));
  const receivedContextAtMs=Date.now();
  if(calls!==2 || context.identitySha256!==identitySha256 || context.identityRevision!==identity.identityRevision ||
     context.principal.tenantId!==identity.principal.tenantId || context.principal.actorId!==identity.principal.actorId ||
     context.conversationId!==conversationId || context.selectedClientId!==clientId ||
     context.checkedAtMs<sentContextAtMs || context.checkedAtMs>receivedContextAtMs ||
     Math.min(identity.expiresAtMs,context.expiresAtMs)<=receivedContextAtMs) refused();
  if(captures.length!==2 || captures[0].request.path!==ROUTES.identity || captures[1].request.path!==ROUTES.context ||
     canonical.canonicalSha256(JSON.parse(captures[0].response.bodyUtf8))!==canonical.canonicalSha256(identity) ||
     canonical.canonicalSha256(JSON.parse(captures[1].response.bodyUtf8))!==canonical.canonicalSha256(context)) refused();
  return {identity,context,identitySha256,captures,privateReceiverSource:{head:HEAD,tree:TREE,bindingsSha256:BINDINGS_SHA},
   timeline:{sentIdentityAtMs,receivedIdentityAtMs,sentContextAtMs,receivedContextAtMs},
   limits:{TLS:false,currentRunAuthority:false,productionOrigin:false,testOnlyMappedTransport:true}};
 } catch { refused(); }
}
