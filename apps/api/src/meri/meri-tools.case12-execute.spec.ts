import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { MERI_FIXTURE_SEMANTIC_INSTANT, MERI_FIXTURE_SEMANTIC_ZONE, type MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import { assertMeriCase12BindingInTx } from './meri-case12-capture-authority.js';
import { withMeriToolRequestControl, currentMeriToolCapturePolicy } from './meri-tool-request-control.js';
import { captureApiProviderScopeActive, assertCaptureApiRetrievalPlan, reserveCaptureApiProviderAttempt } from './meri-capture-api-provider-scope.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
jest.mock('./meri-capture-provider-budget-owner.js',()=>({captureProviderBudgetOwner:jest.fn()}));
import { MeriToolsService } from './meri-tools.service.js';
jest.mock('./meri-case12-capture-authority.js',()=>({assertMeriCase12BindingInTx:jest.fn()}));
jest.mock('../program-element/program-element-read.service.js',()=>({ProgramElementReadService:class{}}));
jest.mock('./meri-defense-budget-tool.helpers.js',()=>({}));
// Actual execute() outer scope and authority ordering. Inner tool dispatch and native
// database authority are controlled doubles; request/source HMAC has separate tests.
const id = (n: number) =>
  `${n}`.repeat(8) + '-' + `${n}`.repeat(4) + '-4' + `${n}`.repeat(3) +
  '-8' + `${n}`.repeat(3) + '-' + `${n}`.repeat(12);
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const secret = 'synthetic-memory-source-service-unit-secret';
const ctx = { tenantId: id(1), userId: id(2) } as TenantContext;
const clientId = id(3);
const itemId = id(4);
const text = 'The approved client constraint is to retain the existing launch date.';
const sourceVersion = `candidate:${id(5)}`;


function policy(caseId: '01' | '12' | '14'): MeriServerReadonlyCapturePolicy {
  const issuedAt = Date.now();
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: id(5),
    requestId: id(6),
    traceId: id(7),
    turnId: id(8),
    caseId,
    captureRunId: id(9),
    fixtureVersion: 'meri-live-v1-2026-09-26.1',
    physicalMapSha256: 'a'.repeat(64),
    resetReceiptId: caseId==='12'?null:id(5),
    seedReceiptId: caseId==='12'?null:id(6),
    ...(caseId==='12'?{case12Setup:{setupRunId:id(6),fixtureInstanceId:id(8),setupPlanSha256:'a'.repeat(64),setupClaimSha256:'b'.repeat(64),setupLedgerSha256:'c'.repeat(64)}}:{}),
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: ctx.tenantId,
    tenantSlug: 'meri-foundation-20260928-t1',
    actorUserId: ctx.userId,
    conversationId: id(7),
    clientId,
    issuedAt,
    expiresAt: issuedAt + 60_000,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: 'b'.repeat(64),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
    ],
    semanticClock: {
      version: 1,
      kind: 'qualified_original_fixture_semantic_clock',
      instant: MERI_FIXTURE_SEMANTIC_INSTANT,
      timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
      caseId,
      captureRunId: id(9),
      observedAt: issuedAt,
      currentVerifySha256: 'c'.repeat(64),
    },
  };
}


let fetchSpy: jest.SpyInstance;
beforeEach(()=>{
  jest.mocked(assertMeriCase12BindingInTx).mockReset();
  jest.mocked(captureProviderBudgetOwner).mockReset().mockResolvedValue({dispatchAllowed:true,reservationId:id(1)} as never);
  fetchSpy=jest.spyOn(globalThis,'fetch').mockRejectedValue(new Error('External fetch forbidden'));
});
afterEach(()=>{expect(fetchSpy).not.toHaveBeenCalled();fetchSpy.mockRestore();});
function fixture(caseId:'01'|'12'|'14'='12') {
  const capture=policy(caseId);
  capture.expectedCaptureWrites = ['context_packet_and_evidence', 'conversation_user_message',
    'conversation_assistant_message', 'provider_budget_ledger'];
  const events:string[]=[];const transactions:object[]=[];const wire=jest.fn();
  const prisma={withTenantUser:jest.fn(async(tenant:string,user:string,fn:(tx:object)=>Promise<unknown>)=>{
    expect([tenant,user]).toEqual([ctx.tenantId,ctx.userId]);const tx=Object.freeze({number:transactions.length+1});transactions.push(tx);return fn(tx);
  })};
  jest.mocked(assertMeriCase12BindingInTx).mockImplementation(async(p,tx,c,cap)=>{
    expect(p).toBe(prisma);expect(c).toBe(ctx);expect(cap).toBe(capture);
    expect(currentMeriToolCapturePolicy()).toBe(capture);expect(captureApiProviderScopeActive()).toBe(true);
    expect(transactions).toContain(tx);events.push('owner');return {currentVerifySha256:capture.semanticClock!.currentVerifySha256} as never;
  });
  const service=Object.create(MeriToolsService.prototype) as MeriToolsService;
  Object.defineProperty(service,'prisma',{value:prisma});
  const callback=jest.spyOn(service as any,'executeScoped').mockImplementation(async(...args:unknown[])=>{
    expect(args[0]).toBe(ctx);expect(currentMeriToolCapturePolicy()).toBe(capture);
    expect(captureApiProviderScopeActive()).toBe(true);
    assertCaptureApiRetrievalPlan({subjectScope:'client',requestedDomains:['institutional_knowledge']});
    expect(()=>assertCaptureApiRetrievalPlan({subjectScope:'client',requestedDomains:['contacts']})).toThrow('meri_capture_provider_budget_unqualified_retrieval_plan');
    const reservation=await reserveCaptureApiProviderAttempt({kind:'bedrock_embeddings',provider:'aws-bedrock',model:'amazon.titan-embed-text-v2:0',inputBytes:128});
    expect((reservation as any).policy).toBe(capture);expect(jest.mocked(captureProviderBudgetOwner).mock.calls.at(-1)![0]).toMatchObject({prisma,ctx,policy:capture});
    expect(jest.mocked(captureProviderBudgetOwner).mock.calls.at(-1)![0].policy).toBe(capture);
    events.push('callback');wire();return {text:'approved source',observedAt:Date.now(),semanticInstant:capture.semanticClock!.instant};
  });
  const run=(name:string='search_memory')=>{
    // Non-search route name avoids decoding a request HMAC here; those exact codecs
    // are independently covered by source+loopback tests. Policy ALS is actual.
    const req=Object.assign(new EventEmitter(),{params:{name:'wrapper_control_test'},body:{},headers:{},aborted:false,res:Object.assign(new EventEmitter(),{writableEnded:false,destroyed:false})}) as unknown as Request;
    return withMeriToolRequestControl(req,()=>service.execute(ctx,name as never,{query:'approved launch constraint',clientId}),capture);
  };
  return {capture,events,transactions,wire,prisma,callback,service,run};
}
describe('Case12 execute outer scope',()=>{
  it('valid search keeps exact policy within funded scope and checks native owner before and after',async()=>{
    const h=fixture();const before=Date.now();const result=await h.run() as any;
    expect(h.events).toEqual(['owner','callback','owner']);expect(h.wire).toHaveBeenCalledTimes(1);
    expect(h.transactions).toHaveLength(2);expect(h.transactions[0]).not.toBe(h.transactions[1]);
    expect(result.observedAt).toBeGreaterThanOrEqual(before);expect(result.semanticInstant).toBe(MERI_FIXTURE_SEMANTIC_INSTANT);
    expect(currentMeriToolCapturePolicy()).toBeNull();expect(captureApiProviderScopeActive()).toBe(false);
  });
  it.each(['list_memory_proposals','save_memory'])('denies %s before native authority or callback',async name=>{
    const h=fixture();await expect(h.run(name)).rejects.toThrow('meri_capture_provider_budget_unqualified_tool');
    expect(assertMeriCase12BindingInTx).not.toHaveBeenCalled();expect(h.callback).not.toHaveBeenCalled();expect(h.wire).not.toHaveBeenCalled();expect(captureProviderBudgetOwner).not.toHaveBeenCalled();
  });
  it('native revocation before execution prevents callback and wire',async()=>{
    const h=fixture();jest.mocked(assertMeriCase12BindingInTx).mockRejectedValueOnce(new Error('NATIVE_CASE12_REVOKED_BEFORE'));
    await expect(h.run()).rejects.toThrow('NATIVE_CASE12_REVOKED_BEFORE');expect(h.callback).not.toHaveBeenCalled();expect(h.wire).not.toHaveBeenCalled();expect(captureProviderBudgetOwner).not.toHaveBeenCalled();
    expect(captureApiProviderScopeActive()).toBe(false);
  });
  it('native revocation after execution rejects otherwise available result',async()=>{
    const h=fixture();const original=jest.mocked(assertMeriCase12BindingInTx).getMockImplementation()!;
    jest.mocked(assertMeriCase12BindingInTx).mockImplementationOnce(original).mockRejectedValueOnce(new Error('NATIVE_CASE12_REVOKED_AFTER'));
    await expect(h.run()).rejects.toThrow('NATIVE_CASE12_REVOKED_AFTER');expect(h.callback).toHaveBeenCalledTimes(1);expect(h.wire).toHaveBeenCalledTimes(1);
    expect(assertMeriCase12BindingInTx).toHaveBeenCalledTimes(2);expect(captureApiProviderScopeActive()).toBe(false);
  });
  it('inner rejection propagates and no second native read or result occurs',async()=>{
    const h=fixture();h.callback.mockRejectedValueOnce(new Error('INNER_FAILED'));
    await expect(h.run()).rejects.toThrow('INNER_FAILED');expect(assertMeriCase12BindingInTx).toHaveBeenCalledTimes(1);expect(h.wire).not.toHaveBeenCalled();
  });
  it.each(['01','14'] as const)('preserves existing %s search and discovery allowance without Case12 owner',async caseId=>{
    const h=fixture(caseId);await h.run('search_memory');await h.run('list_memory_proposals');
    expect(h.callback).toHaveBeenCalledTimes(2);expect(assertMeriCase12BindingInTx).not.toHaveBeenCalled();expect(h.transactions).toHaveLength(0);
  });
});
