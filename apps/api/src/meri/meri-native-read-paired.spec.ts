/** Run with MERI_SOURCE_ROOT pointing at the paired Meri checkout. Real public
 * source modules and HTTP bytes; authenticated identities and owner rows are synthetic. */
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import type {Request} from 'express';
import type {ExecutionContext} from '@nestjs/common';
import type {TenantContext} from '@capiro/shared';
jest.mock('../external/fedramp/fedramp.client.js',()=>({fetchFedrampProducts:jest.fn()}));
jest.mock('../memory/memory-wall.helpers.js',()=>({clientMemoryAllowed:jest.fn(async()=>true)}));
import {fetchFedrampProducts} from '../external/fedramp/fedramp.client.js';
import {clientMemoryAllowed} from '../memory/memory-wall.helpers.js';
import {ToolServiceSecretGuard,hasVerifiedToolServiceIdentity} from './tool-service-secret.guard.js';
import {admitMeriReadObservation,withMeriReadObservation} from './meri-funding-read-observation.js';
import {MeriToolsService} from './meri-tools.service.js';
import {receiveMemoryProposalPage} from './memory-receiving/meri-memory-proposal-receiver.js';
import {readRetainedReadHeader} from './retained-read-context.js';
const uuid=(s:string)=>`${s.repeat(8)}-${s.repeat(4)}-4${s.repeat(3)}-8${s.repeat(3)}-${s.repeat(12)}`;
const ctx={tenantId:uuid('b'),userId:uuid('c'),role:'standard_user'} as TenantContext;
const at=Date.parse('2026-10-25T00:00:00.000Z'),clientId=uuid('7');
const run=promisify(execFile),paired=process.env.MERI_SOURCE_ROOT?describe:describe.skip;
paired('actual Meri native caller and Core producer agreement',()=>{
 beforeEach(()=>{jest.clearAllMocks();jest.mocked(clientMemoryAllowed).mockResolvedValue(true);});
 async function probe(id:string,personal=true,denyWall=false){
  const calls:string[]=[],errors:unknown[]=[];
  jest.mocked(clientMemoryAllowed).mockResolvedValue(!denyWall);
  jest.mocked(fetchFedrampProducts).mockResolvedValue([{productId:'FR123',cspName:'Synthetic CSP',csoName:'Synthetic Cloud',status:'FedRAMP Certified',impactLevel:'Moderate',authorizationDate:null,sponsoringAgencies:[],sourceUrl:'https://fedramp.gov/marketplace/products/',observedAt:new Date(at).toISOString()}]);
  const service=Object.create(MeriToolsService.prototype) as Record<string,any>;
  service.prisma={federalRegisterDocument:{findUnique:async()=>({documentNumber:'synthetic-rule',title:'Synthetic rule',type:'NOTICE',agencyNames:[],publicationDate:new Date(at-86400000),commentEndDate:new Date(at+86400000),docketIds:[],htmlUrl:null,pdfUrl:null})}};
  service.programElement={listSamOpportunities:async()=>({total:1,data:[{id:uuid('8'),noticeId:'synthetic-notice',solicitationNumber:null,title:'Synthetic opportunity',noticeType:'synthetic',agency:null,office:null,pscCode:null,naicsCode:null,postedDate:null,responseDeadline:null,description:'',sourceUrl:null,active:true}]})};
  service.opportunityTools={readSamSourceFreshness:async()=>[]};
  const tx={tenantMembership:{findFirst:async()=>({role:'standard_user'})},client:{findFirst:async()=>({id:clientId})}};
  const prisma={withTenantUser:async(_tenant:string,_actor:string,fn:(tx:unknown)=>Promise<unknown>)=>fn(tx)};
  const owner={listOwnProposals:async(_ctx:unknown,selection:{cursor?:string})=>({enabled:true,nextCursor:selection.cursor?null:'paired-next',candidates:[{id:uuid(selection.cursor?'9':'8'),scope:'client',clientId,sourceKind:'user_chat',status:'pending',createdAt:selection.cursor?'2026-10-17T00:00:00.000Z':'2026-10-18T00:00:00.000Z',decidedAt:null,restricted:false,proposal:{key:'Preference',value:'Use SMS',canonicalItem:null},capabilities:{withdraw:true}}]})};
  const guard=new ToolServiceSecretGuard({get:(key:string)=>key==='INTERNAL_SERVICE_SECRET'?'SYNTHETIC_SERVICE':key==='NODE_ENV'?'production':undefined} as never);
  const server=createServer(async(incoming,response)=>{try{
   const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));const raw=JSON.parse(Buffer.concat(chunks).toString());
   const path=incoming.url!,req={method:incoming.method,path,originalUrl:path,url:path,headers:incoming.headers} as Request;
   expect(path).toBe(`/api/clio/tools/${id}`);expect(req.headers.authorization).toBe('Bearer SYNTHETIC_NATIVE');calls.push(path);
   guard.canActivate({switchToHttp:()=>({getRequest:()=>req})} as unknown as ExecutionContext);
   let result:unknown;
   if(id==='memory.list_own_proposals')result=await receiveMemoryProposalPage({ctx,raw,correlation:readRetainedReadHeader(req),verifiedServiceIdentity:hasVerifiedToolServiceIdentity(req),deadlineMs:Number(req.headers['x-meri-deadline-at']),prisma:prisma as never,owner:owner as never,now:()=>at});
   else{const observation=admitMeriReadObservation(id,raw,req,ctx);expect(observation).toBeDefined();result=await withMeriReadObservation(observation!,()=>id==='get_certification_status'?service.getCertificationStatus(raw):id==='get_state_rule_status'?service.getStateRuleStatus(raw):service.searchSamOpportunities(ctx,raw));}
   response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result));
  }catch(error){if(!denyWall)errors.push(error);response.writeHead(403,{'content-type':'application/json'});response.end(JSON.stringify({message:'refused'}));}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};
  try{const child=await run(process.execPath,[join(__dirname,'test-fixtures/native-read-meri-probe.mjs'),id,String(personal)],{env:{...process.env,MERI_TEST_CORE_ORIGIN:`http://127.0.0.1:${address.port}`,MERI_EVIDENCE_ACCURACY_MODE:'off'},timeout:20000,maxBuffer:1048576});
   expect(errors).toEqual([]);return {result:JSON.parse(child.stdout),calls};
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 }
 for(const id of ['get_certification_status','get_state_rule_status','search_sam_opportunities'])it(`${id}: actual General request observation and canonical producer pass Meri result admission`,async()=>{
  const {result,calls}=await probe(id);expect(result).toMatchObject({status:200});expect(calls).toHaveLength(1);
 },30000);
 for(const personal of [false,true])it(`memory ${personal?'General':'client'}: actual canonical DTO and continuation pass both receivers`,async()=>{
  const {result,calls}=await probe('memory.list_own_proposals',personal);expect(result.status).toBe(200);expect(result.next.status).toBe(200);expect(result.retained).toBe(1);expect(calls).toHaveLength(2);
 },30000);
 it('General memory current client-wall denial releases no result or continuation',async()=>{
  const {result,calls}=await probe('memory.list_own_proposals',true,true);expect(result.status).toBe(403);expect(result.next).toBeNull();expect(result.retained).toBe(0);expect(calls).toHaveLength(1);
 },30000);
});
