import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
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
  policyRevision: P, scopes: [scope], rosterVersionId: null };
const correlation = { binding, subject, policyRevision: P, normalizationContext: null };
const input = { mode: 'client_scoped', selection: { clientId: C, actionItemId: null,
  status: null, sort: 'deadline', page: 1, limit: 20, cursorApplied: false }, cursor: null };
const body = { input, metadata: null };
const admit = (wire: unknown = body, proof: unknown = correlation, verified = true, deadline = Date.now() + 60_000) =>
  admitActionQueryAlias(ctx, wire, verified, proof, deadline, Date.now());

describe('ordinary selected-client action query', () => {
  it('projects only the normalized selected-client input to the flat canonical owner', () => {
    expect(ACTION_QUERY_OWNER).toBe('query_action_items');
    expect(admit().ownerBody).toEqual({ clientId: C, limit: 20, sort: 'deadline' });
    const selected = { ...input.selection, status: 'new', actionItemId: D, page: null, cursorApplied: true };
    const next = { mode: 'client_scoped', selection: selected, cursor: 'opaque-cursor' };
    expect(admit({ input: next, metadata: null })).toMatchObject({ ownerBody: {
      clientId: C, limit: 20, sort: 'deadline', status: 'new', actionItemId: D,
      cursor: 'opaque-cursor',
    } });
  });

  it('requires verified service, a current deadline and matching authenticated actor', () => {
    expect(() => admit(body, correlation, false)).toThrow(ForbiddenException);
    expect(() => admit(body, correlation, true, Date.now() - 1)).toThrow(ForbiddenException);
    expect(() => admitActionQueryAlias({ ...ctx, userId: C2 }, body, true, correlation,
      Date.now() + 60_000, Date.now())).toThrow(ForbiddenException);
  });

  it('requires matching actor, selected subject, scope and policy', () => {
    for (const proof of [
      { ...correlation, binding: { ...binding, actorId: C2 } },
      { ...correlation, subject: { ...subject, entityIds: [C2] } },
      { ...correlation, subject: { ...subject, scopes: [{ ...scope, resourceId: C2 }] } },
      { ...correlation, subject: { ...subject, kind: 'portfolio' } },
      { ...correlation, subject: { ...subject, rosterVersionId: 'current-roster-v1' } },
      { ...correlation, policyRevision: 'other' },
      { ...correlation, normalizationContext: {} },
    ]) expect(() => admit(body, proof)).toThrow();
  });

  it('refuses flat/unscoped bodies, metadata, foreign selectors and ambiguous cursors', () => {
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
  });

  it('checks canonical result rows and deployment owner allowlist before release', () => {
    const result = { tool: ACTION_QUERY_OWNER, clientId: C, actions: [{ clientId: C }], coverage: { partial: true } };
    expect(() => assertActionQueryAliasResult(result, C)).not.toThrow();
    expect(() => assertActionQueryAliasResult({ ...result, clientId: C2 }, C)).toThrow(ForbiddenException);
    expect(() => assertActionQueryAliasResult({ ...result, actions: [{ clientId: C2 }] }, C)).toThrow(ForbiddenException);
    expect(() => assertMeriToolAllowed(ACTION_QUERY_OWNER, new Set(['query_tasks']), 'first-chat-preview')).toThrow();
  });

  it('rejects a bearer-only request before invoking the actual owner', async () => {
    const dispatch = jest.fn();
    const fake = { tools: { executeFromAuthenticatedUser: dispatch } } as unknown as MeriController;
    const req = { headers: { authorization: 'Bearer synthetic-clerk-jwt' } } as Request;
    await expect(MeriController.prototype.executeTool.call(fake, ctx, 'actions.query', body, req))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
