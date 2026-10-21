import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApprovalService } from './approval.service.js';
import { ShareLinkService } from './share-link.service.js';
import { HillDayDocumentService } from '../hillday/hillday-document.service.js';
import { HillDayGenerationService } from '../hillday/hillday-generation.service.js';
import { HillDayContextService } from '../hillday/hillday-context.service.js';
import { HillDayResolutionService } from '../hillday/hillday-resolution.service.js';
import { HillDayExportService } from '../hillday/hillday-export.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { DraftsService } from '../drafts/drafts.service.js';
import { VersionsService } from '../versions/versions.service.js';
const T='11111111-1111-4111-8111-111111111111', C='22222222-2222-4222-8222-222222222222', D='33333333-3333-4333-8333-333333333333';
function fixture() {
  const state={role:'owner' as string|null, member:true, allowed:true, policy:['owner'], required:false};
  const draft={id:D,tenantId:T,ownerId:'actor',clientId:C,client:'Same name',prospectId:null,docTitle:'Private title',config:{clientId:C},ask:null,documents:[],updatedAt:new Date()};
  const snapshot=()=>({docTitle:draft.docTitle,config:structuredClone(draft.config),ask:null,documents:[]});
  const version={id:'version',tenantId:T,draftId:D,snapshot:snapshot()};
  const link={id:'share',draftId:D,tenantId:T,createdById:'actor',versionId:'version',tokenHash:'',expiresAt:null,revokedAt:null,createdAt:new Date(),label:null};
  const request={id:'request',tenantId:T,draftId:D,status:'pending',versionId:'version'};
  const db:any={
    wsDraft:{findFirst:jest.fn(async({where}:any)=>where.tenantId===T&&where.id===D?draft:null),findFirstOrThrow:jest.fn(async()=>draft),create:jest.fn(async({data}:any)=>({...draft,...data})),update:jest.fn(async({data}:any)=>Object.assign(draft,data)),findMany:jest.fn(async()=>[draft])},
    wsDocVersion:{findFirst:jest.fn(async({where}:any)=>where.id==='version'&&where.tenantId===T&&where.draftId===D?version:null),create:jest.fn(async({data}:any)=>({...version,...data}))},
    wsBlueprintVersion:{findFirst:jest.fn(async()=>({definition:{approvalPolicy:{clientFacingApprovalRequired:state.required,permittedApproverRoles:state.policy}}}))},
    wsApprovalRequest:{findFirst:jest.fn(async({where}:any)=>where.status==='approved'?state.required?null:{...request,status:'approved'}:request),create:jest.fn(async({data}:any)=>({...request,...data})),update:jest.fn(async()=>request),updateMany:jest.fn(async()=>({count:1}))},
    wsShareLink:{findFirst:jest.fn(async()=>link),create:jest.fn(async()=>link),update:jest.fn(async()=>link),findMany:jest.fn(async()=>[link])},
    wsGuestComment:{groupBy:jest.fn(async()=>[]),create:jest.fn()},
    wsCollaborator:{findFirst:jest.fn(async()=>state.role?{role:state.role}:null),findMany:jest.fn(async()=>[])},
    wsDocument:{create:jest.fn(async()=>({id:'doc'})),update:jest.fn()},
    $executeRaw:jest.fn(async()=>1),$queryRaw:jest.fn(async(parts:any)=>String(parts).includes('FROM users')?state.member?[{id:C}]:[]:String(parts).includes('FROM clients')?[{id:C,name:'Canonical name'}]:[]),
    $queryRawUnsafe:jest.fn(async()=>[{allowed:state.allowed}]),
  };
  db.$transaction=jest.fn(async(fn:any)=>fn(db));
  db.withSystem=jest.fn(async(fn:any)=>fn(db));
  const collab:any={assertCan:jest.fn(async(_t:any,_d:any,_a:any,p:any)=>{if(!p(state.role))throw new ForbiddenException();return state.role;}),resolveRole:jest.fn(async()=>state.role),sourceAccess:jest.fn(async()=>state.allowed)};
  const source:any={requireClient:jest.fn(async()=>{if(!state.member||!state.allowed)throw new NotFoundException();return {id:C,name:'Client',wallAllowed:true};}),userDisplays:jest.fn(async()=>new Map())};
  db.wsHillDayDocument={findFirst:jest.fn(async({where}:any)=>where.tenantId===T&&where.id===D?{...draft,name:'Secret packet',clientName:'Client',status:'draft'}:null),findMany:jest.fn(async()=>[])};
  db.wsHillDayMeeting={findMany:jest.fn(async()=>[]),findFirst:jest.fn(async()=>({id:'meeting',resolution:null,context:null}))};
  db.wsHillDayJob={findFirst:jest.fn(async()=>({id:'job',status:'running',units:[],events:[]}))};
  db.wsHillDayExport={findFirst:jest.fn(async()=>({id:'export',status:'ready',createdAt:new Date()}))};
  return {state,draft,version,request,link,db,collab,source};
}
describe('A1 direct service authority',()=>{
  it.each(['editor','reviewer','viewer',null])('share denies %s before token persistence',async role=>{
    const h=fixture();h.state.role=role;
    await expect(new ShareLinkService(h.db,h.collab).createShareLink(T,D,'actor',{versionId:'version'})).rejects.toMatchObject({status:403});
    expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
  });
  it('revoke denies unrelated actor before update',async()=>{
    const h=fixture();h.state.role=null;
    await expect(new ShareLinkService(h.db,h.collab).revoke(T,D,'share','stranger')).rejects.toMatchObject({status:403});
    expect(h.db.wsShareLink.update).not.toHaveBeenCalled();
  });
  it('share index excludes unauthorized titles and comment counts',async()=>{
    const h=fixture();h.state.role=null;
    expect((await new ShareLinkService(h.db,h.collab).listShares(T,'stranger')).shares).toEqual([]);
    expect(h.db.wsGuestComment.groupBy).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({shareLinkId:{in:[]}})}));
  });
  it.each(['preflight','createRequest'])('%s denies a removed collaborator',async method=>{
    const h=fixture();h.state.role=null;
    await expect((new ApprovalService(h.db,h.collab) as any)[method](T,D,'actor',{versionId:'version'})).rejects.toMatchObject({status:403});
    expect(h.db.wsApprovalRequest.create).not.toHaveBeenCalled();
  });
  it.each(['missing','another-draft'])('share refuses %s saved version',async id=>{
    const h=fixture();
    await expect(new ShareLinkService(h.db,h.collab).createShareLink(T,D,'actor',{versionId:id==='missing'?undefined:id})).rejects.toBeDefined();
    expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
  });
  it('share refuses an unapproved exact frozen revision',async()=>{
    const h=fixture();h.state.required=true;
    (h.version.snapshot.config as any).documentAgent={schemaVersion:1,revision:1,blueprintPin:{blueprintId:'bp',versionId:'bpv',version:1,definitionHash:'h'}};
    h.draft.config=structuredClone(h.version.snapshot.config);
    await expect(new ShareLinkService(h.db,h.collab).createShareLink(T,D,'actor',{versionId:'version'})).rejects.toMatchObject({status:409});
    expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
  });
  it('approval rejects a role excluded by the frozen blueprint',async()=>{
    const h=fixture();h.state.role='reviewer';
    (h.version.snapshot.config as any).documentAgent={schemaVersion:1,revision:1,blueprintPin:{blueprintId:'bp',versionId:'bpv',version:1,definitionHash:'h'}};
    h.draft.config=structuredClone(h.version.snapshot.config);
    await expect(new ApprovalService(h.db,h.collab).decide(T,D,'request','actor','approved')).rejects.toMatchObject({status:403});
    expect(h.db.wsApprovalRequest.update).not.toHaveBeenCalled();
    expect(h.db.wsApprovalRequest.updateMany).not.toHaveBeenCalled();
  });
  it('approval rejects changed content even within one second',async()=>{
    const h=fixture();h.draft.docTitle='Changed after review';
    await expect(new ApprovalService(h.db,h.collab).decide(T,D,'request','actor','approved')).rejects.toMatchObject({status:409});
    expect(h.db.wsApprovalRequest.updateMany).not.toHaveBeenCalled();
  });
  it.each(['removed','revoked','mismatch'])('ordinary owner is denied for %s authority',async reason=>{
    const h=fixture();h.state.member=reason!=='removed';h.state.allowed=reason!=='revoked';
    if(reason==='mismatch')h.draft.config.clientId=D;
    expect(await new CollaboratorsService(h.db,{} as any).resolveRole(T,D,'actor')).toBeNull();
  });
  it.each(['get','quality','job','events','context','resolution','relationships','export'])('Hill Day %s denies revoked client before returning data',async operation=>{
    const h=fixture();h.state.allowed=false;
    const docs=new HillDayDocumentService(h.db,h.source,{} as any,h.collab);
    const generation=new HillDayGenerationService(h.db,h.source,{} as any);
    const resolution=new HillDayResolutionService(h.db,h.source,{} as any);
    const calls:any={get:()=>docs.get(T,D,'actor'),quality:()=>docs.quality(T,D,'actor'),job:()=>generation.jobStatus(T,D,'job','actor'),events:()=>generation.jobEvents(T,D,'job',0,'actor'),context:()=>new HillDayContextService(h.db,h.source).candidates(T,'actor',D,'meeting',null),resolution:()=>resolution.getResolution(T,D,'actor'),relationships:()=>resolution.clientRelationships(T,D,'actor'),export:()=>new HillDayExportService(h.db,docs,{} as any).get(T,D,'export','actor')};
    await expect(calls[operation]()).rejects.toMatchObject({status:404});
    expect(h.db.wsHillDayJob.findFirst).not.toHaveBeenCalled();
    expect(h.db.wsHillDayExport.findFirst).not.toHaveBeenCalled();
    expect(h.db.wsHillDayMeeting.findMany).not.toHaveBeenCalled();
  });
  it.each(['foreign-tenant','wrong-owner','removed-member'])('Hill Day direct document denies %s',async reason=>{
    const h=fixture();h.state.member=reason!=='removed-member';
    await expect(new HillDayDocumentService(h.db,h.source,{} as any,h.collab).assertDoc(reason==='foreign-tenant'?C:T,D,reason==='wrong-owner'?'stranger':'actor')).rejects.toMatchObject({status:404});
  });
  it('draft creation denies a hidden client before writes',async()=>{
    const h=fixture();h.state.allowed=false;
    await expect(new DraftsService(h.db,h.collab).create(T,'actor',{clientId:C})).rejects.toMatchObject({status:404});
    expect(h.db.wsDraft.create).not.toHaveBeenCalled();expect(h.db.wsDocument.create).not.toHaveBeenCalled();
  });
  it('draft creation persists canonical UUID and authoritative name',async()=>{
    const h=fixture();await new DraftsService(h.db,h.collab).create(T,'actor',{clientId:C,client:'Wrong display name'});
    expect(h.db.wsDraft.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({clientId:C,client:'Canonical name',config:expect.objectContaining({clientId:C})})}));
  });
  it('autosave cannot smuggle another client through config',async()=>{
    const h=fixture();await expect(new DraftsService(h.db,h.collab).update(T,D,'actor',{config:{clientId:D}})).rejects.toMatchObject({status:409});
    expect(h.db.wsDraft.update).not.toHaveBeenCalled();
  });
  it('restore cannot replace current client with another revision association',async()=>{
    const h=fixture();h.version.snapshot.config.clientId=D;
    await expect(new VersionsService(h.db,h.collab).restore(T,D,'version','actor')).rejects.toMatchObject({status:409});
    expect(h.db.wsDraft.update).not.toHaveBeenCalled();
  });
});
