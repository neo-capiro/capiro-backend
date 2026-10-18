import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import type { MeriReadDelegationGrant } from '../auth/read-delegation/read-delegation-request.js';
import {
  MERI_DELEGATED_READ_TOOLS, parseTokenRequest, sha256Hex,
} from '../auth/read-delegation/read-delegation.contract.js';
import { MeriController } from './meri.controller.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import {
  ACTION_QUERY_OWNER, ACTION_QUERY_OPERATION,
  assertActionQueryAliasAdmission, assertActionQueryAliasResult,
} from './meri-action-query-alias.js';

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const C = 'a3333333-3333-4333-8333-333333333333';
const C2 = '44444444-4444-4444-8444-444444444444';
const V = '55555555-5555-4555-8555-555555555555';
const D = '66666666-6666-4666-8666-666666666666';
const ctx = { tenantId: T, userId: A } as TenantContext;
const body = { clientId: C, limit: 20, sort: 'deadline' };
const grant = {
  kind: 'tool', tenantId: T, actorId: A, clientId: C, conversationId: V,
  operation: ACTION_QUERY_OPERATION,
} as MeriReadDelegationGrant;
const sha = (text: string) => sha256Hex(text);

describe('reserved A8 action query receiving', () => {
  const priorEnabled = process.env.MERI_ACTION_QUERY_ALIAS_ENABLED;
  afterAll(() => {
    if (priorEnabled === undefined) delete process.env.MERI_ACTION_QUERY_ALIAS_ENABLED;
    else process.env.MERI_ACTION_QUERY_ALIAS_ENABLED = priorEnabled;
  });

  it('keeps the exact reserved operation, tool target, and emitted body hash distinct from its owner', () => {
    expect(MERI_DELEGATED_READ_TOOLS.has(ACTION_QUERY_OPERATION.id)).toBe(true);
    expect(ACTION_QUERY_OWNER).toBe('query_action_items');
    const tokenRequest = parseTokenRequest({
      schemaVersion: 1, kind: 'tool', callKey: 'a8-call', method: 'POST',
      path: '/api/clio/tools/actions.query', bodySha256: sha(JSON.stringify(body)),
      operation: ACTION_QUERY_OPERATION, argumentsSha256: sha('original reservation arguments'),
      toolRequestSha256: null, referenceSha256: null, retryOf: null,
    }, D);
    expect(tokenRequest.operation).toEqual(ACTION_QUERY_OPERATION);
    expect(tokenRequest.argumentsSha256).toBe(sha('original reservation arguments'));
    expect(tokenRequest.bodySha256).toBe(sha(JSON.stringify(body)));
    expect(() => parseTokenRequest({
      schemaVersion: 1, kind: 'tool', callKey: 'a8-call', method: 'POST',
      path: '/api/clio/tools/query_action_items', bodySha256: sha(JSON.stringify(body)),
      operation: ACTION_QUERY_OPERATION, argumentsSha256: sha('original reservation arguments'),
      toolRequestSha256: null, referenceSha256: null, retryOf: null,
    }, D)).toThrow();
  });

  it('refuses ordinary, unverified, wrong operation/version, and cross-client calls', () => {
    expect(() => assertActionQueryAliasAdmission(ctx, body, undefined, false)).toThrow(ForbiddenException);
    expect(() => assertActionQueryAliasAdmission(ctx, body, grant, false)).toThrow(ForbiddenException);
    expect(() => assertActionQueryAliasAdmission(ctx, body, { ...grant, kind: 'current' }, true)).toThrow();
    expect(() => assertActionQueryAliasAdmission(ctx, body, { ...grant, operation: { id: 'query_action_items', version: '0.2.0' } }, true)).toThrow();
    expect(() => assertActionQueryAliasAdmission(ctx, body, { ...grant, operation: { id: 'actions.query', version: '0.3.0' } }, true)).toThrow();
    expect(() => assertActionQueryAliasAdmission(ctx, body, { ...grant, tenantId: C2 }, true)).toThrow();
    expect(() => assertActionQueryAliasAdmission(ctx, { ...body, clientId: C2 }, grant, true)).toThrow();
    expect(() => assertActionQueryAliasAdmission(ctx, { limit: 20, sort: 'deadline' }, grant, true)).toThrow();
  });

  it('requires bounded client-scoped selectors and refuses owner-shaped escapes', () => {
    expect(() => assertActionQueryAliasAdmission(ctx, body, grant, true)).not.toThrow();
    for (const unsafe of [
      { ...body, clientId: C.toUpperCase() },
      { ...body, clientId: null },
      { ...body, limit: 51 },
      { ...body, limit: 0 },
      { ...body, sort: 'recent' },
      { ...body, status: 'unknown' },
      { ...body, anotherClientId: C2 },
      { ...body, nested: { clientId: C2 } },
    ]) expect(() => assertActionQueryAliasAdmission(ctx, unsafe, grant, true)).toThrow();
    expect(() => assertActionQueryAliasAdmission(ctx, { ...body, status: 'new', cursor: 'next' }, grant, true)).not.toThrow();
  });

  it('checks the canonical owner and every result row against the selected client before release', () => {
    const result = { tool: ACTION_QUERY_OWNER, clientId: C, actions: [{ clientId: C }], coverage: { partial: true } };
    expect(() => assertActionQueryAliasResult(result, C)).not.toThrow();
    expect(() => assertActionQueryAliasResult({ ...result, clientId: C2 }, C)).toThrow(ForbiddenException);
    expect(() => assertActionQueryAliasResult({ ...result, actions: [{ clientId: C2 }] }, C)).toThrow(ForbiddenException);
    expect(() => assertActionQueryAliasResult({ ...result, tool: 'actions.query' }, C)).toThrow(ForbiddenException);
    expect(() => assertMeriToolAllowed(ACTION_QUERY_OWNER, new Set(['query_tasks']), 'first-chat-preview')).toThrow();
  });

  it('holds the route at 503 by default and refuses an ordinary bearer when explicitly enabled', async () => {
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
