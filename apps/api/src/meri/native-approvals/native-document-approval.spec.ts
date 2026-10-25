import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException, Module, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClerkService } from '../../auth/clerk.service.js';
import { NativeApprovalModule } from './native-approval.controller.js';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { EngagementService } from '../../engagement/engagement.service.js';
import { MeriExecutionReceiverService } from '../execution-capability/meri-execution-receiver.service.js';
import { ApplicationCurrentService } from '../../auth/application-current.service.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { NativeApprovalService } from './native-approval.service.js';
import { NativeApprovalMetadataVerifier } from './native-approval-metadata.js';
import { nativeCanonicalSha256 as hash, parseApprovalProposal, type NativeCommand } from './native-approval.contract.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const binding = { tenantId:id(1), actorId:id(2), conversationId:id(3), runId:id(4), attemptId:id(5), workerId:id(6), writerFence:1 };
@Module({providers:[{provide:EngagementService,useValue:{}}],exports:[EngagementService]})
class FocusedEngagementModule {}
function fixture(general = false, action = 'document.draft') {
  const state = { member:true, wall:true, destinationVisible:true, receipt:true, status:'active', actorId:id(2), clientId:general ? null : id(7), unavailable:false };
  const scopes = [{ tenantId:id(1), kind:general ? 'private-user' : 'client', resourceId:general ? id(2) : id(7), policyRevision:'policy1' }];
  const command: NativeCommand = { contractVersion:action === 'task.create' || action === 'artifact.file' ? '0.1.0' : '0.2.0', commandId:id(8), binding, action,
    arguments:action === 'task.create' ? {title:'Reviewed task',clientId:null,dueDate:null}
      : action === 'task.update' ? {taskId:id(11),mode:'unconditional_patch',patch:{status:'todo'}}
        : action === 'artifact.file' ? {clientId:id(7),conversationId:binding.conversationId}
        : {preparationSha256:'a'.repeat(64),artifactRequestSha256:'b'.repeat(64),sourceContextSha256:'c'.repeat(64),baseVersionId:null,title:'Reviewed draft',format:'docx'},
    attachments:action === 'artifact.file' ? [{objectId:id(170),versionId:'opaque-storage-version',sha256:'f'.repeat(64),bytes:128,scopes}] : [],
    scopes,idempotencyKey:'document-draft-1' };
  const proposal = { proposalId:id(9),command,commandSha256:hash(command),createdAt:new Date(Date.now()-1000).toISOString(),
    expiresAt:new Date(Date.now()+60000).toISOString(),requiredApprover:{tenantId:id(1),actorId:id(2)} };
  const rows = new Map<string,any>(), revoked = new Set<string>();
  const tx = {
    clioConversation:{findFirst:jest.fn(async()=>({id:id(3),tenantId:id(1),userId:state.actorId,clientId:state.clientId,status:state.status,archivedAt:null,metadata:{}}))},
    clioConversationBootstrapReceipt:{findFirst:jest.fn(async()=>state.receipt ? {requestId:id(10)} : null)},
    client:{findFirst:jest.fn(async()=>({id:id(7)}))},
    clioMeriApprovalDecision:{findUnique:jest.fn(async({where}:any)=>rows.get(where.tenantId_proposalId.proposalId)??null),
      create:jest.fn(async({data}:any)=>{rows.set(data.proposalId,data);return data;})},
    clioMeriApprovalRevocation:{findUnique:jest.fn(async({where}:any)=>revoked.has(where.tenantId_proposalId.proposalId)?{}:null),
      createMany:jest.fn(async({data}:any)=>{for(const r of data)revoked.add(r.proposalId);return {count:data.length};})},
    $queryRaw:jest.fn(async(query:TemplateStringsArray,...values:unknown[])=>{
      if(query.join('?').includes('FROM clients')){
        expect(values).toEqual([id(1),[id(7)],id(2)]);
        return state.destinationVisible?[{id:id(7)}]:[];
      }
      expect(query.join('?')).toContain("pg_advisory_xact_lock(");
      expect(query.join('?')).toContain("capiro-meri-execution:");
      expect(query.join('?')).not.toContain('run_facts_v1');
      expect(values).toEqual([id(1),id(9)]);return [{locked:''}];
    }),
    $executeRaw:jest.fn(async()=>0),
  };
  const prisma = {withTenant:jest.fn(async(tenant:string,run:any)=>{expect(tenant).toBe(id(1));return run(tx);}),
    withSystem:jest.fn(async(run:any,options:any)=>{expect(options).toEqual({isolationLevel:'RepeatableRead',readOnly:true});if(state.unavailable)throw Error('DB unavailable');return run(tx);})};
  const identity = {principal:{tenantId:id(1),actorId:id(2)},identityRevision:'d'.repeat(64),expiresAtMs:Date.now()+60000};
  const tenant = {readApplicationAuthoritySession:jest.fn(async()=>({readCurrent:async()=>identity}))};
  const membership = {readInTransaction:jest.fn(async()=>{if(!state.member)throw new ForbiddenException();return {role:'standard_user',permissions:[],clientIds:general?[]:[id(7)],membershipRevision:'e'.repeat(64)};})};
  const wall = {resolveApplicationAuthorityClient:jest.fn(async()=>{if(!state.wall)throw new ForbiddenException();return ['wall',false];})};
  const current = new ApplicationCurrentService(prisma as never,tenant as never,wall as never,{} as never,membership as never);
  const config = {get:(name:string)=>name==='MERI_CONTROL_ORIGIN'?'https://control.synthetic.invalid':name==='INTERNAL_SERVICE_SECRET'?'synthetic-service-secret':undefined};
  const metadata = new NativeApprovalMetadataVerifier(config as never);
  const service = new NativeApprovalService(prisma as never,metadata,current);
  const req = {headers:{'x-internal-service-secret':'synthetic-service-secret'}} as unknown as Request;
  new ToolServiceSecretGuard({get:(name:string)=>name==='NODE_ENV'?'test':name==='INTERNAL_SERVICE_SECRET'?'synthetic-service-secret':false} as never)
    .canActivate({switchToHttp:()=>({getRequest:()=>req})} as unknown as ExecutionContext);
  const ctx = {tenantId:id(1),userId:id(2),role:'standard_user'} as TenantContext;
  const response = () => ({schemaVersion:1,commandSha256:proposal.commandSha256,
    metadata:{record:{operation:{id:action === 'task.create' ? 'create_task' : action === 'task.update' ? 'update_task' : action === 'artifact.file' ? 'save_chat_attachments' : 'create_word',version:'0.2.0'},action:command.action,binding,
      request:action === 'task.create' ? {title:'  Reviewed task  '} : action === 'task.update' ? {taskId:id(11),status:' OPEN ',title:null,dueDate:''}
        : action === 'artifact.file' ? {...command.arguments,objects:command.attachments} : command.arguments,
      inputSha256:hash({arguments:command.arguments,attachments:command.attachments}),commandId:command.commandId,idempotencyKey:command.idempotencyKey,
      proposalId:proposal.proposalId,scopes:command.scopes,createdAt:proposal.createdAt,expiresAt:proposal.expiresAt,requiredApprover:proposal.requiredApprover},
      commandContext:action === 'task.create' ? {binding,clientResolution:null} : action === 'task.update' ? {binding}
        : action === 'artifact.file' ? {binding,destination:command.arguments} : {binding,scopes:command.scopes},commandSha256:proposal.commandSha256},
    run:{binding,scopes:command.scopes,state:'completed',versions:{test:'fixture'}}});
  const fetcher = jest.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    expect(String(url)).toBe('https://control.synthetic.invalid/v1/internal/approval-metadata/read');
    expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({'content-type':'application/json','x-internal-service-secret':'synthetic-service-secret'});
    expect(JSON.parse(init?.body as string)).toEqual({schemaVersion:1,proposalId:proposal.proposalId,binding});
    return Response.json(response());
  });
  return {state,command,proposal,rows,tx,prisma,service,req,ctx,metadata,response,fetcher,identity,membership,
    record:()=>service.record(req,ctx,{proposal,decision:'approved',approver:{tenantId:id(1),actorId:id(2)},binding})};
}
afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();});
function initialResponse(f: ReturnType<typeof fixture>) {
  const response:any=f.response();delete response.run;
  const record={schemaVersion:1,state:'ADMITTED',binding,selectedClientId:f.state.clientId,policyRevision:'policy1',
    versions:{imageDigest:`sha256:${'a'.repeat(64)}`,sdk:'0.3.295',cli:'2.1.295',contracts:'0.1.0',skillsDigest:'b'.repeat(64),checkpointFormat:'0.1.0'},
    configurationSha256:'c'.repeat(64),createdAtMs:Date.parse(f.proposal.createdAt)-1000,expiresAtMs:Date.now()+60000};
  response.preparation={kind:'initial-binding',record,recordSha256:hash(record),generation:1,latestGeneration:1,started:false};
  return response;
}
describe.each(['task.create','task.update'])('native %s initial preparation current authority',action=>{
  it.each([false,true])('approves immutable initial custody without a started run, General=%s',async general=>{
    const f=fixture(general,action);f.fetcher.mockImplementation(async()=>Response.json(initialResponse(f)));
    await expect(f.record()).resolves.toMatchObject({decision:{decision:'approved'}});
    expect([...f.rows.values()][0].runId).toBe(binding.runId);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('keeps the attended deadline after initial admission expiry, supersession and a later started turn',async()=>{
    const f=fixture(true,action),response=initialResponse(f),preparation=response.preparation;
    preparation.latestGeneration=2;preparation.started=true;
    preparation.record.expiresAtMs=Date.now()-1;preparation.recordSha256=hash(preparation.record);
    f.fetcher.mockImplementation(async()=>Response.json(response));
    const observed=await f.service.verifyPrepared(f.req,f.ctx,parseApprovalProposal(f.proposal));
    expect(observed.expiresAtMs).toBeGreaterThan(Date.now());
    expect(observed).toEqual({selectedClientId:null,policyRevision:'policy1',expiresAtMs:f.identity.expiresAtMs});
  });
  it('requires current membership even for retained initial custody',async()=>{
    const f=fixture(true,action);f.state.member=false;
    f.fetcher.mockImplementation(async()=>Response.json(initialResponse(f)));
    await expect(f.service.verifyPrepared(f.req,f.ctx,parseApprovalProposal(f.proposal))).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
describe.each(['task.create','task.update'])('native %s approval through current authority', action=>{
  it.each([false,true])('approves completed preparation in a current attended session, General=%s',async general=>{
    const f=fixture(general,action),result=await f.record();
    expect(result.decision?.decision).toBe('approved');
    expect(result.decision?.commandSha256).toBe(f.proposal.commandSha256);
    expect([...f.rows.values()][0].runId).toBe(binding.runId);
    expect(f.membership.readInTransaction).toHaveBeenCalledTimes(2);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(['member','wall','actor','client','inactive','general-receipt'])('refuses changed %s before readback',async kind=>{
    const f=fixture(kind==='general-receipt',action);
    if(kind==='member')f.state.member=false;if(kind==='wall')f.state.wall=false;if(kind==='actor')f.state.actorId=id(99);
    if(kind==='client')f.state.clientId=id(99);if(kind==='inactive')f.state.status='archived';if(kind==='general-receipt')f.state.receipt=false;
    await expect(f.record()).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.fetcher).not.toHaveBeenCalled();expect(f.rows.size).toBe(0);
  });
  it.each(['member','wall','session','expiry'])('rechecks %s after metadata I/O',async kind=>{
    const f=fixture(false,action);
    f.fetcher.mockImplementationOnce(async()=>{
      const result=f.response();if(kind==='member')f.state.member=false;if(kind==='wall')f.state.wall=false;
      if(kind==='session')f.identity.expiresAtMs=Date.now()-1;
      if(kind==='expiry'){const at=Date.parse(f.proposal.expiresAt)+1;f.identity.expiresAtMs=at+60000;jest.spyOn(Date,'now').mockReturnValue(at);}
      return Response.json(result);
    });
    await expect(f.record()).rejects.toThrow();expect(f.rows.size).toBe(0);
  });
  it('verifies expired immutable metadata for a historical read without accepting a new decision',async()=>{
    const f=fixture(true,action);f.proposal.createdAt=new Date(Date.now()-120000).toISOString();f.proposal.expiresAt=new Date(Date.now()-60000).toISOString();
    await expect(f.service.verifyPrepared(f.req,f.ctx,parseApprovalProposal(f.proposal))).resolves.toEqual({
      selectedClientId:null,policyRevision:'policy1',expiresAtMs:expect.any(Number),
    });
    await expect(f.record()).rejects.toBeInstanceOf(ConflictException);expect(f.rows.size).toBe(0);
  });
  it('does not relabel the original preparation binding as a later attended run',async()=>{
    const f=fixture(false,action);
    await expect(f.service.record(f.req,f.ctx,{proposal:f.proposal,decision:'approved',approver:f.proposal.requiredApprover,
      binding:{...binding,runId:id(90)}})).rejects.toBeInstanceOf(ConflictException);
    expect(f.fetcher).not.toHaveBeenCalled();expect(f.rows.size).toBe(0);
  });
});
describe('native artifact filing approval through canonical current authority',()=>{
  it.each(['completed-run','initial-binding'])('records one decision for exact selected-client %s custody',async custody=>{
    const f=fixture(false,'artifact.file');
    if(custody==='initial-binding')f.fetcher.mockImplementation(async()=>Response.json(initialResponse(f)));
    const first=await f.record();
    expect(first.decision).toMatchObject({decision:'approved',commandSha256:f.proposal.commandSha256,policyRevision:'policy1'});
    const repeat=await f.service.record(f.req,f.ctx,{proposal:f.proposal,decision:'rejected',approver:f.proposal.requiredApprover,binding});
    expect(repeat.decision).toEqual(first.decision);expect(f.rows.size).toBe(1);
    expect(f.membership.readInTransaction).toHaveBeenCalledTimes(4);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(['general','destination','object-scope','extra-scope','member','wall','actor','client','inactive'])
    ('rejects changed %s before private metadata or decision',async kind=>{
      const f=fixture(kind==='general','artifact.file');
      if(kind==='destination')f.command.arguments.clientId=id(99);
      if(kind==='object-scope')(f.command.attachments[0] as any).scopes=[{...f.command.scopes[0],resourceId:id(99)}];
      if(kind==='extra-scope')f.command.scopes.push({tenantId:id(1),kind:'document',resourceId:id(20),policyRevision:'policy1'});
      if(kind==='member')f.state.member=false;if(kind==='wall')f.state.wall=false;if(kind==='actor')f.state.actorId=id(99);
      if(kind==='client')f.state.clientId=id(99);if(kind==='inactive')f.state.status='archived';
      f.proposal.commandSha256=hash(f.command);
      await expect(f.record()).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.fetcher).not.toHaveBeenCalled();expect(f.rows.size).toBe(0);
    });
  it.each(['member','wall','client','session'])('rechecks current %s after metadata I/O',async kind=>{
    const f=fixture(false,'artifact.file');
    f.fetcher.mockImplementationOnce(async()=>{const response=f.response();
      if(kind==='member')f.state.member=false;if(kind==='wall')f.state.wall=false;if(kind==='client')f.state.clientId=id(99);
      if(kind==='session')f.identity.expiresAtMs=Date.now()-1;
      return Response.json(response);
    });
    await expect(f.record()).rejects.toBeInstanceOf(ForbiddenException);expect(f.rows.size).toBe(0);
  });
  it('retains original custody after initial expiry, supersession and a started turn',async()=>{
    const f=fixture(false,'artifact.file'),response=initialResponse(f);
    response.preparation.latestGeneration=2;response.preparation.started=true;
    response.preparation.record.expiresAtMs=Date.parse(f.proposal.createdAt);
    response.preparation.recordSha256=hash(response.preparation.record);
    f.fetcher.mockImplementation(async()=>Response.json(response));
    await expect(f.service.verifyPrepared(f.req,f.ctx,parseApprovalProposal(f.proposal))).resolves.toEqual({
      selectedClientId:id(7),policyRevision:'policy1',expiresAtMs:f.identity.expiresAtMs,
    });
  });
  it('permits retained failed-run metadata for historical reads but refuses a new expired decision',async()=>{
    const f=fixture(false,'artifact.file');f.proposal.createdAt=new Date(Date.now()-120000).toISOString();
    f.proposal.expiresAt=new Date(Date.now()-60000).toISOString();
    f.fetcher.mockImplementation(async()=>{const response=f.response();response.run.state='failed';return Response.json(response);});
    await expect(f.service.verifyPrepared(f.req,f.ctx,parseApprovalProposal(f.proposal))).resolves.toMatchObject({selectedClientId:id(7)});
    await expect(f.record()).rejects.toBeInstanceOf(ConflictException);expect(f.rows.size).toBe(0);
  });
  it('preserves the existing revocation lock and original decision binding',async()=>{
    const f=fixture(false,'artifact.file');await f.record();
    const body={proposalId:f.proposal.proposalId,commandSha256:f.proposal.commandSha256,binding,approver:f.proposal.requiredApprover};
    expect((await f.service.revoke(f.req,f.ctx,body)).revoked).toBe(true);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
    await expect(f.service.record(f.req,f.ctx,{proposal:f.proposal,decision:'approved',approver:body.approver,
      binding:{...binding,runId:id(99)}})).rejects.toBeInstanceOf(ConflictException);
    expect(f.rows.size).toBe(1);
  });
});

describe('native task create selected destination',()=>{
  it.each(['allowed','walled','changed-wall'])('checks General explicit client through the existing client wall predicate (%s)',async kind=>{
    const f=fixture(true,'task.create');f.command.arguments.clientId=id(7);f.proposal.commandSha256=hash(f.command);
    f.state.destinationVisible=kind!=='walled';
    f.fetcher.mockImplementation(async()=>{
      const result:any=f.response();result.metadata.record.request.clientId='Selected client';
      result.metadata.commandContext.clientResolution={reference:'Selected client',clientId:id(7)};
      if(kind==='changed-wall')f.state.destinationVisible=false;
      return Response.json(result);
    });
    if(kind==='allowed'){await expect(f.record()).resolves.toMatchObject({decision:{decision:'approved'}});expect(f.rows.size).toBe(1);}
    else {await expect(f.record()).rejects.toBeInstanceOf(ForbiddenException);expect(f.rows.size).toBe(0);}
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(kind==='walled'?1:2);
  });
  it('refuses a client destination outside the selected client conversation',async()=>{
    const f=fixture(false,'task.create');f.command.arguments.clientId=id(99);f.proposal.commandSha256=hash(f.command);
    await expect(f.record()).rejects.toBeInstanceOf(ForbiddenException);expect(f.fetcher).not.toHaveBeenCalled();
  });
});
describe('native document approval through canonical current authority',()=>{
  it('keeps initial-binding preparation unavailable to document proposals',async()=>{
    const f=fixture(true);f.fetcher.mockImplementation(async()=>Response.json(initialResponse(f)));
    await expect(f.record()).rejects.toBeInstanceOf(ConflictException);expect(f.rows.size).toBe(0);
  });
  it('injects the existing current owner into the real approval module',async()=>{
    const f=fixture();
    const module=await Test.createTestingModule({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true}),NativeApprovalModule]})
      .overrideModule(EngagementModule).useModule(FocusedEngagementModule)
      .overrideProvider(PrismaService).useValue(f.prisma).overrideProvider(ClerkService).useValue({}).compile();
    try {expect(module.get(NativeApprovalService)).toBeInstanceOf(NativeApprovalService);
      expect((module.get(NativeApprovalService) as any).current).toBe(module.get(ApplicationCurrentService));
      expect(module.get(MeriExecutionReceiverService)).toBeInstanceOf(MeriExecutionReceiverService);}
    finally {await module.close();}
  });
  it.each([false,true])('records immutable actual document decision with General=%s',async general=>{
    const f=fixture(general),first=await f.record();
    expect(first.decision?.commandSha256).toBe(f.proposal.commandSha256);expect(first.decision?.decision).toBe('approved');
    const second=await f.record();expect(second.decision).toEqual(first.decision);expect(f.rows.size).toBe(1);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();expect(f.membership.readInTransaction).toHaveBeenCalledTimes(4);
  });
  it('keeps the existing decision/revocation receipt, without executing a task or document',async()=>{
    const f=fixture();await f.record();
    const body={proposalId:f.proposal.proposalId,commandSha256:f.proposal.commandSha256,binding};
    expect((await f.service.decision(f.req,f.ctx,body)).revoked).toBe(false);
    expect((await f.service.revoke(f.req,f.ctx,{...body,approver:{tenantId:id(1),actorId:id(2)}})).revoked).toBe(true);
    expect((await f.service.decision(f.req,f.ctx,body)).revoked).toBe(true);expect(f.rows.size).toBe(1);
  });
  it('preserves exact additional admitted scopes on a client run',async()=>{
    const f=fixture();f.command.scopes.push({tenantId:id(1),kind:'document',resourceId:id(20),policyRevision:'policy1'});
    f.proposal.commandSha256=hash(f.command);
    expect((await f.record()).decision?.commandSha256).toBe(f.proposal.commandSha256);
  });
  it.each(['queued','starting','running','paused','waiting-for-approval','completed'])('accepts stored %s state without a compute credential',async state=>{
    const f=fixture();f.fetcher.mockImplementationOnce(async()=>Response.json({...f.response(),run:{...f.response().run,state}}));
    expect((await f.record()).decision?.decision).toBe('approved');expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(['member','wall','actor','client','inactive','general-receipt'])('refuses current %s before private metadata or decision',async kind=>{
    const f=fixture(kind==='general-receipt');
    if(kind==='member')f.state.member=false;if(kind==='wall')f.state.wall=false;if(kind==='actor')f.state.actorId=id(99);
    if(kind==='client')f.state.clientId=id(99);if(kind==='inactive')f.state.status='archived';if(kind==='general-receipt')f.state.receipt=false;
    await expect(f.record()).rejects.toBeInstanceOf(ForbiddenException);expect(f.fetcher).not.toHaveBeenCalled();expect(f.rows.size).toBe(0);
  });
  it.each(['member','wall','expiry'])('rechecks %s after metadata I/O before decision',async kind=>{
    const f=fixture();f.fetcher.mockImplementationOnce(async()=>{const r=f.response();if(kind==='member')f.state.member=false;if(kind==='wall')f.state.wall=false;
      if(kind==='expiry') { const afterExpiry=Date.parse(f.proposal.expiresAt)+1; f.identity.expiresAtMs=afterExpiry+60000; jest.spyOn(Date,'now').mockReturnValue(afterExpiry); }
      return Response.json(r);});
    await expect(f.record()).rejects.toThrow();expect(f.rows.size).toBe(0);
  });
  it.each(['binding','scope','hash','argument','extra','cancelled'])('rejects stored %s mismatch without writing',async kind=>{
    const f=fixture();f.fetcher.mockImplementationOnce(async()=>{const r:any=f.response();
      if(kind==='binding')r.run.binding={...binding,runId:id(99)};if(kind==='scope')r.run.scopes=[];
      if(kind==='hash')r.commandSha256='0'.repeat(64);if(kind==='argument')r.metadata.record.request={...f.command.arguments,title:'Other'};
      if(kind==='extra')r.extra=true;if(kind==='cancelled')r.run.state='cancelled';return Response.json(r);});
    await expect(f.record()).rejects.toBeInstanceOf(ConflictException);expect(f.rows.size).toBe(0);
  });
  it.each(['status','malformed','oversize','transport'])('preserves %s read unavailability without retry',async kind=>{
    const f=fixture();f.fetcher.mockImplementationOnce(async()=>{if(kind==='transport')throw Error('private network details');
      if(kind==='status')return new Response('',{status:503});if(kind==='malformed')return new Response('{');return new Response('x'.repeat(256*1024+1));});
    await expect(f.record()).rejects.toBeInstanceOf(ServiceUnavailableException);expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.rows.size).toBe(0);
  });
  it('aborts the single private request at its existing bounded deadline',async()=>{
    const f=fixture();jest.useFakeTimers();
    f.fetcher.mockImplementationOnce(async(_url,init)=>new Promise((_resolve,reject)=>{
      init?.signal?.addEventListener('abort',()=>reject(Error('request aborted')),{once:true});
    }));
    const result=expect(f.metadata.verify(parseApprovalProposal(f.proposal))).rejects.toBeInstanceOf(ServiceUnavailableException);
    await jest.advanceTimersByTimeAsync(3000);await result;
    expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.rows.size).toBe(0);
  });
  it('keeps document0.2 closed and does not reinterpret any task0.1 command',()=>{
    const f=fixture();expect(parseApprovalProposal(f.proposal).command.contractVersion).toBe('0.2.0');
    for(const delta of [{contractVersion:'0.1.0'},{action:'task.create'},{attachments:[{}]},
      {arguments:{...f.command.arguments,title:' padded '}},{arguments:{...f.command.arguments,format:'pdf'}},
      {arguments:{...f.command.arguments,preparationSha256:'A'.repeat(64)}},{arguments:{...f.command.arguments,extra:true}}]){
      const command={...f.command,...delta};expect(()=>parseApprovalProposal({...f.proposal,command,commandSha256:hash(command)})).toThrow(BadRequestException);
    }
  });
});
