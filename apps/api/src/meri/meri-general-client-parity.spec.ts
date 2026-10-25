jest.mock('../clients/client-capabilities.service.js', () => ({ ClientCapabilitiesService: jest.fn() }));
jest.mock('../clients/client-people.service.js', () => ({ ClientPeopleService: jest.fn() }));
jest.mock('../clients/client-facilities.service.js', () => ({ ClientFacilitiesService: jest.fn() }));
jest.mock('../engagement/mail-sender.service.js', () => ({ EngagementMailSender: jest.fn() }));
jest.mock('../regulatory-docket/regulatory-docket.service.js', () => ({ RegulatoryDocketService: jest.fn() }));
jest.mock('../lda-intel/lda-intel.service.js', () => ({ LdaIntelService: jest.fn() }));
jest.mock('../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: jest.fn() }));
jest.mock('../federal-spending/federal-spending.service.js', () => ({ FederalSpendingService: jest.fn() }));
jest.mock('../intelligence/actions/action-recommendation-read.service.js', () => ({ ActionRecommendationReadService: jest.fn() }));
jest.mock('../intelligence/intelligence.service.js', () => ({ IntelligenceService: jest.fn() }));
jest.mock('../clients/clients.service.js', () => ({ ClientsService: jest.fn() }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: jest.fn() }));
jest.mock('../program-element/program-element-read.service.js', () => ({ ProgramElementReadService: jest.fn() }));
jest.mock('../acquisition-personnel/acquisition-personnel-read.service.js', () => ({ AcquisitionPersonnelReadService: jest.fn() }));
jest.mock('../memory/memory-candidate.service.js', () => ({ MemoryCandidateService: jest.fn() }));
jest.mock('../memory/memory-ingest.service.js', () => ({ MemoryIngestService: jest.fn() }));
jest.mock('../memory/memory-store.service.js', () => ({ MemoryStoreService: jest.fn() }));
jest.mock('../clients/representation-resolver.service.js', () => ({ RepresentationResolverService: jest.fn() }));
jest.mock('./meri-docgen.service.js', () => ({ MeriDocgenService: jest.fn() }));
jest.mock('./meri-context-plane.service.js', () => ({ MeriContextPlaneService: jest.fn() }));
jest.mock('../funding-opportunities/meri-opportunity-tools.adapter.js', () => ({ MeriOpportunityToolsAdapter: jest.fn() }));
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: jest.fn() }));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));
import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';
import { assertRetainedSourceV02Admission } from './retained-source-v02/admission.js';
import { documentContractV02 } from './retained-source-v02/documents-contract.js';
import { withMeriToolExecutionControl } from './meri-tool-request-control.js';

const id=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const clientId=id('9'),ctx={tenantId:id('1'),userId:id('2')} as TenantContext;
const binding={tenantId:ctx.tenantId,actorId:ctx.userId,conversationId:id('3'),runId:id('4'),attemptId:id('5'),workerId:id('6'),writerFence:1};
const subject={kind:'personal' as const,entityType:'user' as const,entityIds:[ctx.userId],tenantId:ctx.tenantId,actorId:ctx.userId,
 policyRevision:'policy-1',rosterVersionId:null,scopes:[{tenantId:ctx.tenantId,kind:'private-user',resourceId:ctx.userId,policyRevision:'policy-1'}]};
const options={binding,subject};
function admitted(operation:string){
 const input=operation==='get_client_context'?{clientId,section:null,afterId:null,limit:25,representation:'summary'}:
  operation==='read_client_documents'?documentContractV02.normalizeClientDocumentsInput({clientId},options):
  {clientId,meetingId:null,from:null,to:null,limit:25};
 return assertRetainedSourceV02Admission(ctx,operation,{input,metadata:operation.startsWith('meeting.')?{cursor:null}:null},
  {...options,policyRevision:'policy-1',normalizationContext:operation==='read_client_documents'?options:null},
  {verifiedServiceIdentity:true,nowMs:Date.now(),deadlineMs:Date.now()+30000});
}
const run=<T>(fn:()=>Promise<T>)=>withMeriToolExecutionControl({signal:new AbortController().signal,deadlineAt:Date.now()+30000},fn);
function harness(){
 let allowed=true,exists=true;
 const source=jest.fn(async()=>{});
 const findFirst=jest.fn(async()=>exists?{id:clientId,name:'Sensitive synthetic name'}:null);
 const query=jest.fn(async(sql:string,...values:unknown[])=>{
  expect(values[0]).toBe(ctx.tenantId);
  if(sql.includes('AS allowed')){expect(values.slice(1)).toEqual([clientId,ctx.userId]);return [{allowed}];}
  expect(sql).toContain('client_memory_access');expect(values[1]).toBe(ctx.userId);return allowed?[]:[{id:clientId}];
 });
 const tx={client:{findFirst},$queryRawUnsafe:query};
 const prisma={withTenant:jest.fn(async(t:string,fn:(tx:any)=>unknown)=>{expect(t).toBe(ctx.tenantId);return fn(tx);}),
  withTenantUser:jest.fn(async(t:string,a:string,fn:(tx:any)=>unknown)=>{expect([t,a]).toEqual([ctx.tenantId,ctx.userId]);return fn(tx);})};
 const documents={tool:'read_client_documents',generatedAt:new Date().toISOString(),clientId,documents:[],note:'Inventory only',
  coverage:{total:0,returned:0,truncated:false,nextCursor:null,complete:true,paginationComplete:true,query:null,queryAppliesTo:'fileName'}};
 const service=Object.assign(Object.create(MeriToolsService.prototype),{prisma,logger:{warn:jest.fn()},
  getClientContext:jest.fn(async()=>{await source();return {tool:'get_client_context'};}),
  readClientMeetings:jest.fn(async()=>{await source();return {tool:'read_client_meetings'};}),
  readClientDocuments:jest.fn(async()=>{await source();return documents;}),
  engagement:{listAttachments:jest.fn(async()=>[])},clientKb:{search:jest.fn(async()=>{await source();return [];})},
  intelligence:{listTrackedBills:jest.fn(async()=>{await source();return [];})}}) as MeriToolsService;
 return {service,source,query,findFirst,deny:()=>{allowed=false;},remove:()=>{exists=false;}};
}
const calls={
 profile:(s:MeriToolsService)=>s.readRetainedClientContextSourceV03(ctx,admitted('get_client_context')),
 documents:(s:MeriToolsService)=>s.readRetainedDocumentSourceV02(ctx,admitted('read_client_documents')),
 meetings:(s:MeriToolsService)=>s.readRetainedMeetingSourceV02(ctx,admitted('meeting.read_client_meetings')),
 knowledge:(s:MeriToolsService)=>s['searchClientKnowledge'](ctx,{clientId,query:'policy'}),
 tracked:(s:MeriToolsService)=>s['searchTrackedBills'](ctx,{clientId}),
};
for(const [name,read] of Object.entries(calls))describe(`General ${name} current Core owner`,()=>{
 it('admits the explicit client with canonical walls before and after source I/O',async()=>{
  const f=harness(),result=await run(()=>read(f.service));expect(result).toBeDefined();expect(f.source).toHaveBeenCalledTimes(1);
  expect(f.query).toHaveBeenCalledTimes(2);
  if(name==='documents')expect(result).toMatchObject({binding,subject,data:{clientId}});
 });
 it('refuses an initially hidden client without reading source or disclosing client name',async()=>{
  const f=harness();f.deny();await expect(run(()=>read(f.service))).rejects.toThrow('Client not found');expect(f.source).not.toHaveBeenCalled();
 });
 it('withholds successful source bytes after current wall revocation',async()=>{
  const f=harness();f.source.mockImplementation(async()=>f.deny());await expect(run(()=>read(f.service))).rejects.toThrow('Client not found');expect(f.source).toHaveBeenCalledTimes(1);
 });
 it('withholds source output after client removal',async()=>{
  const f=harness();f.source.mockImplementation(async()=>f.remove());await expect(run(()=>read(f.service))).rejects.toThrow('Client not found');
 });
});
it('knowledge outage remains a note only while current wall access still holds',async()=>{
 const f=harness();f.source.mockRejectedValue(Error('synthetic provider outage'));
 await expect(run(()=>calls.knowledge(f.service))).resolves.toMatchObject({clientId,note:expect.any(String)});
 const revoked=harness();revoked.source.mockImplementation(async()=>{revoked.deny();throw Error('synthetic outage');});
 await expect(run(()=>calls.knowledge(revoked.service))).rejects.toThrow('Client not found');
});
