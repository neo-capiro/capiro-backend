import { validateMeriCase12SetupPolicyBinding } from './case12-setup-binding.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { MeriServerReadonlyCapturePolicy } from './server-readonly-capture';

const PURPOSE = 'capiro:meri:canonical-memory-capture-source:v1';
export const MERI_MEMORY_CAPTURE_REQUEST_HEADER = 'x-meri-memory-capture-request';
const REQUEST_PURPOSE = 'capiro:meri:canonical-memory-capture-request:v1';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const need = (ok: unknown): void => {
  if (!ok) throw new Error('meri_memory_capture_source_unproved');
};
const hash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const object = (v: unknown): Record<string, any> => {
  need(v && typeof v === 'object' && !Array.isArray(v));
  return v as Record<string, any>;
};

export interface MeriMemoryCaptureSource {
  sourceId: string;
  tenantId: string;
  clientId: string | null;
  sourceVersion: string;
  currentVersion: string;
  passageSha256: string;
  offset: number;
  endOffset: number;
  totalCharacters: number;
  fullRead: boolean;
}
export interface MeriMemoryCaptureSourceProof {
  version: 1;
  purpose: typeof PURPOSE;
  policyBinding: string;
  request: MeriMemoryCaptureRequest;
  sources: MeriMemoryCaptureSource[];
  signature: string;
}
export interface MeriMemoryCaptureRequest {
  callId: string;
  nonce: string;
  inputSha256: string;
}

function requestBinding(value: unknown): MeriMemoryCaptureRequest {
  const r = object(value);
  need(
    Object.keys(r).sort().join(',') === 'callId,inputSha256,nonce' &&
      typeof r.callId === 'string' &&
      r.callId.trim() === r.callId &&
      r.callId.length > 0 &&
      r.callId.length <= 200 &&
      typeof r.nonce === 'string' &&
      UUID.test(r.nonce) &&
      typeof r.inputSha256 === 'string' &&
      HASH.test(r.inputSha256),
  );
  return { callId: r.callId, nonce: r.nonce, inputSha256: r.inputSha256 };
}

export function encodeMeriMemoryCaptureRequest(
  p: MeriServerReadonlyCapturePolicy,
  request: MeriMemoryCaptureRequest,
  secret: string | undefined,
): string {
  need(secret?.trim());
  const value = {
    purpose: REQUEST_PURPOSE,
    policyBinding: policyBinding(p),
    request: requestBinding(request),
  };
  return Buffer.from(
    JSON.stringify({
      ...value,
      signature: createHmac('sha256', secret!.trim()).update(JSON.stringify(value)).digest('hex'),
    }),
  ).toString('base64url');
}

export function decodeMeriMemoryCaptureRequest(
  p: MeriServerReadonlyCapturePolicy,
  encoded: unknown,
  input: unknown,
  secret: string | undefined,
): MeriMemoryCaptureRequest {
  need(
    secret?.trim() &&
      typeof encoded === 'string' &&
      encoded.length <= 4096 &&
      /^[A-Za-z0-9_-]+$/.test(encoded),
  );
  const wire = object(JSON.parse(Buffer.from(encoded as string, 'base64url').toString('utf8')));
  const request = requestBinding(wire.request);
  need(
    Object.keys(wire).sort().join(',') === 'policyBinding,purpose,request,signature' &&
      wire.purpose === REQUEST_PURPOSE &&
      wire.policyBinding === policyBinding(p) &&
      typeof wire.signature === 'string' &&
      HASH.test(wire.signature) &&
      request.inputSha256 === hash(JSON.stringify(input)),
  );
  const value = { purpose: REQUEST_PURPOSE, policyBinding: policyBinding(p), request };
  need(
    timingSafeEqual(
      createHmac('sha256', secret!.trim()).update(JSON.stringify(value)).digest(),
      Buffer.from(wire.signature, 'hex'),
    ),
  );
  return request;
}

export function memoryCaptureSourcePolicyEnabled(
  p: MeriServerReadonlyCapturePolicy | null | undefined,
): p is MeriServerReadonlyCapturePolicy {
  if (p?.caseId === '12') {
    try { validateMeriCase12SetupPolicyBinding(p); } catch { return false; }
  }
  return (
    !!p?.semanticClock &&
    !p.syntheticReadBudget &&
    p.fixtureVersion === 'meri-live-v1-2026-09-26.1' &&
    ['01', '12', '14'].includes(p.caseId ?? '')
  );
}

function policyBinding(p: MeriServerReadonlyCapturePolicy): string {
  need(memoryCaptureSourcePolicyEnabled(p) && p.turnId && p.requestId && p.traceId);
  return hash(
    JSON.stringify([
      p.policyId,
      p.caseId,
      p.captureRunId,
      p.requestId,
      p.traceId,
      p.turnId,
      p.tenantId,
      p.actorUserId,
      p.clientId,
      p.conversationId,
      p.issuedAt,
      p.expiresAt,
      p.physicalMapSha256,
      p.semanticClock,
      ...(p.caseId === '12' ? [p.case12Setup] : []),
    ]),
  );
}

/** Called on freshly authorized, projected canonical records. Row ownership is
 * mandatory; the request/policy is never used to fill missing row provenance. */
function source(record: unknown): MeriMemoryCaptureSource {
  const r = object(record),
    p = object(r.payload),
    provenance = object(r.provenance),
    c = object(p.content);
  need(
    r.domain === 'institutional_knowledge' &&
      p.sourceKind === 'governed_memory' &&
      provenance.source === 'memory_items' &&
      r.recordId === p.memoryItemId &&
      provenance.recordId === r.recordId &&
      typeof r.recordId === 'string' &&
      UUID.test(r.recordId) &&
      typeof provenance.canonicalTenantId === 'string' &&
      UUID.test(provenance.canonicalTenantId) &&
      (p.clientId === null || (typeof p.clientId === 'string' && UUID.test(p.clientId))) &&
      p.contentStatus === 'available' &&
      typeof p.value === 'string' &&
      p.value.length > 0 &&
      p.value.length <= 6000 &&
      typeof provenance.sourceVersion === 'string' &&
      provenance.sourceVersion.length > 0 &&
      provenance.sourceVersion.length <= 200 &&
      typeof c.hash === 'string' &&
      HASH.test(c.hash) &&
      Number.isSafeInteger(c.offset) &&
      c.offset >= 0 &&
      Number.isSafeInteger(c.endOffset) &&
      c.endOffset === c.offset + p.value.length &&
      Number.isSafeInteger(c.totalCharacters) &&
      c.totalCharacters >= c.endOffset &&
      c.truncated === c.endOffset < c.totalCharacters &&
      (c.truncated ? c.nextRead && typeof c.nextRead === 'object' : c.nextRead === null),
  );
  const fullRead = c.offset === 0 && c.endOffset === c.totalCharacters && c.truncated === false;
  if (fullRead) need(c.hash === hash(p.value + '\0' + provenance.sourceVersion));
  return {
    sourceId: r.recordId,
    tenantId: provenance.canonicalTenantId,
    clientId: p.clientId,
    sourceVersion: provenance.sourceVersion,
    currentVersion: 'content:' + c.hash,
    passageSha256: hash(p.value),
    offset: c.offset,
    endOffset: c.endOffset,
    totalCharacters: c.totalCharacters,
    fullRead,
  };
}

function body(
  p: MeriServerReadonlyCapturePolicy,
  records: unknown,
  request: MeriMemoryCaptureRequest,
): Omit<MeriMemoryCaptureSourceProof, 'signature'> {
  need(Array.isArray(records) && records.length <= 15);
  const sources = (records as unknown[]).map(source);
  need(new Set(sources.map((s) => s.sourceId)).size === sources.length);
  // A mismatch is a refusal, never an inferred row owner.
  need(
    sources.every(
      (s) => s.tenantId === p.tenantId && (s.clientId === null || s.clientId === p.clientId),
    ),
  );
  return {
    version: 1 as const,
    purpose: PURPOSE,
    policyBinding: policyBinding(p),
    request: requestBinding(request),
    sources,
  };
}

export function signMeriMemoryCaptureSources(
  p: MeriServerReadonlyCapturePolicy,
  records: unknown,
  secret: string | undefined,
  request: MeriMemoryCaptureRequest,
): MeriMemoryCaptureSourceProof {
  need(secret?.trim());
  const value = body(p, records, request);
  return {
    ...value,
    signature: createHmac('sha256', secret!.trim()).update(JSON.stringify(value)).digest('hex'),
  };
}

/** Verify both the API signature and its exact correspondence to the actual
 * response records. A signed but altered/page-mismatched response cannot join. */
export function verifyMeriMemoryCaptureSources(
  p: MeriServerReadonlyCapturePolicy,
  records: unknown,
  proof: unknown,
  secret: string | undefined,
  request: MeriMemoryCaptureRequest,
): MeriMemoryCaptureSource[] {
  need(secret?.trim());
  const wire = object(proof),
    expected = body(p, records, request);
  need(
    Object.keys(wire).sort().join(',') ===
      'policyBinding,purpose,request,signature,sources,version' &&
      typeof wire.signature === 'string' &&
      HASH.test(wire.signature),
  );
  need(
    JSON.stringify({
      version: wire.version,
      purpose: wire.purpose,
      policyBinding: wire.policyBinding,
      request: wire.request,
      sources: wire.sources,
    }) === JSON.stringify(expected),
  );
  const signature = createHmac('sha256', secret!.trim()).update(JSON.stringify(expected)).digest();
  need(timingSafeEqual(signature, Buffer.from(wire.signature, 'hex')));
  return structuredClone(expected.sources);
}
