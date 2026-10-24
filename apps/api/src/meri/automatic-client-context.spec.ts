import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { AutomaticClientContextService } from './automatic-client-context.service.js';
import { projectAutomaticClientContext, AUTOMATIC_CONTEXT_MAX_BYTES, AUTOMATIC_CONTEXT_SECTION_IDS } from './automatic-client-context.projection.js';
import { withMeriToolExecutionControl } from './meri-tool-request-control.js';
jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../retrieval/adapters/institutional-knowledge-retrieval.adapter.js', () => ({ InstitutionalKnowledgeRetrievalAdapter: class {} }));
const clientId='33333333-3333-4333-8333-333333333333';
const ctx: TenantContext={tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',clerkUserId:'user_synthetic',tenantSlug:'synthetic',role:'standard_user'};
const at='2026-10-24T01:00:00.000Z';
function input(){return {tenantId:ctx.tenantId,actorId:ctx.userId,clientId,startedAt:at,completedAt:at,
 profile:{context:{client:{id:clientId,tenantId:ctx.tenantId,name:'Synthetic same-name client',uei:'SYNTHETICUEI',cageCode:'SYN01',description:'Builds synthetic tools',updatedAt:at},openTasks:[]},
  profile:{capabilities:[{id:'cap1',name:'Synthetic capability',updatedAt:at}],people:[],facilities:[],advocacyMatters:[]},
  profileSections:Object.fromEntries(['capabilities','people','facilities','advocacyMatters'].map(k=>[k,{status:'complete',total:k==='capabilities'?1:0}]))},
 objectives:{status:'complete',total:1,items:[{id:'objective1',clientId,outcome:'Deliver prototype',limits:'No foreign work',status:'ready',version:2,updatedAt:at}]},
 memory:{sourceStatus:'healthy',total:1,records:[{recordId:'memory1',updatedAt:at,provenance:{canonicalTenantId:ctx.tenantId,sourceVersion:'v2'},payload:{clientId,title:'Approved correction',value:'Exact current correction',contentStatus:'available',governance:{memoryClass:'client_steering',status:'active',conflictStatus:'none',stale:false,approvedAt:at}}}]}};}
function fixture(){const sample=input();const tools={readAutomaticClientProfile:jest.fn(async()=>sample.profile)},objectives={readContext:jest.fn(async()=>sample.objectives),assertContextAccess:jest.fn(async()=>{})},memory={retrieve:jest.fn(async(..._args:unknown[])=>sample.memory)},catalog={get:jest.fn(()=>({domain:'institutional_knowledge'}))};
 const service=new AutomaticClientContextService(tools as never,objectives as never,memory as never,catalog as never);return {sample,tools,objectives,memory,catalog,service};}
test('six conceptual sections preserve actual identifiers, revisions, constraints and approved correction',()=>{
 const p=projectAutomaticClientContext(input());expect(p.sections.map(s=>s.id)).toEqual(AUTOMATIC_CONTEXT_SECTION_IDS);expect(p.subject.clientId).toBe(clientId);
 expect(p.sections[0]!.facts[0]!.values.cageCode).toBe('SYN01');expect(p.sections[3]!.facts[0]).toMatchObject({version:'2',values:{limits:'No foreign work'}});
 expect(p.sections[5]!.facts[0]).toMatchObject({version:'v2',values:{content:'Exact current correction',conflictStatus:'none'}});
 expect(JSON.stringify(p)).not.toContain('intakeData');expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(AUTOMATIC_CONTEXT_MAX_BYTES);
});
test('empty, unavailable, partial, stale/conflicted and metadata-only are not promoted to complete facts',()=>{
 const i=input();i.profile.profileSections.people={status:'unavailable',total:0};i.profile.profileSections.facilities={status:'partial',total:50};
 const m=i.memory.records[0]!.payload;m.contentStatus='metadata_only';m.governance.stale=true;m.governance.conflictStatus='conflicted';
 const p=projectAutomaticClientContext(i);expect(p.sections[4]!.coverage.map(c=>c.status)).toEqual(['unavailable','partial']);
 expect(p.sections[5]!.facts[0]!.values).not.toHaveProperty('content');expect(p.sections[5]!.facts[0]!.values).toMatchObject({stale:true,conflictStatus:'conflicted'});
 expect(p.sections[4]!.gaps.join(' ')).toContain('absence is not established');
});
test.each(['client','tenant','memory','objective'])('foreign %s source refuses instead of leaking into prompt',kind=>{const i=input();
 if(kind==='client')i.profile.context.client.id='foreign';if(kind==='tenant')i.profile.context.client.tenantId='foreign';if(kind==='memory')i.memory.records[0]!.provenance.canonicalTenantId='foreign';if(kind==='objective')i.objectives.items[0]!.clientId='foreign';expect(()=>projectAutomaticClientContext(i)).toThrow();});
test('oversized source text is explicitly omitted, not silently cut; preferences are excluded',()=>{
 const i=input();i.profile.context.client.description='x'.repeat(1601);i.memory.records[0]!.payload.governance.memoryClass='user_preference';
 const p=projectAutomaticClientContext(i);expect(p.sections[1]!.facts[0]!.omittedFields).toEqual(['description']);expect(p.sections[5]!.facts).toEqual([]);
});

test('the UTF-8 ceiling drops whole facts and retains truthful source counts and exact identity',()=>{
 const i=input(),large='界'.repeat(1600),three=(make:(n:number)=>Record<string,unknown>)=>[1,2,3].map(make);
 const profile={...i.profile,profile:{...i.profile.profile,
  capabilities:three(n=>({id:`cap${n}`,name:large,description:large,sector:large,updatedAt:at})),
  people:three(n=>({id:`person${n}`,name:large,title:large,organization:large})),
  facilities:three(n=>({id:`facility${n}`,name:large,address:large,city:large})),
  advocacyMatters:three(n=>({id:`matter${n}`,title:large,summary:large,autoGenerated:true})),
 },profileSections:Object.fromEntries(['capabilities','people','facilities','advocacyMatters'].map(k=>[k,{status:'partial',total:100}]))};
 const p=projectAutomaticClientContext({...i,profile,objectives:{status:'partial',total:100,items:three(n=>({id:`objective${n}`,clientId,outcome:large,limits:large,governmentProblem:large,version:n}))}});
 expect(Buffer.byteLength(JSON.stringify(p),'utf8')).toBeLessThanOrEqual(AUTOMATIC_CONTEXT_MAX_BYTES);
 expect(p.sections[0]!.facts[0]!.values.uei).toBe('SYNTHETICUEI');
 expect(p.sections.some(s=>s.gaps.includes('Additional whole records omitted to fit the packet byte budget.'))).toBe(true);
 for(const s of p.sections)for(const c of s.coverage)expect(c.selected).toBe(s.facts.filter(f=>f.source===c.source).length);
 for(const s of p.sections)for(const f of s.facts)for(const v of Object.values(f.values))if(typeof v==='string'&&v.includes('界'))expect(v).toBe(large);
});

test('advocacy classification stays explicit and memory read failure remains unknown, not empty healthy recall',()=>{
 const i=input(),p=projectAutomaticClientContext({...i,profile:{...i.profile,profile:{...i.profile.profile,advocacyMatters:[{id:'matter1',title:'Synthetic matter',autoGenerated:true,status:'active'}]}},memory:{sourceStatus:'error',records:[]}});
 expect(p.sections[2]!.facts[0]!.values).toMatchObject({autoGenerated:true,status:'active'});
 expect(p.sections[2]!.gaps.join(' ')).toContain('not independently verified');
 expect(p.sections[5]!.coverage.find(c=>c.source==='memory_items')).toMatchObject({status:'error',total:null,returned:0,selected:0});
});
test('fresh collection calls existing owners, exact typed client, bounded lookup and post-read access',async()=>{
 const f=fixture();const p=await f.service.read(ctx,{schemaVersion:1,clientId});expect(p.subject).toMatchObject({actorId:ctx.userId,clientId});
 expect(f.tools.readAutomaticClientProfile).toHaveBeenCalledWith(ctx,clientId);expect(f.objectives.readContext).toHaveBeenCalledWith(ctx,clientId);expect(f.objectives.assertContextAccess).toHaveBeenCalledTimes(2);
 expect(f.memory.retrieve.mock.calls[0]![1]).toMatchObject({queryClass:'lookup',query:'',pageSize:16,caller:{clientIds:[clientId],authorizedClientIds:[clientId]}});
 f.sample.memory.records[0]!.payload.value='Newly approved correction';const next=await f.service.read(ctx,{schemaVersion:1,clientId});expect(next.sections[5]!.facts[0]!.values.content).toBe('Newly approved correction');
});

test('the three canonical reads overlap after the access check and release waits for all three',async()=>{
 const f=fixture(),started:string[]=[],release:Array<()=>void>=[];
 const hold=async(name:string,value:unknown)=>{started.push(name);await new Promise<void>(resolve=>release.push(resolve));return value;};
 f.tools.readAutomaticClientProfile.mockImplementation(async()=>hold('profile',f.sample.profile) as Promise<typeof f.sample.profile>);
 f.objectives.readContext.mockImplementation(async()=>hold('objectives',f.sample.objectives) as Promise<typeof f.sample.objectives>);
 f.memory.retrieve.mockImplementation(async()=>hold('memory',f.sample.memory) as Promise<typeof f.sample.memory>);
 const result=f.service.read(ctx,{schemaVersion:1,clientId});await Promise.resolve();await Promise.resolve();
 expect(started).toEqual(['profile','objectives','memory']);expect(f.objectives.assertContextAccess).toHaveBeenCalledTimes(1);
 release.forEach(resolve=>resolve());await result;expect(f.objectives.assertContextAccess).toHaveBeenCalledTimes(2);
});
test.each([null,{schemaVersion:1,clientId:null},{schemaVersion:1,clientId:'same name'},{schemaVersion:1,clientId,tenantId:'foreign'},{schemaVersion:2,clientId}])('invalid or General input never dispatches source reads: %j',async body=>{
 const f=fixture();await expect(f.service.read(ctx,body)).rejects.toBeInstanceOf(BadRequestException);expect(f.tools.readAutomaticClientProfile).not.toHaveBeenCalled();});
test.each(['before','after'])('wall denial %s collection prevents release',async when=>{const f=fixture();if(when==='before')f.objectives.assertContextAccess.mockRejectedValue(new NotFoundException());else f.objectives.assertContextAccess.mockResolvedValueOnce().mockRejectedValueOnce(new NotFoundException());await expect(f.service.read(ctx,{schemaVersion:1,clientId})).rejects.toBeInstanceOf(NotFoundException);if(when==='before')expect(f.memory.retrieve).not.toHaveBeenCalled();});
test('cancelled request never starts source work',async()=>{const f=fixture(),c=new AbortController();c.abort();await expect(withMeriToolExecutionControl({signal:c.signal},()=>f.service.read(ctx,{schemaVersion:1,clientId}))).rejects.toThrow();expect(f.tools.readAutomaticClientProfile).not.toHaveBeenCalled();});
