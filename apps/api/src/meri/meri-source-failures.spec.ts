import { HttpException } from '@nestjs/common';
import { MeriToolsService } from './meri-tools.service.js';
import { withMeriReadObservation } from './meri-funding-read-observation.js';
import { withMeriToolExecutionControl } from './meri-tool-request-control.js';

const ctx = { tenantId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002', clerkUserId: 'synthetic-owner' };
const methods = MeriToolsService.prototype as unknown as Record<'legiwatchTool' | 'queryGlobalData', (...args: any[]) => Promise<any>>;

describe('retained source failure meaning', () => {
  const originalFetch = global.fetch, originalSecret = process.env.INTERNAL_SERVICE_SECRET;
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  it.each([400, 401, 403, 404, 429, 500, 503])('retains upstream HTTP %s without exposing its body', async (status) => {
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-only';
    const upstream = new Response('private upstream diagnostic', { status });
    global.fetch = jest.fn(async () => upstream);
    let caught: unknown;
    try {
      await methods.legiwatchTool.call(Object.create(MeriToolsService.prototype), ctx, 'search_legiwatch_news', { view: 'articles' });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(status);
    expect(JSON.stringify((caught as HttpException).getResponse())).not.toContain('private upstream diagnostic');
    expect(upstream.bodyUsed).toBe(true);
  });

  it('forwards the admitted news clock privately after client resolution and preserves the caller body', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-only';
    const bodies: any[] = [];
    global.fetch = jest.fn(async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json({ window: { since: 'synthetic' } }); });
    const service = Object.create(MeriToolsService.prototype);
    Object.assign(service, { ensureClientVisible: async () => 'resolved-client' });
    const input = Object.freeze({ view: 'articles', clientId: 'client-name', newsWindowAsOf: 'model-value' });
    await withMeriReadObservation({ operationId: 'search_legiwatch_news', asOf: '2026-10-17T12:34:56.789Z' }, () =>
      methods.legiwatchTool.call(service, ctx, 'search_legiwatch_news', input));
    expect(bodies[0]).toMatchObject({ newsWindowAsOf: '2026-10-17T12:34:56.789Z', input: { clientId: 'resolved-client' } });
    expect(input.clientId).toBe('client-name');
    await methods.legiwatchTool.call(service, ctx, 'search_legiwatch_news', { view: 'articles' });
    expect(bodies[1]).not.toHaveProperty('newsWindowAsOf');
  });

  it.each([403, 503])('preserves existing mutation refusal semantics for upstream HTTP %s', async (status) => {
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-only';
    global.fetch = jest.fn(async () => new Response('private upstream diagnostic', { status }));
    let caught: unknown;
    try { await methods.legiwatchTool.call(Object.create(MeriToolsService.prototype), ctx, 'prepare_legiwatch_briefing', {}); }
    catch (error) { caught = error; }
    expect((caught as HttpException).getStatus()).toBe(400);
    expect((caught as Error).message).toBe(`LegiWatch current scope, source or approval requires review (HTTP ${status})`);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not forward an observed clock through an expired tool request', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-only';
    global.fetch = jest.fn();
    await expect(withMeriToolExecutionControl({ deadlineAt: Date.now() - 1, signal: new AbortController().signal }, () =>
      withMeriReadObservation({ operationId: 'search_legiwatch_news', asOf: '2026-10-17T12:34:56.789Z' }, () =>
        methods.legiwatchTool.call(Object.create(MeriToolsService.prototype), ctx, 'search_legiwatch_news', { view: 'articles' })))).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(['permission denied for relation synthetic', 'connection refused', 'statement timeout'])('does not guess a failure cause for %s', async (diagnostic) => {
    const audits: any[] = [];
    const service = Object.create(MeriToolsService.prototype);
    Object.assign(service, {
      analyticsDb: { run: async () => { throw new Error(diagnostic); } },
      prisma: { withSystem: async (read: any) => read({ meriAnalyticsQueryLog: { create: async ({ data }: any) => { audits.push(data); } } }) },
      logger: { warn: jest.fn(), error: jest.fn() },
    });
    const result = await methods.queryGlobalData.call(service, ctx, { dataset: 'lda_registrations', select: [{ field: 'registrant_name' }] });
    expect(result).toMatchObject({ tool: 'query_global_data', ok: false });
    expect(result.error).not.toMatch(/timeout|expensive|narrowing|lowering/i);
    expect(result.error).not.toContain(diagnostic);
    expect(result).not.toHaveProperty('rows');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ datasetKey: 'lda_registrations', error: diagnostic, rowCount: undefined });
  });

  it('keeps a successful empty query distinct from a failure and records it', async () => {
    const audits: any[] = [];
    const service = Object.create(MeriToolsService.prototype);
    Object.assign(service, { analyticsDb: { run: async () => [] },
      prisma: { withSystem: async (read: any) => read({ meriAnalyticsQueryLog: { create: async ({ data }: any) => { audits.push(data); } } }) },
      logger: { warn: jest.fn(), error: jest.fn() } });
    const result = await methods.queryGlobalData.call(service, ctx, { dataset: 'lda_registrations', select: [{ field: 'registrant_name' }] });
    expect(result).toMatchObject({ rowCount: 0, rows: [] });
    expect(result).not.toHaveProperty('error');
    expect(audits[0]).toMatchObject({ rowCount: 0, error: undefined });
  });
});
