import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { MeriServerReadonlyCapturePolicy } from './server-readonly-capture';

const PURPOSE = 'capiro:meri:canonical-memory-capture-source:v1';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const need = (ok: unknown): void => { if (!ok) throw new Error('meri_memory_capture_source_unproved'); };
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
  sources: MeriMemoryCaptureSource[];
  signature: string;
}

export function memoryCaptureSourcePolicyEnabled(p: MeriServerReadonlyCapturePolicy | null | undefined): p is MeriServerReadonlyCapturePolicy {
  return !!p?.semanticClock && !p.syntheticReadBudget &&
    p.fixtureVersion === 'meri-live-v1-2026-09-26.1' && ['01', '14'].includes(p.caseId ?? '');
}

function policyBinding(p: MeriServerReadonlyCapturePolicy): string {
  need(memoryCaptureSourcePolicyEnabled(p) && p.turnId && p.requestId && p.traceId);
  return hash(JSON.stringify([p.policyId, p.caseId, p.captureRunId, p.requestId, p.traceId,
    p.turnId, p.tenantId, p.actorUserId, p.clientId, p.conversationId, p.issuedAt, p.expiresAt,
    p.physicalMapSha256, p.semanticClock]));
}

/** Called on freshly authorized, projected canonical records. Row ownership is
 * mandatory; the request/policy is never used to fill missing row provenance. */
function source(record: unknown): MeriMemoryCaptureSource {
  const r = object(record), p = object(r.payload), provenance = object(r.provenance), c = object(p.content);
  need(r.domain === 'institutional_knowledge' && p.sourceKind === 'governed_memory' &&
    provenance.source === 'memory_items' && r.recordId === p.memoryItemId && provenance.recordId === r.recordId &&
    UUID.test(r.recordId) && UUID.test(provenance.canonicalTenantId) &&
    (p.clientId === null || UUID.test(p.clientId)) && p.contentStatus === 'available' &&
    typeof p.value === 'string' && p.value.length > 0 && p.value.length <= 6000 &&
    typeof provenance.sourceVersion === 'string' && provenance.sourceVersion.length > 0 && provenance.sourceVersion.length <= 200 &&
    HASH.test(c.hash) && Number.isSafeInteger(c.offset) && c.offset >= 0 &&
    Number.isSafeInteger(c.endOffset) && c.endOffset === c.offset + p.value.length &&
    Number.isSafeInteger(c.totalCharacters) && c.totalCharacters >= c.endOffset &&
    c.truncated === (c.endOffset < c.totalCharacters) &&
    (c.truncated ? c.nextRead && typeof c.nextRead === 'object' : c.nextRead === null));
  const fullRead = c.offset === 0 && c.endOffset === c.totalCharacters && c.truncated === false;
  if (fullRead) need(c.hash === hash(p.value + '\0' + provenance.sourceVersion));
  return { sourceId: r.recordId, tenantId: provenance.canonicalTenantId, clientId: p.clientId,
    sourceVersion: provenance.sourceVersion, currentVersion: 'content:' + c.hash,
    passageSha256: hash(p.value), offset: c.offset, endOffset: c.endOffset,
    totalCharacters: c.totalCharacters, fullRead };
}

function body(p: MeriServerReadonlyCapturePolicy, records: unknown): Omit<MeriMemoryCaptureSourceProof, 'signature'> {
  need(Array.isArray(records) && records.length <= 15);
  const sources = (records as unknown[]).map(source);
  need(new Set(sources.map(s => s.sourceId)).size === sources.length);
  // A mismatch is a refusal, never an inferred row owner.
  need(sources.every(s => s.tenantId === p.tenantId && (s.clientId === null || s.clientId === p.clientId)));
  return { version: 1 as const, purpose: PURPOSE, policyBinding: policyBinding(p), sources };
}

export function signMeriMemoryCaptureSources(p: MeriServerReadonlyCapturePolicy, records: unknown, secret: string | undefined): MeriMemoryCaptureSourceProof {
  need(secret?.trim());
  const value = body(p, records);
  return { ...value, signature: createHmac('sha256', secret!.trim()).update(JSON.stringify(value)).digest('hex') };
}

/** Verify both the API signature and its exact correspondence to the actual
 * response records. A signed but altered/page-mismatched response cannot join. */
export function verifyMeriMemoryCaptureSources(p: MeriServerReadonlyCapturePolicy, records: unknown, proof: unknown, secret: string | undefined): MeriMemoryCaptureSource[] {
  need(secret?.trim());
  const wire = object(proof), expected = body(p, records);
  need(Object.keys(wire).sort().join(',') === 'policyBinding,purpose,signature,sources,version' && HASH.test(wire.signature));
  need(JSON.stringify({version: wire.version, purpose: wire.purpose, policyBinding: wire.policyBinding, sources: wire.sources}) === JSON.stringify(expected));
  const signature = createHmac('sha256', secret!.trim()).update(JSON.stringify(expected)).digest();
  need(timingSafeEqual(signature, Buffer.from(wire.signature, 'hex')));
  return structuredClone(expected.sources);
}
