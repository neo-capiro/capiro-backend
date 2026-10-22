import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShareLinkService } from './share-link.service.js';
import { HillDayDocumentService } from '../hillday/hillday-document.service.js';
import { HillDayGenerationService } from '../hillday/hillday-generation.service.js';
import { HillDayContextService } from '../hillday/hillday-context.service.js';
import { HillDayResolutionService } from '../hillday/hillday-resolution.service.js';
import { HillDayExportService } from '../hillday/hillday-export.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { DraftsService } from '../drafts/drafts.service.js';
import { VersionsService } from '../versions/versions.service.js';
import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { DeliveryController } from './delivery.controller.js';
import { HillDayController } from '../hillday/hillday.controller.js';
// Auth resolution is outside this domain test. Requests carry a fixed synthetic
// active identity; real controller routing and domain service policies execute.
jest.mock('../auth/tenant.guard.js', () => ({ TenantGuard: class { canActivate() { return true; } } }));
jest.mock('../auth/current-tenant.decorator.js', () => ({ CurrentTenant: require('@nestjs/common').createParamDecorator((_data: unknown, ctx: any) => ctx.switchToHttp().getRequest().workspaceTenant) }));
// These admission tests must never render or dispatch an external operation.
jest.mock('pdfkit', () => ({ __esModule: true, default: jest.fn() }), { virtual: true });
const T='11111111-1111-4111-8111-111111111111', C='22222222-2222-4222-8222-222222222222', D='33333333-3333-4333-8333-333333333333';
function fixture() {
  const state={role:'owner' as string|null, member:true, allowed:true};
  const draft={id:D,tenantId:T,ownerId:'actor',clientId:C,client:'Same name',prospectId:null,docTitle:'Private title',config:{clientId:C},ask:null,documents:[],updatedAt:new Date()};
  const snapshot=()=>({docTitle:draft.docTitle,config:structuredClone(draft.config),ask:null,documents:[]});
  const version={id:'version',tenantId:T,draftId:D,snapshot:snapshot()};
  const link={id:'share',draftId:D,tenantId:T,createdById:'actor',versionId:'version',tokenHash:'',expiresAt:null,revokedAt:null,createdAt:new Date(),label:null};
  const db:any={
    wsDraft:{findFirst:jest.fn(async({where}:any)=>where.tenantId===T&&where.id===D?draft:null),findFirstOrThrow:jest.fn(async()=>draft),create:jest.fn(async({data}:any)=>({...draft,...data})),update:jest.fn(async({data}:any)=>Object.assign(draft,data)),findMany:jest.fn(async()=>[draft])},
    wsDocVersion:{findFirst:jest.fn(async({where}:any)=>where.id==='version'&&where.tenantId===T&&where.draftId===D?version:null),create:jest.fn(async({data}:any)=>({...version,...data}))},
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
  db.wsHillDayDocument={findFirst:jest.fn(async({where}:any)=>(!where.tenantId||where.tenantId===T)&&where.id===D?{...draft,name:'Secret packet',clientName:'Client',status:'draft'}:null),findMany:jest.fn(async()=>[])};
  db.wsHillDayMeeting={findMany:jest.fn(async()=>[]),findFirst:jest.fn(async()=>({id:'meeting',resolution:null,context:null}))};
  db.wsHillDayJob={findFirst:jest.fn(async()=>({id:'job',status:'running',units:[],events:[]}))};
  db.wsHillDayExport={findFirst:jest.fn(async()=>({id:'export',status:'ready',createdAt:new Date()}))};
  return {state,draft,version,link,db,collab,source};
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
  it.each(['missing','another-draft'])('share refuses %s saved version',async id=>{
    const h=fixture();
    await expect(new ShareLinkService(h.db,h.collab).createShareLink(T,D,'actor',{versionId:id==='missing'?undefined:id})).rejects.toBeDefined();
    expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
  });
  it('legacy blueprint policy keys do not gate sharing a current saved revision',async()=>{
    const h=fixture();
    const legacyPolicy={clientFacingApprovalRequired:true,permittedApproverRoles:['owner']};
    h.db.wsBlueprintVersion={findFirst:jest.fn(async()=>({definition:{approvalPolicy:legacyPolicy}}))};
    h.db.wsApprovalRequest={findFirst:jest.fn(async()=>null)};
    (h.version.snapshot.config as any).documentAgent={schemaVersion:1,revision:1,blueprintPin:{blueprintId:'bp',versionId:'bpv',version:1,definitionHash:'h'}};
    h.draft.config=structuredClone(h.version.snapshot.config);
    const result=await new ShareLinkService(h.db,h.collab).createShareLink(T,D,'actor',{versionId:'version'});
    expect(result.shareId).toBe('share');
    expect(h.db.wsShareLink.create).toHaveBeenCalledTimes(1);
    expect(h.db.wsBlueprintVersion.findFirst).not.toHaveBeenCalled();
    expect(h.db.wsApprovalRequest.findFirst).not.toHaveBeenCalled();
    expect(legacyPolicy).toEqual({clientFacingApprovalRequired:true,permittedApproverRoles:['owner']});
  });
  it('sharing still refuses a saved revision after the draft content changes',async()=>{
    const h=fixture();h.draft.docTitle='Changed after review';
    await expect(new ShareLinkService(h.db,h.collab).createShareLink(T,D,'actor',{versionId:'version'})).rejects.toMatchObject({status:409});
    expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
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
  it('firm drafts with no client remain readable to their active owner',async()=>{
    const h=fixture();Object.assign(h.draft,{clientId:null,client:null,config:{clientId:null}});
    expect(await new CollaboratorsService(h.db,{} as any).resolveRole(T,D,'actor')).toBe('owner');
  });
  it('held name-only legacy drafts remain readable to their active owner',async()=>{
    const h=fixture();Object.assign(h.draft,{clientId:null,config:{}});
    expect(await new CollaboratorsService(h.db,{} as any).resolveRole(T,D,'actor')).toBe('owner');
  });
  it('an already bound draft cannot be reassigned to another client',async()=>{
    const h=fixture();
    await expect(new DraftsService(h.db,h.collab).update(T,D,'actor',{clientId:D})).rejects.toMatchObject({status:409});
    expect(h.db.wsDraft.update).not.toHaveBeenCalled();
  });
  it('share idempotency cannot return a receipt for a different revision',async()=>{
    const h=fixture();h.link.versionId='old-version';
    await expect(new ShareLinkService(h.db,h.collab).createShareLink(T,D,'actor',{versionId:'version',idempotencyKey:'same-key'})).rejects.toMatchObject({status:409});
    expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
  });
  it.each(['read','comment'])('public token %s stops after its issuer loses current authority',async action=>{
    const h=fixture();h.state.role=null;h.link.tokenHash=createHash('sha256').update('token').digest('hex');
    const service=new ShareLinkService(h.db,h.collab);
    await expect(action==='read'?service.getByToken('token'):service.addGuestComment('token','hello')).rejects.toMatchObject({status:403});
    expect(h.db.wsDocVersion.findFirst).not.toHaveBeenCalled();
    expect(h.db.wsGuestComment.create).not.toHaveBeenCalled();
  });
  it.each([undefined,C])('Hill Day library holds revoked rows with client filter %s',async clientId=>{
    const h=fixture();h.state.allowed=false;
    h.source.resolveUserId=jest.fn(async()=>C);
    h.source.getClient=jest.fn(async()=>({id:C,name:'Client',wallAllowed:true}));
    h.db.wsHillDayDocument.findMany.mockResolvedValue([{id:D,ownerId:'actor',clientId:C,clientName:'Hidden',name:'Secret packet',updatedAt:new Date(),status:'draft'}]);
    const page=await new HillDayDocumentService(h.db,h.source,{} as any,h.collab).listDocuments(T,'actor',{kind:'hillday',clientId});
    expect(page.items).toEqual([]);
  });
  it('invalid Hill Day IDs fail before a database read',async()=>{
    const h=fixture();h.db.wsHillDayDocument.findFirst.mockResolvedValue({...h.draft,id:'invalid'});
    await expect(new HillDayDocumentService(h.db,h.source,{} as any,h.collab).assertDoc(T,'invalid','actor')).rejects.toMatchObject({status:404});
    expect(h.db.wsHillDayDocument.findFirst).not.toHaveBeenCalled();
  });
  it('export URL issuance rechecks authority after loading the export',async()=>{
    const h=fixture();h.db.wsHillDayExport.findFirst.mockImplementation(async()=>{h.state.allowed=false;return {id:'export',documentId:D,status:'ready',createdAt:new Date()};});
    const docs=new HillDayDocumentService(h.db,h.source,{} as any,h.collab);
    await expect(new HillDayExportService(h.db,docs,{} as any).get(T,D,'export','actor')).rejects.toMatchObject({status:404});
  });
});

describe('A1 HTTP authority boundaries',()=>{
  it.each(['preflight','approval-requests','approval-requests/request/decision'])('removed delivery route %s returns 404',async route=>{
    const h=fixture();
    const module=await Test.createTestingModule({
      controllers:[DeliveryController],
      providers:[{provide:ShareLinkService,useValue:new ShareLinkService(h.db,h.collab)}],
    }).compile();
    const app=module.createNestApplication();
    app.use((req:any,_res:any,next:any)=>{req.workspaceTenant={tenantId:T,clerkUserId:'actor'};next();});
    await app.listen(0,'127.0.0.1');
    try {
      const response=await fetch(`${await app.getUrl()}/drafts/${D}/delivery/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({versionId:'version',decision:'approved'})});
      expect(response.status).toBe(404);
      expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(['share','revoke','hillday'])('%s rejects without storage effects',async operation=>{
    const h=fixture();h.state.role=null;h.state.allowed=false;
    const docs=new HillDayDocumentService(h.db,h.source,{} as any,h.collab);
    const module=await Test.createTestingModule({
      controllers:[DeliveryController,HillDayController],
      providers:[
        {provide:ShareLinkService,useValue:new ShareLinkService(h.db,h.collab)},
        {provide:HillDayDocumentService,useValue:docs},
        {provide:HillDayResolutionService,useValue:{}},
        {provide:HillDayContextService,useValue:{}},
        {provide:HillDayGenerationService,useValue:{}},
        {provide:HillDayExportService,useValue:{}},
      ],
    }).compile();
    const app=module.createNestApplication();
    app.use((req:any,_res:any,next:any)=>{req.workspaceTenant={tenantId:T,clerkUserId:'actor'};next();});
    await app.listen(0,'127.0.0.1');
    try {
      const base=`/drafts/${D}/delivery`;
      const path=operation==='share'?`${base}/share-links`:operation==='revoke'?`${base}/share-links/share`:
        `/hillday/documents/${D}`;
      const method=operation==='hillday'?'GET':operation==='revoke'?'DELETE':'POST';
      const response=await fetch(`${await app.getUrl()}${path}`,{method,headers:{'content-type':'application/json'},
        ...(method==='POST'?{body:JSON.stringify({versionId:'version'})}:{})});
      expect(response.status).toBe(operation==='hillday'?404:403);
      const body=await response.text();
      expect(body).not.toContain('Private title');
      expect(body).not.toContain('Secret packet');
      expect(h.db.wsShareLink.create).not.toHaveBeenCalled();
      expect(h.db.wsShareLink.update).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
