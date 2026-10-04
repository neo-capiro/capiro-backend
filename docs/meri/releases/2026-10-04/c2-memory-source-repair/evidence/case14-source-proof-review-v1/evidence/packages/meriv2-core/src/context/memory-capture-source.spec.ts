import { createHash } from 'node:crypto';
import { signMeriMemoryCaptureSources, verifyMeriMemoryCaptureSources, memoryCaptureSourcePolicyEnabled } from './memory-capture-source';
import type { MeriServerReadonlyCapturePolicy } from './server-readonly-capture';
const id = (n: number) => `${n}`.repeat(8)+'-'+`${n}`.repeat(4)+'-4'+`${n}`.repeat(3)+'-8'+`${n}`.repeat(3)+'-'+`${n}`.repeat(12);
const secret = 'synthetic-memory-capture-unit-secret';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const p = { caseId: '14', captureRunId: id(1), tenantId: id(2), clientId: id(3), policyId: id(4),
    requestId: 'request', traceId: 'trace', turnId: id(5), actorUserId: id(6), conversationId: id(7),
    issuedAt: 1, expiresAt: 100, physicalMapSha256: 'a'.repeat(64), fixtureVersion: 'meri-live-v1-2026-09-26.1',
    semanticClock: { caseId: '14', captureRunId: id(1) } } as MeriServerReadonlyCapturePolicy;
  const text = 'Approved source text.', sourceVersion = 'candidate:'+id(8);
  const record = {domain:'institutional_knowledge',recordId:id(8),
    provenance:{source:'memory_items',recordId:id(8),canonicalTenantId:p.tenantId,sourceVersion},
    payload:{sourceKind:'governed_memory',memoryItemId:id(8),clientId:p.clientId,contentStatus:'available',value:text,
      content:{hash:hash(text+'\0'+sourceVersion),offset:0,endOffset:text.length,totalCharacters:text.length,truncated:false,nextRead:null}}};
  return {p,record};
}
test('memory source proof binds actual row ownership, full projected bytes and policy',()=>{
  const {p,record}=fixture(), proof=signMeriMemoryCaptureSources(p,[record],secret);
  expect(verifyMeriMemoryCaptureSources(p,[record],proof,secret)).toEqual([expect.objectContaining({sourceId:record.recordId,tenantId:p.tenantId,clientId:p.clientId,fullRead:true,passageSha256:hash(record.payload.value)})]);
  record.payload.clientId=null as never;
  expect(signMeriMemoryCaptureSources(p,[record],secret).sources[0]!.clientId).toBeNull();
});
test.each(['signature','record','text','version','tenant','client','policy','trace','turn','extra','missing','duplicate'])('memory source proof rejects %s drift',(fault)=>{
  const {p,record}=fixture(), proof=signMeriMemoryCaptureSources(p,[record],secret), records=[record];
  if(fault==='signature')proof.signature='0'.repeat(64);
  if(fault==='record')record.recordId=id(9);
  if(fault==='text')record.payload.value='Changed source bytes';
  if(fault==='version')record.provenance.sourceVersion='changed';
  if(fault==='tenant')record.provenance.canonicalTenantId=id(9);
  if(fault==='client')record.payload.clientId=id(9);
  if(fault==='policy')p.policyId=id(9);
  if(fault==='trace')p.traceId='changed';
  if(fault==='turn')p.turnId=id(9);
  if(fault==='extra')(proof as any).unexpected=true;
  if(fault==='missing')delete (record.provenance as any).canonicalTenantId;
  if(fault==='duplicate')records.push(record);
  expect(()=>verifyMeriMemoryCaptureSources(p,records,proof,secret)).toThrow();
});
test('partial memory page stays partial and cannot claim a full byte hash',()=>{
  const {p,record}=fixture();record.payload.content.totalCharacters+=30;
  record.payload.content.truncated=true;record.payload.content.nextRead={contentCursor:'next'} as never;
  const proof=signMeriMemoryCaptureSources(p,[record],secret);
  expect(verifyMeriMemoryCaptureSources(p,[record],proof,secret)[0]!.fullRead).toBe(false);
});
test('source proof refuses missing owner/secret, foreign owner and unsupported capture',()=>{
  const {p,record}=fixture();expect(()=>signMeriMemoryCaptureSources(p,[record],undefined)).toThrow();
  expect(memoryCaptureSourcePolicyEnabled({...p,caseId:'20'})).toBe(false);
  expect(()=>signMeriMemoryCaptureSources({...p,caseId:'20'},[record],secret)).toThrow();
  delete (record.provenance as any).canonicalTenantId;
  expect(()=>signMeriMemoryCaptureSources(p,[record],secret)).toThrow();
});
