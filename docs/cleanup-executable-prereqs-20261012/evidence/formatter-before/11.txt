import { createHash } from 'node:crypto';
import {
  signMeriMemoryCaptureSources,
  verifyMeriMemoryCaptureSources,
  memoryCaptureSourcePolicyEnabled,
  encodeMeriMemoryCaptureRequest,
  decodeMeriMemoryCaptureRequest,
} from './memory-capture-source';
import type { MeriServerReadonlyCapturePolicy } from './server-readonly-capture';
const id = (n: number) =>
  `${n}`.repeat(8) +
  '-' +
  `${n}`.repeat(4) +
  '-4' +
  `${n}`.repeat(3) +
  '-8' +
  `${n}`.repeat(3) +
  '-' +
  `${n}`.repeat(12);
const secret = 'synthetic-memory-capture-unit-secret';
const request = { callId: 'tool-call', nonce: id(9), inputSha256: 'a'.repeat(64) };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const p = {
    caseId: '14',
    captureRunId: id(1),
    tenantId: id(2),
    clientId: id(3),
    policyId: id(4),
    requestId: 'request',
    traceId: 'trace',
    turnId: id(5),
    actorUserId: id(6),
    conversationId: id(7),
    issuedAt: 1,
    expiresAt: 100,
    physicalMapSha256: 'a'.repeat(64),
    fixtureVersion: 'meri-live-v1-2026-09-26.1',
    semanticClock: { caseId: '14', captureRunId: id(1) },
  } as MeriServerReadonlyCapturePolicy;
  const text = 'Approved source text.',
    sourceVersion = 'candidate:' + id(8);
  const record = {
    domain: 'institutional_knowledge',
    recordId: id(8),
    provenance: {
      source: 'memory_items',
      recordId: id(8),
      canonicalTenantId: p.tenantId,
      sourceVersion,
    },
    payload: {
      sourceKind: 'governed_memory',
      memoryItemId: id(8),
      clientId: p.clientId,
      contentStatus: 'available',
      value: text,
      content: {
        hash: hash(text + '\0' + sourceVersion),
        offset: 0,
        endOffset: text.length,
        totalCharacters: text.length,
        truncated: false,
        nextRead: null,
      },
    },
  };
  return { p, record };
}
test('memory source proof binds actual row ownership, full projected bytes and policy', () => {
  const { p, record } = fixture(),
    proof = signMeriMemoryCaptureSources(p, [record], secret, request);
  expect(verifyMeriMemoryCaptureSources(p, [record], proof, secret, request)).toEqual([
    expect.objectContaining({
      sourceId: record.recordId,
      tenantId: p.tenantId,
      clientId: p.clientId,
      fullRead: true,
      passageSha256: hash(record.payload.value),
    }),
  ]);
  record.payload.clientId = null as never;
  expect(
    signMeriMemoryCaptureSources(p, [record], secret, request).sources[0]!.clientId,
  ).toBeNull();
});
test.each([
  'signature',
  'record',
  'text',
  'version',
  'tenant',
  'client',
  'policy',
  'trace',
  'turn',
  'extra',
  'missing',
  'duplicate',
])('memory source proof rejects %s drift', (fault) => {
  const { p, record } = fixture(),
    proof = signMeriMemoryCaptureSources(p, [record], secret, request),
    records = [record];
  if (fault === 'signature') proof.signature = '0'.repeat(64);
  if (fault === 'record') record.recordId = id(9);
  if (fault === 'text') record.payload.value = 'Changed source bytes';
  if (fault === 'version') record.provenance.sourceVersion = 'changed';
  if (fault === 'tenant') record.provenance.canonicalTenantId = id(9);
  if (fault === 'client') record.payload.clientId = id(9);
  if (fault === 'policy') p.policyId = id(9);
  if (fault === 'trace') p.traceId = 'changed';
  if (fault === 'turn') p.turnId = id(9);
  if (fault === 'extra') (proof as any).unexpected = true;
  if (fault === 'missing') delete (record.provenance as any).canonicalTenantId;
  if (fault === 'duplicate') records.push(record);
  expect(() => verifyMeriMemoryCaptureSources(p, records, proof, secret, request)).toThrow();
});
test('partial memory page stays partial and cannot claim a full byte hash', () => {
  const { p, record } = fixture();
  record.payload.content.totalCharacters += 30;
  record.payload.content.truncated = true;
  record.payload.content.nextRead = { contentCursor: 'next' } as never;
  const proof = signMeriMemoryCaptureSources(p, [record], secret, request);
  expect(verifyMeriMemoryCaptureSources(p, [record], proof, secret, request)[0]!.fullRead).toBe(
    false,
  );
});
test('source proof refuses missing owner/secret, foreign owner and unsupported capture', () => {
  const { p, record } = fixture();
  expect(() => signMeriMemoryCaptureSources(p, [record], undefined, request)).toThrow();
  expect(memoryCaptureSourcePolicyEnabled({ ...p, caseId: '20' })).toBe(false);
  expect(() =>
    signMeriMemoryCaptureSources({ ...p, caseId: '20' }, [record], secret, request),
  ).toThrow();
  delete (record.provenance as any).canonicalTenantId;
  expect(() => signMeriMemoryCaptureSources(p, [record], secret, request)).toThrow();
});

test.each(['callId', 'nonce', 'inputSha256'] as const)(
  'response proof refuses same-policy %s replay',
  (key) => {
    const { p, record } = fixture(),
      proof = signMeriMemoryCaptureSources(p, [record], secret, request);
    const changed = {
      ...request,
      [key]: key === 'callId' ? 'another-call' : key === 'nonce' ? id(8) : 'b'.repeat(64),
    };
    expect(() => verifyMeriMemoryCaptureSources(p, [record], proof, secret, changed)).toThrow();
  },
);
test('request transport authenticates policy, exact input and bounded call identity', () => {
  const { p } = fixture(),
    input = { query: 'approved memory', clientId: p.clientId };
  const bound = { ...request, inputSha256: hash(JSON.stringify(input)) };
  const encoded = encodeMeriMemoryCaptureRequest(p, bound, secret);
  expect(decodeMeriMemoryCaptureRequest(p, encoded, input, secret)).toEqual(bound);
  expect(() =>
    decodeMeriMemoryCaptureRequest({ ...p, turnId: id(8) }, encoded, input, secret),
  ).toThrow();
  expect(() =>
    decodeMeriMemoryCaptureRequest(p, encoded, { ...input, query: 'other' }, secret),
  ).toThrow();
  expect(() => decodeMeriMemoryCaptureRequest(p, encoded, input, 'wrong')).toThrow();
  expect(() => decodeMeriMemoryCaptureRequest(p, undefined, input, secret)).toThrow();
  expect(() =>
    encodeMeriMemoryCaptureRequest(p, { ...bound, callId: ' '.repeat(300) }, secret),
  ).toThrow();
});


describe('Case12 exact setup provenance request/source signatures',()=>{
 function case12(){const f=fixture();f.p.caseId='12';f.p.semanticClock={...f.p.semanticClock!,caseId:'12'};f.p.resetReceiptId=null;f.p.seedReceiptId=null;
 f.p.case12Setup={setupRunId:id(8),fixtureInstanceId:id(9),setupPlanSha256:'1'.repeat(64),setupClaimSha256:'2'.repeat(64),setupLedgerSha256:'3'.repeat(64)};return f;}
 test('native setup shape is mandatory even with Case12 semantic clock',()=>{const {p}=case12();expect(memoryCaptureSourcePolicyEnabled(p)).toBe(true);delete p.case12Setup;expect(memoryCaptureSourcePolicyEnabled(p)).toBe(false);});
 test.each(['setupRunId','fixtureInstanceId','setupPlanSha256','setupClaimSha256','setupLedgerSha256'] as const)('request and source proof refuse changed %s',key=>{
 const {p,record}=case12(), input={query:'autonomous maritime demo',clientId:p.clientId};const bound={...request,inputSha256:hash(JSON.stringify(input))};
 const req=encodeMeriMemoryCaptureRequest(p,bound,secret),proof=signMeriMemoryCaptureSources(p,[record],secret,bound);
 expect(decodeMeriMemoryCaptureRequest(p,req,input,secret)).toEqual(bound);expect(verifyMeriMemoryCaptureSources(p,[record],proof,secret,bound)[0]!.sourceId).toBe(record.recordId);
 p.case12Setup![key]=key==='setupRunId'||key==='fixtureInstanceId'?id(6):'f'.repeat(64);
 expect(()=>decodeMeriMemoryCaptureRequest(p,req,input,secret)).toThrow();expect(()=>verifyMeriMemoryCaptureSources(p,[record],proof,secret,bound)).toThrow();
 });
 test('borrowed seed/reset and same setup/capture run are denied',()=>{for(const change of [ {resetReceiptId:'borrowed'}, {seedReceiptId:'borrowed'}, {captureRunId:id(8)} ]){const {p}=case12();Object.assign(p,change);expect(memoryCaptureSourcePolicyEnabled(p)).toBe(false);}});
});
