import { ForbiddenException } from '@nestjs/common';
import { canonicalSha256 } from '../../auth/read-delegation/read-delegation.contract.js';
import { assertRetainedSourceV02Admission, RETAINED_SOURCE_V02_OPERATIONS } from './admission.js';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const R = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const AT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const W = '11111111-1111-4111-8111-111111111111';
const P = 'a'.repeat(64);
const ctx = { tenantId: T, userId: A };
const options = { verifiedServiceIdentity: true, nowMs: 1000, deadlineMs: 2000 };
const correlation = () => ({
  binding: { tenantId: T, actorId: A, conversationId: V, runId: R, attemptId: AT, workerId: W, writerFence: 1 },
  subject: { kind: 'client', entityType: 'client', entityIds: [C], tenantId: T, actorId: A,
    policyRevision: P, scopes: [{ kind: 'client', tenantId: T, resourceId: C, policyRevision: P }], rosterVersionId: null },
  policyRevision: P, normalizationContext: null,
});
const protocol = { input: { clientId: C }, metadata: {} };
const admit = (operation = 'get_client_context', wire: unknown = protocol, context: unknown = correlation()) =>
  assertRetainedSourceV02Admission(ctx, operation, wire, context, options);

describe('ordinary Core retained source admission', () => {
  it('keeps all eleven source operations and derives the supported version from the route', () => {
    expect(RETAINED_SOURCE_V02_OPERATIONS.size).toBe(11);
    expect(RETAINED_SOURCE_V02_OPERATIONS.has('create_task')).toBe(false);
    expect(admit()).toMatchObject({ clientId: C, operation: { id: 'get_client_context', version: '0.3.0' },
      binding: { runId: R, actorId: A }, input: protocol.input,
      argumentsSha256: canonicalSha256(protocol.input), requestSha256: canonicalSha256(protocol) });
    expect(admit('mail.list_messages', { input: { subject: { kind: 'client', entityId: C } }, metadata: null })
      .operation).toEqual({ id: 'mail.list_messages', version: '0.2.0' });
    expect(() => admit('query_tasks')).toThrow(ForbiddenException);
  });

  it('requires the authenticated actor and verified service, without grant or allocation fields', () => {
    expect(() => assertRetainedSourceV02Admission(ctx, 'get_client_context', protocol, correlation(),
      { ...options, verifiedServiceIdentity: false })).toThrow(ForbiddenException);
    expect(() => assertRetainedSourceV02Admission({ ...ctx, userId: W }, 'get_client_context', protocol,
      correlation(), options)).toThrow(ForbiddenException);
    expect(() => assertRetainedSourceV02Admission(ctx, 'get_client_context', protocol, undefined, options))
      .toThrow(ForbiddenException);
    expect(() => admit('read_client_documents', { ...protocol, documentPricing: {} })).toThrow(ForbiddenException);
    expect(Object.hasOwn(admit('read_client_documents'), 'documentTextOnlyAllocation')).toBe(false);
  });

  it('snapshots input and context without invoking accessors or carrying later mutations', () => {
    const wire = { input: { clientId: C }, metadata: {} };
    const held = correlation();
    const admitted = admit('get_client_context', wire, held);
    wire.input.clientId = A;
    held.binding.runId = A;
    expect(admitted.input.clientId).toBe(C);
    expect(admitted.binding.runId).toBe(R);
    expect(() => admit('get_client_context', { get input() { throw Error('not invoked'); }, metadata: null }))
      .toThrow(ForbiddenException);
  });

  it('refuses foreign client/conversation selectors and subject widening', () => {
    for (const input of [{ clientId: A }, { clientId: C, nested: { clientIds: [C, A] } },
      { clientId: C, conversationId: A }, { clientId: C, subject: { kind: 'client', entityId: A } }])
      expect(() => admit('get_client_context', { input, metadata: null })).toThrow(ForbiddenException);
    const held = correlation();
    held.subject.scopes[0]!.resourceId = A;
    expect(() => admit('get_client_context', protocol, held)).toThrow(ForbiddenException);
  });

  it('refuses expired deadlines, extra context fields and inconsistent policy versions', () => {
    expect(() => assertRetainedSourceV02Admission(ctx, 'get_client_context', protocol, correlation(),
      { ...options, nowMs: 2000 })).toThrow(ForbiddenException);
    expect(() => admit('get_client_context', protocol, { ...correlation(), operation: { id: 'find_contacts' } }))
      .toThrow(ForbiddenException);
    expect(() => admit('get_client_context', protocol, { ...correlation(), policyRevision: 'other' }))
      .toThrow(ForbiddenException);
    const held = correlation();
    held.subject.policyRevision = 'other';
    expect(() => admit('get_client_context', protocol, held)).toThrow(ForbiddenException);
  });

  it('admits General entity lookup using correlation, without adding a subject to its closed input', () => {
    const held = correlation();
    const personal = { ...held, subject: { ...held.subject, kind: 'personal', entityType: 'user', entityIds: [A],
      scopes: [{ kind: 'private-user', tenantId: T, resourceId: A, policyRevision: P }] } };
    const input = { limit: 10, query: 'education', type: 'organization' };
    expect(admit('resolve_entity', { input, metadata: null }, personal))
      .toMatchObject({ clientId: null, input, subject: { kind: 'personal', entityIds: [A] } });
    expect(() => admit('resolve_entity', { input: { ...input, clientId: C }, metadata: null }, personal))
      .toThrow(ForbiddenException);
    expect(() => admit('resolve_entity', { input, metadata: null }, {
      ...personal, subject: { ...personal.subject, entityIds: [W] },
    })).toThrow(ForbiddenException);
  });

  it('permits explicit actor-owned personal mail selection, leaving ownership to the canonical reader', () => {
    const held = correlation();
    const personal = { ...held, subject: { ...held.subject, kind: 'personal', entityType: 'user', entityIds: [A],
      scopes: [{ kind: 'private-user', tenantId: T, resourceId: A, policyRevision: P }] } };
    expect(admit('mail.list_messages', { input: { subject: { kind: 'personal' } }, metadata: null }, personal))
      .toMatchObject({ clientId: null, subject: { kind: 'personal' } });
    expect(() => admit('mail.list_messages', { input: {}, metadata: null }, personal)).toThrow(ForbiddenException);
    expect(() => admit('mail.list_messages', { input: { subject: { kind: 'personal', entityId: A } }, metadata: null }, personal))
      .toThrow(ForbiddenException);
    expect(() => admit('read_monday_client_boards', { input: { clientId: null }, metadata: null }, personal))
      .toThrow(ForbiddenException);
  });
});
