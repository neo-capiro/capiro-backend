import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import type { MeriReadDelegationGrant } from '../auth/read-delegation/read-delegation-request.js';
import {
  MERI_CORRELATED_READ_TOOLS, MERI_RETAINED_SOURCE_TOOLS,
  canonicalSha256, parseTokenRequest, sha256Hex,
} from '../auth/read-delegation/read-delegation.contract.js';
import { MeriController } from './meri.controller.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import {
  ACTION_QUERY_OWNER, ACTION_QUERY_OPERATION, admitActionQueryAlias, assertActionQueryAliasResult,
} from './meri-action-query-alias.js';

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const C = 'a3333333-3333-4333-8333-333333333333';
const C2 = '44444444-4444-4444-8444-444444444444';
const V = '55555555-5555-4555-8555-555555555555';
const D = '66666666-6666-4666-8666-666666666666';
const R = '77777777-7777-4777-8777-777777777777';
const AT = '88888888-8888-4888-8888-888888888888';
const W = '99999999-9999-4999-8999-999999999999';
const P = 'f'.repeat(64);
const ctx = { tenantId: T, userId: A } as TenantContext;
const binding = { tenantId: T, actorId: A, conversationId: V, runId: R,
  attemptId: AT, workerId: W, writerFence: 7 };
const scope = { tenantId: T, kind: 'client', resourceId: C, policyRevision: P };
const subject = { kind: 'client', entityType: 'client', entityIds: [C], tenantId: T, actorId: A,
  authorizationDecisionId: D, policyRevision: P, scopes: [scope], rosterVersionId: null };
const correlation = { binding, subject, policyRevision: P, normalizationContext: null };
const input = { mode: 'client_scoped', selection: { clientId: C, actionItemId: null,
  status: null, sort: 'deadline', page: 1, limit: 20, cursorApplied: false }, cursor: null };
const body = { input, metadata: null };
const grant: MeriReadDelegationGrant = { delegationId: D, mode: 'attended', callKey: 'a8-call',
  kind: 'tool', tenantId: T, actorId: A, clientId: C, conversationId: V, runId: R,
  operation: ACTION_QUERY_OPERATION, binding: { tenantId: T, actorId: A, conversationId: V,
    runId: R, attemptId: AT, writerFence: 7 }, admittedBinding: binding,
  policyRevision: P, correlationSha256: canonicalSha256(correlation),
  argumentsSha256: canonicalSha256(input), hardExpiryMs: Date.now() + 60_000,
  toolRequestSha256: null, referenceSha256: null, jti: D };
const sha = (text: string) => sha256Hex(text);
const admit = (wire: unknown = body, held: MeriReadDelegationGrant | undefined = grant,
  proof: unknown = correlation, verified = true) =>
  admitActionQueryAlias(ctx, wire, held, verified, proof, Date.now());

describe('PR171 reserved A8 action query receiving', () => {
  const priorEnabled = process.env.MERI_ACTION_QUERY_ALIAS_ENABLED;
  afterAll(() => {
    if (priorEnabled === undefined) delete process.env.MERI_ACTION_QUERY_ALIAS_ENABLED;
    else process.env.MERI_ACTION_QUERY_ALIAS_ENABLED = priorEnabled;
  });

  it('adds correlation only for the exact reserved operation and keeps the eleven receiver names separate', () => {
    expect(MERI_RETAINED_SOURCE_TOOLS.size).toBe(11);
    expect(MERI_RETAINED_SOURCE_TOOLS.has('actions.query')).toBe(false);
    expect(MERI_CORRELATED_READ_TOOLS.has('actions.query')).toBe(true);
    expect(MERI_CORRELATED_READ_TOOLS.has('query_action_items')).toBe(false);
    const token = { schemaVersion: 1, kind: 'tool', callKey: 'a8-call', method: 'POST',
      path: '/api/clio/tools/actions.query', bodySha256: sha(JSON.stringify(body)),
      operation: ACTION_QUERY_OPERATION, argumentsSha256: canonicalSha256(input),
      correlationSha256: canonicalSha256(correlation),
      toolRequestSha256: null, referenceSha256: null, retryOf: null };
    expect(parseTokenRequest(token, D)).toMatchObject({ operation: ACTION_QUERY_OPERATION,
      argumentsSha256: canonicalSha256(input), bodySha256: sha(JSON.stringify(body)),
      correlationSha256: canonicalSha256(correlation) });
    expect(() => parseTokenRequest({ ...token, correlationSha256: undefined }, D)).toThrow();
    expect(() => parseTokenRequest({ ...token, operation: { id: 'actions.query', version: '0.3.0' } }, D)).toThrow();
    expect(() => parseTokenRequest({ ...token, path: '/api/clio/tools/query_action_items' }, D)).toThrow();
    expect(() => parseTokenRequest({ ...token, operation: { id: 'query_action_items', version: '0.2.0' },
      path: '/api/clio/tools/query_action_items' }, D)).toThrow();
    const { correlationSha256: _correlation, ...uncorrelated } = token;
    expect(_correlation).toBe(canonicalSha256(correlation));
    expect(parseTokenRequest({ ...uncorrelated, operation: { id: 'query_action_items', version: '0.2.0' },
      path: '/api/clio/tools/query_action_items' }, D).correlationSha256).toBeNull();
  });

  it('projects only the signed normalized selected-client input to the flat canonical owner', () => {
    expect(ACTION_QUERY_OWNER).toBe('query_action_items');
    expect(admit().ownerBody).toEqual({ clientId: C, limit: 20, sort: 'deadline' });
    const selected = { ...input.selection, status: 'new', actionItemId: D, page: null, cursorApplied: true };
    const next = { mode: 'client_scoped', selection: selected, cursor: 'opaque-cursor' };
    const nextGrant = { ...grant, argumentsSha256: canonicalSha256(next) };
    expect(admit({ input: next, metadata: null }, nextGrant)).toMatchObject({ ownerBody: {
      clientId: C, limit: 20, sort: 'deadline', status: 'new', actionItemId: D,
      cursor: 'opaque-cursor',
    } });
  });

  it('refuses ordinary, expired, wrong operation/version and cross-client grants', () => {
    expect(() => admit(body, undefined, correlation, false)).toThrow(ForbiddenException);
    expect(() => admit(body, grant, correlation, false)).toThrow(ForbiddenException);
    expect(() => admit(body, { ...grant, hardExpiryMs: Date.now() - 1 })).toThrow();
    expect(() => admit(body, { ...grant, kind: 'current' })).toThrow();
    expect(() => admit(body, { ...grant, operation: { id: 'query_action_items', version: '0.2.0' } })).toThrow();
    expect(() => admit(body, { ...grant, operation: { id: 'actions.query', version: '0.3.0' } })).toThrow();
    expect(() => admit(body, { ...grant, tenantId: C2 })).toThrow();
    expect(() => admit(body, { ...grant, clientId: C2 })).toThrow();
  });

  it('requires the signed original binding, selected subject, scope and policy', () => {
    for (const proof of [
      { ...correlation, binding: { ...binding, writerFence: 8 } },
      { ...correlation, binding: { ...binding, actorId: C2 } },
      { ...correlation, subject: { ...subject, entityIds: [C2] } },
      { ...correlation, subject: { ...subject, scopes: [{ ...scope, resourceId: C2 }] } },
      { ...correlation, subject: { ...subject, kind: 'portfolio' } },
      { ...correlation, subject: { ...subject, rosterVersionId: 'current-roster-v1' } },
      { ...correlation, policyRevision: 'other' },
      { ...correlation, normalizationContext: {} },
    ]) expect(() => admit(body, grant, proof)).toThrow();
    expect(() => admit(body, { ...grant, correlationSha256: sha('other') })).toThrow();
  });

  it('refuses flat/unscoped bodies, metadata, changed reservation input and ambiguous cursors', () => {
    for (const wire of [
      { clientId: C, limit: 20, sort: 'deadline' },
      { input, metadata: {} },
      { input: { ...input, mode: 'unscoped_list' }, metadata: null },
      { input: { ...input, selection: { ...input.selection, clientId: C2 } }, metadata: null },
      { input: { ...input, selection: { ...input.selection, limit: 51 } }, metadata: null },
      { input: { ...input, selection: { ...input.selection, status: 'unknown' } }, metadata: null },
      { input: { ...input, selection: { ...input.selection, cursorApplied: true } }, metadata: null },
      { input: { ...input, cursor: 'opaque-cursor' }, metadata: null },
      { input: { ...input, unexpected: C2 }, metadata: null },
    ]) expect(() => admit(wire)).toThrow();
    expect(() => admit(body, { ...grant, argumentsSha256: sha('other') })).toThrow();
  });

  it('checks canonical result rows and deployment owner allowlist before release', () => {
    const result = { tool: ACTION_QUERY_OWNER, clientId: C, actions: [{ clientId: C }], coverage: { partial: true } };
    expect(() => assertActionQueryAliasResult(result, C)).not.toThrow();
    expect(() => assertActionQueryAliasResult({ ...result, clientId: C2 }, C)).toThrow(ForbiddenException);
    expect(() => assertActionQueryAliasResult({ ...result, actions: [{ clientId: C2 }] }, C)).toThrow(ForbiddenException);
    expect(() => assertMeriToolAllowed(ACTION_QUERY_OWNER, new Set(['query_tasks']), 'first-chat-preview')).toThrow();
  });

  it('holds the route at 503 by default and refuses an ordinary bearer when enabled', async () => {
    const dispatch = jest.fn();
    const fake = { tools: { executeFromAuthenticatedUser: dispatch } } as unknown as MeriController;
    const req = { headers: { authorization: 'Bearer ordinary-clerk-jwt' } } as Request;
    delete process.env.MERI_ACTION_QUERY_ALIAS_ENABLED;
    await expect(MeriController.prototype.executeTool.call(fake, ctx, 'actions.query', body, req))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.MERI_ACTION_QUERY_ALIAS_ENABLED = 'true';
    await expect(MeriController.prototype.executeTool.call(fake, ctx, 'actions.query', body, req))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
