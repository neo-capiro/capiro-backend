import { ActivityCommandPlanner } from './activity-command.planner.js';
import { bearer, ctx, IDs } from '../../../test/support/activity-command.fixture.js';
const validReceipt = { requestId: IDs.request, status: 'completed', taskId: IDs.task };
describe('bounded Planner bridge (synthetic fetch only)', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  const bridge = (origin = 'https://strategy.invalid') =>
    new ActivityCommandPlanner({ get: () => origin } as any);
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });
  it('sends only the original bearer, expected authenticated scope and exact saved intent', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(validReceipt), { status: 201 }));
    expect(await bridge().create(ctx, bearer, IDs.request, { name: 'Generic' })).toEqual({
      kind: 'found',
      taskId: IDs.task,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://strategy.invalid/strategy-api/planner/task-create-commands',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        signal: expect.any(AbortSignal),
        headers: {
          authorization: bearer,
          'content-type': 'application/json',
          'x-capiro-expected-tenant-id': IDs.tenant,
          'x-capiro-expected-actor-id': ctx.clerkUserId,
        },
        body: JSON.stringify({ requestId: IDs.request, data: { name: 'Generic' } }),
      }),
    );
  });
  it.each([
    '',
    'http://strategy.invalid',
    'https://u:p@strategy.invalid',
    'https://strategy.invalid/path',
    'https://strategy.invalid/?x=1',
    'https://strategy.invalid/#fragment',
  ])('rejects unsafe or ambiguous configured origin %s', (origin) => {
    expect(() => bridge(origin).origin()).toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409, 429, 500, 503, 302])(
    'classifies POST status %s without retry or exposing its body',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('provider secret', { status }));
      const result = await bridge().create(ctx, bearer, IDs.request, {});
      expect(result.kind).toBe('blocked');
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it('GET 404 is ambiguous and does not issue a POST by itself', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    expect(await bridge().lookup(ctx, bearer, IDs.request)).toEqual({ kind: 'missing' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...validReceipt, requestId: IDs.client },
    { ...validReceipt, taskId: 'wrong' },
    { ...validReceipt, status: 'pending' },
    { ...validReceipt, secret: 'excess' },
  ])('rejects a malformed or differently keyed receipt %j', async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    expect(await bridge().lookup(ctx, bearer, IDs.request)).toEqual({
      kind: 'blocked',
      code: 'planner_receipt_invalid',
    });
  });
  it('bounds response bytes', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(4097), { status: 200 }));
    expect(await bridge().lookup(ctx, bearer, IDs.request)).toEqual({
      kind: 'blocked',
      code: 'planner_receipt_invalid',
    });
  });
  it('retains unknown outcome on network/abort failure without an automatic retry', async () => {
    fetchMock.mockRejectedValue(new Error('synthetic timeout with private text'));
    expect(await bridge().create(ctx, bearer, IDs.request, {})).toEqual({
      kind: 'blocked',
      code: 'planner_unavailable',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'synthetic', 'Bearer token\nsecret'])(
    'requires a bounded bearer %j',
    async (authorization) => {
      await expect(bridge().lookup(ctx, authorization, IDs.request)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
