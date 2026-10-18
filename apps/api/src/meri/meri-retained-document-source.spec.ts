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
jest.mock('../memory/memory-wall.helpers.js', () => ({
  ...jest.requireActual('../memory/memory-wall.helpers.js'),
  clientMemoryAllowed: jest.fn(async () => true),
  fetchDeniedClientIds: jest.fn(async () => []),
}));

import { MeriToolsService } from './meri-tools.service.js';
import { fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';
import { documentContractV02 } from './retained-source-v02/documents-contract.js';
import { readRetainedSourceV02 } from './retained-source-v02/receiver.js';
import type { RetainedSourceV02Admission } from './retained-source-v02/admission.js';

const id = (n: string) => n.repeat(8)+'-'+n.repeat(4)+'-4'+n.repeat(3)+'-8'+n.repeat(3)+'-'+n.repeat(12);
const clientId = id('a'), ctx = {tenantId: id('1'),userId:'reader'};
const binding = {tenantId:ctx.tenantId,actorId:ctx.userId,conversationId:id('2'),runId:id('3'),attemptId:id('4'),workerId:id('5'),writerFence:1};
const subject = {kind:'client',entityType:'client',entityIds:[clientId],tenantId:ctx.tenantId,actorId:ctx.userId,
 authorizationDecisionId:id('6'),policyRevision:'policy-1',rosterVersionId:null,
 scopes:[{tenantId:ctx.tenantId,kind:'client',resourceId:clientId,policyRevision:'policy-1'}]};
const normalizationContext = {binding,subject};
const input = documentContractV02.normalizeClientDocumentsInput({clientId},normalizationContext);
const admission = () => ({operation:{id:'read_client_documents',version:'0.2.0'},binding,subject,input,metadata:null,
 normalizationContext,argumentsSha256:'a'.repeat(64),requestSha256:'b'.repeat(64),clientId,hardExpiryMs:Date.now()+60000}) as RetainedSourceV02Admission;
const row = {id:'doc-1',clientId,fileName:'Evidence.txt',contentType:'text/plain',byteSize:10,
 calculatedSha256:null,s3Key:'stored/1',lifecycleStatus:'ready',usable:true,viewerMode:'all',viewerUserIds:[],blockedReason:null};
function harness() {
 const ensureClientVisible = jest.fn(async()=>clientId);
 const readClientDocuments = jest.fn(async()=>({tool:'read_client_documents',generatedAt:new Date().toISOString(),clientId,
 coverage:{total:1,returned:1,truncated:false,nextCursor:null,complete:true,paginationComplete:true,query:null,queryAppliesTo:'fileName'},
 note:'Inventory only',documents:[{id:row.id,fileName:row.fileName,contentType:row.contentType,byteSize:row.byteSize,
 createdAt:'2026-10-18T09:00:00Z',indexedAt:null,extractionStatus:null,extractionMetadata:null,usable:true,blockedReason:null,disclosure:null}]}));
 const listAttachments = jest.fn(async()=>[row]);
 const service = Object.assign(Object.create(MeriToolsService.prototype),{ensureClientVisible,readClientDocuments,
 engagement:{listAttachments},prisma:{withTenantUser:jest.fn(async(_t,_a,run)=>run({}))}}) as MeriToolsService;
 return {service,ensureClientVisible,readClientDocuments,listAttachments};
}
describe('retained document owner preparation',()=>{
 beforeEach(()=>jest.mocked(fetchDeniedClientIds).mockResolvedValue([]));
 it('uses trusted provider exclusion and checks the client wall again before return',async()=>{
  const m=harness();
  await expect(m.service.readRetainedDocumentSourceV02(ctx as any,admission())).resolves.toMatchObject({binding,subject,data:{clientId}});
  expect(m.readClientDocuments).toHaveBeenCalledWith(ctx,{clientId,limit:25},{allowPaidExtraction:false});
  expect(m.ensureClientVisible).toHaveBeenCalledTimes(2);
  expect(m.listAttachments).toHaveBeenCalledTimes(2);
 });
 it('rejects substituted context and expired admission before owner reads',async()=>{
  const m=harness(),a=admission();
  a.normalizationContext={binding:{...binding,workerId:id('9')},subject};
  await expect(m.service.readRetainedDocumentSourceV02(ctx as any,a)).rejects.toThrow('unavailable');
  await expect(m.service.readRetainedDocumentSourceV02(ctx as any,{...admission(),hardExpiryMs:Date.now()-1})).rejects.toThrow('expired');
  expect(m.readClientDocuments).not.toHaveBeenCalled();expect(m.listAttachments).not.toHaveBeenCalled();
 });
 it('refuses a revoked final client wall after the canonical read',async()=>{
  const m=harness();
  jest.mocked(fetchDeniedClientIds).mockResolvedValueOnce([]).mockResolvedValueOnce([clientId]);
  await expect(m.service.readRetainedDocumentSourceV02(ctx as any,admission())).rejects.toThrow('Client not found');
  expect(m.readClientDocuments).toHaveBeenCalledTimes(1);
 });
 it('keeps the receiver closed until the Meri tariff contract agrees',async()=>{
  const m=harness();
  const prepared=jest.spyOn(m.service,'readRetainedDocumentSourceV02');
  await expect(readRetainedSourceV02(admission(),ctx as any,m.service)).rejects.toMatchObject({response:{code:'MERI_RETAINED_SOURCE_UNAVAILABLE'}});
  expect(prepared).not.toHaveBeenCalled();
 });
});
