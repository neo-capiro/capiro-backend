import { ForbiddenException } from '@nestjs/common';
import { canonicalSha256 } from '../../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../../auth/read-delegation/read-delegation-request.js';
import { assertRetainedSourceV02Admission, RETAINED_SOURCE_V02_OPERATIONS } from './admission.js';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const R = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const D = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const W = '11111111-1111-4111-8111-111111111111';
const DECISION = '22222222-2222-4222-8222-222222222222';
const POLICY = 'a'.repeat(64);

function fixture(operationId = 'get_client_context', input: Record<string, unknown> = { clientId: C }) {
  const protocol = { input, metadata: {} };
  const correlation = {
    binding: { tenantId: T, actorId: A, conversationId: X, runId: R, attemptId: D, workerId: W, writerFence: 1 },
    subject: { kind: 'client', entityType: 'client', entityIds: [C], tenantId: T, actorId: A,
      authorizationDecisionId: DECISION, policyRevision: POLICY,
      scopes: [{ kind: 'client', tenantId: T, resourceId: C, policyRevision: POLICY }], rosterVersionId: null },
    policyRevision: POLICY, normalizationContext: null,
  };
  const grant: MeriReadDelegationGrant = {
    delegationId: D, mode: 'attended', tenantId: T, actorId: A, clientId: C,
    conversationId: X, runId: R,
    binding: { tenantId: T, actorId: A, conversationId: X, runId: R, attemptId: D, writerFence: 3 },
    admittedBinding: correlation.binding, policyRevision: POLICY,
    correlationSha256: canonicalSha256(correlation), argumentsSha256: canonicalSha256(input),
    callKey: 'call-one', kind: 'tool', operation: { id: operationId, version: '0.2.0' }, toolRequestSha256: null,
    referenceSha256: null, jti: D, hardExpiryMs: 2000,
  };
  return { grant, protocol, correlation };
}
const bound = (grant: MeriReadDelegationGrant, correlation: unknown): MeriReadDelegationGrant =>
  ({ ...grant, correlationSha256: canonicalSha256(correlation) });

describe('Core retained source 0.2 post-auth admission', () => {
  const options = { nowMs: 1000 };

  it('lists only the eleven source operations, with no legacy write route', () => {
    expect(RETAINED_SOURCE_V02_OPERATIONS.size).toBe(11);
    expect(RETAINED_SOURCE_V02_OPERATIONS.has('create_task')).toBe(false);
    expect(RETAINED_SOURCE_V02_OPERATIONS.has('query_tasks')).toBe(false);
  });

  it('accepts the four-field signed header and derives operation and hashes from Core data', () => {
    const { grant, protocol, correlation } = fixture();
    expect(Object.keys(correlation)).toEqual(['binding', 'subject', 'policyRevision', 'normalizationContext']);
    expect(assertRetainedSourceV02Admission(grant, protocol, correlation, options)).toMatchObject({
      clientId: C, operation: { id: 'get_client_context', version: '0.2.0' },
      binding: { runId: R, actorId: A }, input: { clientId: C },
      argumentsSha256: canonicalSha256(protocol.input), requestSha256: canonicalSha256(protocol),
    });
  });

  it('refuses bare input and metadata without an independently authenticated correlation', () => {
    const { grant, protocol } = fixture();
    expect(() => assertRetainedSourceV02Admission(grant, protocol, undefined, options)).toThrow(ForbiddenException);
  });

  it('accepts an authenticated null normalization context and refuses reservation hash drift', () => {
    const { grant, protocol, correlation } = fixture();
    expect(assertRetainedSourceV02Admission(grant, protocol, correlation, options).normalizationContext).toBeNull();
    const withContext = { ...correlation, normalizationContext: { mailbox: 'primary' } };
    expect(assertRetainedSourceV02Admission(bound(grant, withContext), protocol, withContext,
      options).normalizationContext).toEqual({ mailbox: 'primary' });
    expect(() => assertRetainedSourceV02Admission({ ...grant, argumentsSha256: canonicalSha256('different') },
      protocol, correlation, options)).toThrow(ForbiddenException);
  });

  it('refuses task, header additions, unknown operation, expiry and argument drift', () => {
    const { grant, protocol, correlation } = fixture();
    const changedBinding = { ...correlation, binding: { ...correlation.binding, runId: D } };
    expect(() => assertRetainedSourceV02Admission(grant, protocol,
      changedBinding, options)).toThrow(ForbiddenException);
    expect(() => assertRetainedSourceV02Admission(bound(grant, changedBinding), protocol,
      changedBinding, options)).toThrow(ForbiddenException);
    const changedOperation = { ...correlation, operation: { id: 'find_contacts', version: '0.2.0' } };
    expect(() => assertRetainedSourceV02Admission(grant, protocol,
      changedOperation, options)).toThrow(ForbiddenException);
    expect(() => assertRetainedSourceV02Admission(bound(grant, changedOperation), protocol,
      changedOperation, options)).toThrow(ForbiddenException);
    expect(() => assertRetainedSourceV02Admission({ ...grant, operation: { id: 'query_tasks', version: '0.2.0' } },
      protocol, correlation, options)).toThrow(ForbiddenException);
    expect(() => assertRetainedSourceV02Admission(grant, protocol, correlation, { nowMs: 2000 })).toThrow(ForbiddenException);
    expect(() => assertRetainedSourceV02Admission(grant, { input: { clientId: C, changed: true }, metadata: {} },
      correlation, options)).toThrow(ForbiddenException);
    const changedMetadata = { input: protocol.input, metadata: { changed: true } };
    expect(assertRetainedSourceV02Admission(grant, changedMetadata, correlation,
      options).requestSha256).toBe(canonicalSha256(changedMetadata));
  });

  it('refuses client, conversation and subject widening even when the hash matches', () => {
    const { grant, correlation } = fixture('resolve_entity', { subject: { kind: 'client', entityId: C }, nested: { clientIds: [C, D] } });
    const widened = { input: { subject: { kind: 'client', entityId: C }, nested: { clientIds: [C, D] } }, metadata: {} };
    expect(() => assertRetainedSourceV02Admission(grant, widened, correlation, options)).toThrow(ForbiddenException);
    const wrongConversation = fixture('resolve_entity', { conversationId: D });
    expect(() => assertRetainedSourceV02Admission(wrongConversation.grant, wrongConversation.protocol,
      wrongConversation.correlation, options)).toThrow(ForbiddenException);
    expect(() => assertRetainedSourceV02Admission(grant, widened,
      { ...correlation, subject: { ...correlation.subject, kind: 'entity', entityType: 'research-portfolio' } },
      options)).toThrow(ForbiddenException);
  });

  it('refuses top-level and subject policy revision drift even with a matching signed hash', () => {
    const { grant, protocol, correlation } = fixture();
    const changedTop = { ...correlation, policyRevision: 'b'.repeat(64) };
    expect(() => assertRetainedSourceV02Admission(bound(grant, changedTop), protocol,
      changedTop, options)).toThrow(ForbiddenException);
    const changedSubject = { ...correlation, subject: { ...correlation.subject, policyRevision: 'b'.repeat(64) } };
    expect(() => assertRetainedSourceV02Admission(bound(grant, changedSubject), protocol,
      changedSubject, options)).toThrow(ForbiddenException);
  });

  it('refuses nullable Monday client despite a matching selected-client grant', () => {
    const { grant, protocol, correlation } = fixture('read_monday_client_boards', { clientId: null });
    expect(() => assertRetainedSourceV02Admission(grant, protocol, correlation, options)).toThrow(ForbiddenException);
  });

  it('permits an explicit personal subject only with a separate owner decision', () => {
    const { grant, protocol, correlation } = fixture('mail.list_messages', { subject: { kind: 'personal' } });
    const personal = { ...correlation, subject: { ...correlation.subject, kind: 'personal', entityType: 'user', entityIds: [A],
      scopes: [{ kind: 'mailbox', tenantId: T, resourceId: 'mailbox-one', policyRevision: POLICY }] } };
    const personalGrant = bound(grant, personal);
    expect(() => assertRetainedSourceV02Admission(personalGrant, protocol, personal, options)).toThrow(ForbiddenException);
    expect(assertRetainedSourceV02Admission(personalGrant, protocol, personal,
      { ...options, personalOwnerAuthorized: true }).subject.kind).toBe('personal');
    const missingSubject = { input: {}, metadata: {} };
    expect(() => assertRetainedSourceV02Admission({ ...personalGrant, argumentsSha256: canonicalSha256(missingSubject.input) },
      missingSubject, personal, { ...options, personalOwnerAuthorized: true })).toThrow(ForbiddenException);
    const widenedSubject = { input: { subject: { kind: 'personal', entityId: A } }, metadata: {} };
    expect(() => assertRetainedSourceV02Admission({ ...personalGrant, argumentsSha256: canonicalSha256(widenedSubject.input) },
      widenedSubject, personal, { ...options, personalOwnerAuthorized: true })).toThrow(ForbiddenException);
  });
});
