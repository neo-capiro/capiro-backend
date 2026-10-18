import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { createInProcessEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { canonicalSha256, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';
import { verifyReadToken } from '../../auth/read-delegation/read-delegation-token.js';
import {
  assertMemoryHelperCallback, parseMemoryHelperIssueRequest,
} from './meri-memory-helper-source.js';
import {
  MEMORY_HELPER_KIND, MEMORY_HELPER_PATH, memoryHelperTokenFromAuthorization,
  signMemoryHelperToken, verifyMemoryHelperToken, type MemoryHelperClaims,
} from './meri-memory-helper-token.js';
import { signMemoryPageProof, verifyMemoryPageProof } from './meri-memory-page-proof.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';
const runId = '55555555-5555-4555-8555-555555555555';
const attemptId = '66666666-6666-4666-8666-666666666666';
const workerId = '77777777-7777-4777-8777-777777777777';
const parentJti = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const delegationId = '99999999-9999-4999-8999-999999999999';
const nowMs = 1_792_000_000_000;
const iat = Math.floor(nowMs / 1000);
const policyRevision = 'b'.repeat(64);
const { privateKey } = generateKeyPairSync('ed25519');
const signer = createInProcessEd25519Signer({ issuer: 'capiro:test', kid: 'memory-test', privateKey });
const config = { issuer: signer.issuer, kid: signer.kid, publicKey: signer.publicKey,
  keyArn: 'arn:aws:kms:us-east-1:111111111111:key/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', region: 'us-east-1' };

const binding = { tenantId, actorId, conversationId, runId, attemptId, workerId, writerFence: 2 };
const subject = { kind: 'client', entityType: 'client', entityIds: [clientId], tenantId, actorId,
  authorizationDecisionId: '88888888-8888-4888-8888-888888888888', policyRevision,
  scopes: [{ tenantId, kind: 'client', resourceId: clientId, policyRevision }], rosterVersionId: null };
const normalizationContext = { tenantId, userId: actorId };
const correlation = { binding, subject, policyRevision, normalizationContext };
const input = { query: 'a fact', clientId, k: 3, cursor: null, memoryItemId: null, contentCursor: null };
const metadata = { sourceConnected: false, authoritative: false, currentPolicyQualified: false,
  cursorAuthenticated: false, absenceEvidence: false };
const record = { memoryItemId: 'abababab-abab-4bab-8bab-abababababab', recordSha256: 'c'.repeat(64) };
const records = [record];
const pageBodySha256 = 'd'.repeat(64);
const resultSha256 = 'e'.repeat(64);
const argumentsSha256 = canonicalSha256(input);
const requestSha256 = canonicalSha256({ input, metadata });
const correlationSha256 = canonicalSha256(correlation);

function callback() {
  return { operation: { id: 'search_memory', version: '0.2.0' }, input, metadata,
    normalizationContext, argumentsSha256, requestSha256, binding, subject, policyRevision,
    sourceIds: ['client_knowledge_memory'], resultSha256, records, deadlineMs: nowMs + 4_000 };
}

function helperClaims(): Omit<MemoryHelperClaims, 'iss' | 'aud' | 'jti'> {
  return { sub: delegationId, iat, nbf: iat, exp: iat + 5, kind: MEMORY_HELPER_KIND,
    parentJti, callKey: 'call_1', method: 'POST' as const, path: MEMORY_HELPER_PATH,
    bodySha256: sha256Hex(JSON.stringify(callback())), parentBodySha256: pageBodySha256,
    argumentsSha256, requestSha256, correlationSha256, resultSha256,
    recordsSha256: canonicalSha256(records), bindingSha256: canonicalSha256(binding),
    proofDeadlineMs: nowMs + 30_000, tenantId, actorId, clientId, conversationId, runId,
    attemptId, writerFence: 2 };
}

function stored() {
  const c = helperClaims();
  return { parent_jti: parentJti, parent_body_sha256: pageBodySha256,
    page_arguments_sha256: argumentsSha256, page_request_sha256: requestSha256,
    correlation_sha256: correlationSha256, page_result_sha256: resultSha256,
    records_sha256: c.recordsSha256, binding_sha256: c.bindingSha256,
    body_sha256: c.bodySha256 };
}

describe('unmounted memory page proof and distinct helper credential', () => {
  it('signs a non-authorizing proof; changes to its pins or JOSE type refuse', async () => {
    const proof = await signMemoryPageProof(signer, {
      sub: delegationId, iat, nbf: iat, exp: iat + 30, parentJti, callKey: 'call_1',
      parentBodySha256: pageBodySha256, argumentsSha256, requestSha256,
      correlationSha256, resultSha256, recordsSha256: canonicalSha256(records),
      bindingSha256: canonicalSha256(binding), policyRevision, tenantId, actorId,
      clientId, conversationId, runId, attemptId, writerFence: 2, deadlineMs: nowMs + 30_000,
    });
    expect(verifyMemoryPageProof(proof, config, nowMs)).toMatchObject({ parentJti, clientId, resultSha256 });
    expect(verifyMemoryPageProof(`${proof.slice(0, -2)}xx`, config, nowMs)).toBeNull();
    expect(verifyMemoryPageProof(proof, config, nowMs + 30_000)).toBeNull();
    expect(verifyMemoryHelperToken(proof, config, nowMs)).toBeNull();
  });

  it('keeps helper audience/type separate and refuses ordinary read-token parsing', async () => {
    const { token } = await signMemoryHelperToken(signer, helperClaims());
    expect(memoryHelperTokenFromAuthorization(`CapiroMeriRead ${token}`)).toBe(token);
    expect(memoryHelperTokenFromAuthorization(`Bearer ${token}`)).toBeNull();
    expect(verifyMemoryHelperToken(token, config, nowMs)).toMatchObject({
      kind: MEMORY_HELPER_KIND, parentJti, callKey: 'call_1', bodySha256: helperClaims().bodySha256,
    });
    expect(verifyReadToken(token, config, nowMs)).toBeNull();
    expect(verifyMemoryHelperToken(token, config, nowMs + 5_000)).toBeNull();
  });

  it('accepts only the closed one-use service request, never a retry or extra tool operation', () => {
    const base = { schemaVersion: 1, kind: MEMORY_HELPER_KIND, callKey: 'call_1', method: 'POST',
      path: MEMORY_HELPER_PATH, bodySha256: helperClaims().bodySha256,
      operation: { id: 'search_memory', version: '0.2.0' }, argumentsSha256,
      pageBodySha256, pageRequestSha256: requestSha256, resultSha256,
      recordsSha256: canonicalSha256(records), correlationSha256,
      pageProof: 'a.b.c', retryOf: null };
    expect(parseMemoryHelperIssueRequest(base)).toEqual(base);
    expect(() => parseMemoryHelperIssueRequest({ ...base, retryOf: 'a'.repeat(64) })).toThrow();
    expect(() => parseMemoryHelperIssueRequest({ ...base, operation: { id: 'list_memory_proposals', version: '0.2.0' } })).toThrow();
    expect(() => parseMemoryHelperIssueRequest({ ...base, newGrant: true })).toThrow();
  });

  it('binds the exact emitted callback bytes and every page/correlation pin', () => {
    const raw = callback();
    const claims = { ...helperClaims(), iss: signer.issuer, aud: 'capiro:meri-memory-eligibility:v1' as const,
      jti: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    const body = Buffer.from(JSON.stringify(raw));
    expect(assertMemoryHelperCallback({ tenantId, userId: actorId }, raw, body, claims, stored(), nowMs).records)
      .toEqual(records);
    expect(() => assertMemoryHelperCallback({ tenantId, userId: actorId }, raw,
      Buffer.from(` ${JSON.stringify(raw)}`), claims, stored(), nowMs)).toThrow();
    expect(() => assertMemoryHelperCallback({ tenantId, userId: actorId },
      { ...raw, resultSha256: 'f'.repeat(64) }, body, claims, stored(), nowMs)).toThrow();
    expect(() => assertMemoryHelperCallback({ tenantId, userId: actorId },
      { ...raw, records: [{ ...record, recordSha256: 'f'.repeat(64) }] },
      Buffer.from(JSON.stringify({ ...raw, records: [{ ...record, recordSha256: 'f'.repeat(64) }] })),
      claims, stored(), nowMs)).toThrow();
  });

});
