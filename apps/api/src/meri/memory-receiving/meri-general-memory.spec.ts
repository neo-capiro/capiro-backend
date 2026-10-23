import { ForbiddenException } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { createInProcessEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { assertGeneralReadTarget, generalRunScope } from '../../auth/read-delegation/read-delegation-general.js';
import { canonicalSha256 } from '../../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../../auth/read-delegation/read-delegation-request.js';
import { admitPassiveMemoryPage } from './meri-memory-page-admission.js';
import { readTaskBoundPassiveMemoryPage } from './meri-memory-signed-page-source.js';
import { parseMemoryHelperIssueRequest } from './meri-memory-helper-source.js';
import { MEMORY_HELPER_KIND, MEMORY_HELPER_PATH, signMemoryHelperToken, verifyMemoryHelperToken, type MemoryHelperClaims } from './meri-memory-helper-token.js';
import { signMemoryPageProof, verifyMemoryPageProof, type MemoryPageProofClaims } from './meri-memory-page-proof.js';

// Synthetic source-only credentials; no live identity, model, or database.
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const tenantId = id(1), actorId = id(2), clientId = id(3), conversationId = id(4), runId = id(5), attemptId = id(6), workerId = id(7);
const now = 1_792_000_000_000, policyRevision = 'a'.repeat(64), sha = 'b'.repeat(64);
const ctx = { tenantId, userId: actorId } as TenantContext;
const binding = { tenantId, actorId, conversationId, runId, attemptId, workerId, writerFence: 1 };
const wire = { input: { query: 'synthetic fact', clientId: null, k: 3, cursor: null, memoryItemId: null, contentCursor: null },
  metadata: { sourceConnected: false, authoritative: false, currentPolicyQualified: false, cursorAuthenticated: false, absenceEvidence: false } };
const correlation = { binding, subject: { kind: 'personal', entityType: 'user', entityIds: [actorId], tenantId, actorId,
  authorizationDecisionId: id(8), policyRevision, rosterVersionId: null,
  scopes: [{ kind: 'private-user', tenantId, resourceId: actorId, policyRevision }] }, policyRevision,
  normalizationContext: { tenantId, userId: actorId } };
function grant(): MeriReadDelegationGrant {
  return { delegationId: id(9), mode: 'attended', tenantId, actorId, conversationId, runId, clientId: null,
    scopeKind: 'general', targetClientId: null, binding, admittedBinding: binding, policyRevision,
    kind: 'tool', operation: { id: 'search_memory', version: '0.2.0' }, argumentsSha256: canonicalSha256(wire.input),
    bodySha256: canonicalSha256(wire), correlationSha256: canonicalSha256(correlation), callKey: 'synthetic_call',
    jti: id(8), hardExpiryMs: now + 30_000, toolRequestSha256: null, referenceSha256: null };
}
test('General memory requires its explicit origin, null target and exact private-user subject', () => {
  expect(admitPassiveMemoryPage(ctx, wire, grant(), correlation, now).scopeKind).toBe('general');
  for (const mutation of [{ scopeKind: undefined }, { clientId }, { targetClientId: clientId }, { mode: 'unattended' as const }])
    expect(() => admitPassiveMemoryPage(ctx, wire, { ...grant(), ...mutation }, correlation, now)).toThrow(ForbiddenException);
  for (const scopes of [[{ ...correlation.subject.scopes[0], kind: 'client', resourceId: clientId }],
    [{ ...correlation.subject.scopes[0], kind: 'tenant', resourceId: tenantId }],
    [{ ...correlation.subject.scopes[0], resourceId: clientId }]]) {
    const changed = { ...correlation, subject: { ...correlation.subject, scopes } };
    expect(() => admitPassiveMemoryPage(ctx, wire, { ...grant(), correlationSha256: canonicalSha256(changed) }, changed, now)).toThrow();
  }
});
test('General never obtains client memory or proposal tokens, including with a currently authorized target', () => {
  expect(() => assertGeneralReadTarget('tool', { id: 'search_memory', version: '0.2.0' }, null)).not.toThrow();
  for (const target of [null, clientId]) {
    expect(() => assertGeneralReadTarget('tool', { id: 'memory.list_own_proposals', version: '0.2.0' }, target)).toThrow();
    expect(() => assertGeneralReadTarget('tool', { id: 'list_memory_proposals', version: '0.1.0' }, target)).toThrow();
  }
  expect(() => assertGeneralReadTarget('tool', { id: 'search_memory', version: '0.2.0' }, clientId)).toThrow();
  expect(() => assertGeneralReadTarget('tool', { id: 'get_client_context', version: '0.3.0' }, null)).toThrow();
  expect(generalRunScope(correlation.subject.scopes, tenantId, actorId, policyRevision)).toBe(true);
  expect(generalRunScope([{ kind: 'tenant', tenantId, resourceId: tenantId, policyRevision }], tenantId, actorId, policyRevision)).toBe(false);
});
test('General invokes only the restricted canonical reader and rejects any client result before release', async () => {
  const legacy = jest.fn(); const release = jest.fn(async () => {});
  const good = { tool: 'search_memory', records: [{ recordId: id(8), payload: { clientId: null } }], results: [{ id: id(8), clientId: null }] };
  const restricted = jest.fn(async () => good);
  await expect(readTaskBoundPassiveMemoryPage(ctx, wire, grant(), correlation,
    { executeFromAuthenticatedUser: legacy, readPersonalFirmMemorySource: restricted } as never, release, () => now)).resolves.toMatchObject({ eligibility: { scopeKind: 'general', clientId: null } });
  expect(legacy).not.toHaveBeenCalled(); expect(restricted).toHaveBeenCalledWith(ctx, wire.input);
  release.mockClear();
  for (const bad of [ { ...good, records: [{ recordId: id(8), payload: { clientId } }] },
    { ...good, results: [{ id: id(8), clientId }] } ]) {
    await expect(readTaskBoundPassiveMemoryPage(ctx, wire, grant(), correlation,
      { executeFromAuthenticatedUser: legacy, readPersonalFirmMemorySource: async () => bad } as never, release, () => now)).rejects.toThrow();
  }
  expect(release).not.toHaveBeenCalled();
});
test('General opaque page/helper credentials require the signed discriminator; v1 remains client-only', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createInProcessEd25519Signer({ issuer: 'capiro:synthetic', kid: 'synthetic', privateKey });
  const config = { issuer: signer.issuer, kid: signer.kid, publicKey: signer.publicKey, keyArn: '', region: '' };
  const iat = now / 1000;
  const base = { sub: id(9), iat, nbf: iat, exp: iat + 5, parentJti: id(8), callKey: 'synthetic_call',
    parentBodySha256: sha, argumentsSha256: sha, requestSha256: sha, correlationSha256: sha, resultSha256: sha,
    recordsSha256: sha, bindingSha256: sha, tenantId, actorId, clientId: null, scopeKind: 'general' as const,
    conversationId, runId, attemptId, writerFence: 1 };
  const proof: Omit<MemoryPageProofClaims, 'iss'|'aud'|'jti'> = { ...base, policyRevision, deadlineMs: now + 5000 };
  const token = await signMemoryPageProof(signer, proof);
  expect(verifyMemoryPageProof(token, config, now)?.scopeKind).toBe('general');
  await expect(signMemoryPageProof(signer, { ...proof, scopeKind: undefined })).rejects.toThrow();
  await expect(signMemoryPageProof(signer, { ...proof, clientId })).rejects.toThrow();
  const helper: Omit<MemoryHelperClaims, 'iss'|'aud'|'jti'> = { ...base, kind: MEMORY_HELPER_KIND, method: 'POST', path: MEMORY_HELPER_PATH,
    bodySha256: sha, proofDeadlineMs: now + 5000 };
  const signed = await signMemoryHelperToken(signer, helper);
  expect(verifyMemoryHelperToken(signed.token, config, now)?.scopeKind).toBe('general');
  await expect(signMemoryHelperToken(signer, { ...helper, clientId })).rejects.toThrow();
  const request = { schemaVersion: 2, targetClientId: null, kind: MEMORY_HELPER_KIND, callKey: base.callKey,
    method: 'POST', path: MEMORY_HELPER_PATH, bodySha256: sha, operation: { id: 'search_memory', version: '0.2.0' },
    argumentsSha256: sha, pageBodySha256: sha, pageRequestSha256: sha, resultSha256: sha, recordsSha256: sha,
    correlationSha256: sha, pageProof: token, retryOf: null };
  expect(parseMemoryHelperIssueRequest(request).schemaVersion).toBe(2);
  expect(() => parseMemoryHelperIssueRequest({ ...request, targetClientId: clientId })).toThrow();
  expect(() => parseMemoryHelperIssueRequest({ ...request, schemaVersion: 1 })).toThrow();
});
