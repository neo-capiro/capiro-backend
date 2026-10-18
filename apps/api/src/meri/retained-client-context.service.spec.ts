import { ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';
import { withMeriToolExecutionControl } from './meri-tool-request-control.js';
import { parseClientProfileQuery } from './meri-client-context.helpers.js';
import type { RetainedSourceV02Admission } from './retained-source-v02/admission.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const ctx = { tenantId, userId: actorId } as TenantContext;
function admission(): RetainedSourceV02Admission {
  return {
    operation: { id: 'get_client_context', version: '0.3.0' },
    binding: { tenantId, actorId,
      conversationId: '44444444-4444-4444-8444-444444444444',
      runId: '55555555-5555-4555-8555-555555555555',
      attemptId: '66666666-6666-4666-8666-666666666666',
      workerId: '77777777-7777-4777-8777-777777777777', writerFence: 1 },
    subject: { kind: 'client', entityType: 'client', entityIds: [clientId], tenantId, actorId,
      authorizationDecisionId: '88888888-8888-4888-8888-888888888888',
      policyRevision: 'policy-1', scopes: [], rosterVersionId: null },
    input: { clientId, section: null, afterId: null, limit: 25, representation: 'summary' },
    metadata: null, normalizationContext: {
      asOf: '2026-10-18T10:00:00.000Z',
    }, argumentsSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64),
    clientId, hardExpiryMs: Date.now() + 30_000,
  };
}
const run = <T>(fn: () => Promise<T>) => withMeriToolExecutionControl(
  { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 }, fn,
);

describe('inert retained client context 0.3 owner read window', () => {
  it('brackets every canonical profile read and rechecks the selected-client wall', async () => {
    const sequence: string[] = [];
    const ensureClientVisible = jest.fn(async () => { sequence.push('wall'); return clientId; });
    const getClientContext = jest.fn(async () => {
      sequence.push('canonical');
      return { tool: 'get_client_context', generatedAt: new Date().toISOString(), profile: {} };
    });
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    Object.assign(service, { ensureClientVisible, getClientContext });
    const source = await run(() => service.readRetainedClientContextSourceV03(ctx, admission()));
    expect(sequence).toEqual(['wall', 'canonical', 'wall']);
    expect(source.result).toMatchObject({ tool: 'get_client_context' });
    expect(getClientContext).toHaveBeenCalledWith(ctx, {
      clientId, limit: 25, representation: 'summary',
    });
    expect(Date.parse(source.readWindow.startedAt)).toBeLessThanOrEqual(
      Date.parse(source.readWindow.completedAt));
    expect(source.readWindow.startedAt).not.toBe('2026-10-18T10:00:00.000Z');
  });

  it('refuses the old operation version before the owner read', async () => {
    const getClientContext = jest.fn();
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    Object.assign(service, { getClientContext });
    const request = admission(); request.operation.version = '0.2.0';
    await expect(run(() => service.readRetainedClientContextSourceV03(ctx, request)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(getClientContext).not.toHaveBeenCalled();
  });

  it('refuses a changed selected-client wall after the canonical read', async () => {
    const ensureClientVisible = jest.fn()
      .mockResolvedValueOnce(clientId)
      .mockResolvedValueOnce('99999999-9999-4999-8999-999999999999');
    const getClientContext = jest.fn(async () => ({ tool: 'get_client_context' }));
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    Object.assign(service, { ensureClientVisible, getClientContext });
    await expect(run(() => service.readRetainedClientContextSourceV03(ctx, admission())))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(getClientContext).toHaveBeenCalledTimes(1);
    expect(ensureClientVisible).toHaveBeenCalledTimes(2);
  });

  it('translates a normalized continuation to a scoped canonical cursor', async () => {
    const getClientContext = jest.fn(async (_ctx: TenantContext, _input: Record<string, unknown>) =>
      ({ tool: 'get_client_context' }));
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    Object.assign(service, { ensureClientVisible: jest.fn(async () => clientId), getClientContext });
    const request = admission();
    request.input = { clientId, section: 'people', afterId: 'person-27', limit: 10, representation: 'full' };
    await run(() => service.readRetainedClientContextSourceV03(ctx, request));
    const legacy = getClientContext.mock.calls[0]![1] as Record<string, unknown>;
    expect(parseClientProfileQuery(legacy, clientId)).toEqual({
      section: 'people', afterId: 'person-27', limit: 10, representation: 'full',
    });
    expect(request.input).toEqual({
      clientId, section: 'people', afterId: 'person-27', limit: 10, representation: 'full',
    });
  });

  it('refuses malformed normalized selection before any owner read', async () => {
    const getClientContext = jest.fn();
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    Object.assign(service, { getClientContext });
    const request = admission();
    request.input = { clientId, section: null, afterId: 'person-27', limit: 10, representation: 'full' };
    await expect(run(() => service.readRetainedClientContextSourceV03(ctx, request)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(getClientContext).not.toHaveBeenCalled();
  });
});
