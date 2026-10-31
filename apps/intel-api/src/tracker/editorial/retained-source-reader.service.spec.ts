import { ForbiddenException } from '@nestjs/common';
import { PHASE8_FEATURES } from '@capiro/shared';
import { Phase8EvidenceService } from './evidence.service.js';
import { RetainedSourceReaderService } from './retained-source-reader.service.js';

const ctx = { tenantId: 'synthetic-tenant', clerkUserId: 'synthetic-actor', role: null };
function fixture() {
  const queries: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?');
      queries.push(sql);
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
