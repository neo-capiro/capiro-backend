import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PHASE8_FEATURES } from '@capiro/shared';
import { Phase8EvidenceService } from './evidence.service.js';
import { RetainedSourceReaderService } from './retained-source-reader.service.js';
import { KeywordMeriController } from '../keywords/keyword-meri.controller.js';

const ctx = { tenantId: 'synthetic-tenant', clerkUserId: 'synthetic-actor', role: null };
function fixture() {
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  const tx = {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      queries.push(sql);
      bindings.push(values);
      if (sql.includes('SELECT o.*, EXISTS')) return [{ id: 'first' }, { id: 'next' }];
      if (sql.includes('SELECT p.*,COALESCE')) return [{ id: 'person' }];
      return [];
    }),
  };
  const reports = {
    authorize: jest.fn(),
    folders: { withActor: jest.fn(async (_ctx: unknown, fn: Function) => fn(tx)) },
  };
  const research = { keywords: { reports }, context: jest.fn() };
  return {
    reports,
    research,
    tx,
    queries,
    bindings,
    reader: new RetainedSourceReaderService(new Phase8EvidenceService(research as never)),
  };
}

test('retained article reads preserve the existing feature, actor scope, paging and source coverage', async () => {
  const { reader, reports, research, queries } = fixture();
  const result = await reader.news(ctx, { limit: 1, days: 7, clientId: 'synthetic-client' });
  expect(reports.authorize).toHaveBeenCalledWith(ctx, PHASE8_FEATURES.news);
  expect(reports.folders.withActor).toHaveBeenCalledWith(ctx, expect.any(Function), {
    timeoutMs: 45000,
  });
  expect(research.context).toHaveBeenCalledWith(
    expect.anything(),
    ctx,
    expect.objectContaining({ clientId: 'synthetic-client' }),
    false,
  );
  expect(result).toMatchObject({ items: [{ id: 'first' }], nextOffset: 1, matchDefinition: null });
  expect(result.coverageMessage).toContain('Missing article bodies');
  expect(queries.join(' ')).not.toMatch(/intel_legiwatch_news_(monitor|match)/);
});

describe('captured article window through the authenticated owner bridge', () => {
  const asOf = '2026-10-17T12:34:56.789Z';
  const body = { tenantId: '00000000-0000-4000-8000-000000000001', actor: 'synthetic-actor',
    tool: 'search_legiwatch_news', input: { view: 'articles', days: 7 }, newsWindowAsOf: asOf };
  function controller(reader: RetainedSourceReaderService) {
    return new KeywordMeriController({} as never, {} as never, {} as never, {} as never,
      {} as never, reader.evidence, {} as never, reader);
  }
  afterEach(() => jest.useRealTimers());
  it('uses one captured lower bound for both returned rows and publisher coverage after clock delay', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-18T12:34:56.789Z'));
    const f = fixture();
    const page = await controller(f.reader).read(body) as { window: { since: string; days: number } };
    const since = '2026-10-10T12:34:56.789Z';
    expect(page.window).toEqual({ since, days: 7 });
    expect(f.bindings.flat().filter((value) => value instanceof Date).map((value) => (value as Date).toISOString()))
      .toEqual([since, since]);
    const direct = await f.reader.news(ctx, body.input);
    expect(direct.window.since).toBe('2026-10-11T12:34:56.789Z');
  });
  it.each(['not-a-date', '2026-10-17', '2026-10-17T12:34:56Z'])('refuses noncanonical private clock %s', async (newsWindowAsOf) => {
    const f = fixture();
    await expect(controller(f.reader).read({ ...body, newsWindowAsOf })).rejects.toThrow(BadRequestException);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(['personnel', 'source'])('does not admit an article clock for %s', async (view) => {
    const f = fixture();
    await expect(controller(f.reader).read({ ...body, input: { ...body.input, view } })).rejects.toThrow(BadRequestException);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('does not accept a model input field as the private clock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-18T12:34:56.789Z'));
    const f = fixture();
    const { newsWindowAsOf, ...directBody } = body;
    const page = await controller(f.reader).read({ ...directBody, input: { ...body.input, newsWindowAsOf } }) as { window: { since: string } };
    expect(page.window.since).toBe('2026-10-11T12:34:56.789Z');
  });
  it('preserves feature, current client and folder checks with an observed clock', async () => {
    for (const denial of ['feature', 'client', 'folder']) {
      const f = fixture();
      if (denial === 'feature') f.reports.authorize.mockRejectedValue(new ForbiddenException());
      if (denial === 'client') f.research.context.mockRejectedValue(new ForbiddenException());
      Object.assign(f.research.keywords, { folder: async () => ({ clientId: 'other-client' }) });
      const input = denial === 'folder' ? { ...body.input, folderId: 'synthetic-folder', clientId: 'selected-client' } : body.input;
      await expect(controller(f.reader).read({ ...body, input })).rejects.toBeInstanceOf(denial === 'folder' ? NotFoundException : ForbiddenException);
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    }
  });
});

test('old monitor scoped requests are rejected without broadening the search', async () => {
  const { reader, tx } = fixture();
  await expect(reader.news(ctx, { monitorId: 'old-monitor' })).rejects.toThrow(
    'NEWS_MONITOR_FILTER_RETIRED',
  );
  expect(tx.$queryRaw).not.toHaveBeenCalled();
});

test('personnel reads retain current source authority and no mutation methods', async () => {
  const { reader, reports } = fixture();
  expect(await reader.personnel(ctx, { year: 2026, kind: 'change' })).toMatchObject({
    items: [{ id: 'person' }],
    nextOffset: null,
  });
  expect(reports.authorize).toHaveBeenCalledWith(ctx, PHASE8_FEATURES.news);
  expect(Object.getOwnPropertyNames(RetainedSourceReaderService.prototype)).toEqual([
    'constructor',
    'news',
    'personnel',
  ]);
});

test('revoked authority prevents both retained source families from querying', async () => {
  const { reader, reports, tx } = fixture();
  reports.authorize.mockRejectedValue(new ForbiddenException());
  await expect(reader.news(ctx, {})).rejects.toThrow(ForbiddenException);
  await expect(reader.personnel(ctx, {})).rejects.toThrow(ForbiddenException);
  expect(tx.$queryRaw).not.toHaveBeenCalled();
});
