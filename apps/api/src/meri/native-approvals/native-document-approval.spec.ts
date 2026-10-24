import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClerkService } from '../../auth/clerk.service.js';
import { NativeApprovalModule } from './native-approval.controller.js';
import { ApplicationCurrentService } from '../../auth/application-current.service.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { NativeApprovalService } from './native-approval.service.js';
import { NativeApprovalMetadataVerifier } from './native-approval-metadata.js';
import { nativeCanonicalSha256 as hash, parseApprovalProposal } from './native-approval.contract.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const binding = { tenantId:id(1), actorId:id(2), conversationId:id(3), runId:id(4), attemptId:id(5), workerId:id(6), writerFence:1 };
function fixture(general = false) {
  const state = { member:true, wall:true, receipt:true, status:'active', actorId:id(2), clientId:general ? null : id(7), unavailable:false };
  const scopes = [{ tenantId:id(1), kind:general ? 'private-user' : 'client', resourceId:general ? id(2) : id(7), policyRevision:'policy1' }];
  const command = { contractVersion:'0.2.0', commandId:id(8), binding, action:'document.draft',
    arguments:{preparationSha256:'a'.repeat(64),artifactRequestSha256:'b'.repeat(64),sourceContextSha256:'c'.repeat(64),baseVersionId:null,title:'Reviewed draft',format:'docx'},
    attachments:[],scopes,idempotencyKey:'document-draft-1' };
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
  const metadata = new NativeApprovalMetadataVerifier(prisma as never,config as never);
  const service = new NativeApprovalService(prisma as never,metadata,current);
  const req = {headers:{'x-internal-service-secret':'synthetic-service-secret'}} as unknown as Request;
  new ToolServiceSecretGuard({get:(name:string)=>name==='NODE_ENV'?'test':name==='INTERNAL_SERVICE_SECRET'?'synthetic-service-secret':false} as never)
    .canActivate({switchToHttp:()=>({getRequest:()=>req})} as unknown as ExecutionContext);
  const ctx = {tenantId:id(1),userId:id(2),role:'standard_user'} as TenantContext;
  const response = () => ({schemaVersion:1,commandSha256:proposal.commandSha256,
    metadata:{record:{operation:{id:'create_word',version:'0.2.0'},action:command.action,binding,request:command.arguments,
      inputSha256:hash({arguments:command.arguments,attachments:[]}),commandId:command.commandId,idempotencyKey:command.idempotencyKey,
      proposalId:proposal.proposalId,scopes:command.scopes,createdAt:proposal.createdAt,expiresAt:proposal.expiresAt,requiredApprover:proposal.requiredApprover},
      commandContext:{binding,scopes:command.scopes},commandSha256:proposal.commandSha256},
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
describe('native document approval through canonical current authority',()=>{
  it('injects the existing current owner into the real approval module',async()=>{
    const f=fixture();
    const module=await Test.createTestingModule({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true}),NativeApprovalModule]})
      .overrideProvider(PrismaService).useValue(f.prisma).overrideProvider(ClerkService).useValue({}).compile();
    try {expect(module.get(NativeApprovalService)).toBeInstanceOf(NativeApprovalService);
      expect((module.get(NativeApprovalService) as any).current).toBe(module.get(ApplicationCurrentService));}
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
