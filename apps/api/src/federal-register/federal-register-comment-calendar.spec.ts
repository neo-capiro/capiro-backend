import { PATH_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FederalRegisterController } from './federal-register.controller.js';
import { FederalRegisterService } from './federal-register.service.js';

const input = { dateFrom: '2026-09-01', dateTo: '2026-12-31' };
const row = (documentNumber: string, date: string | null) => ({
  documentNumber, title: 'Synthetic comment notice', agencyNames: ['Synthetic agency'],
  htmlUrl: 'https://www.federalregister.gov/documents/2026/09/01/2026-12345',
  commentEndDate: date ? new Date(date) : null,
  publicationDate: new Date('2026-09-01'), effectiveDate: new Date('2026-10-01'),
});
function harness(rows = [row('2026-12345', '2026-12-31')], total = rows.length) {
  const tx = {
    federalRegisterDocument: {
      findMany: jest.fn().mockResolvedValue(rows), count: jest.fn().mockResolvedValue(total),
    },
    syncRun: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const prisma = { $transaction: jest.fn((fn: any, _options?: unknown) => fn(tx)) };
  return { service: new FederalRegisterService(prisma as any), prisma, tx };
}

describe('cached regulatory comment calendar', () => {
  it('uses the existing authenticated owner and a distinct comment route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, FederalRegisterController)).toContain(RolesGuard);
    expect(Reflect.getMetadata(ROLES_KEY, FederalRegisterController)).toEqual(['standard_user']);
    expect(Reflect.getMetadata(PATH_METADATA, FederalRegisterController.prototype.commentDeadlineCalendar))
      .toBe('comment-deadline-calendar');
  });
  it('supports historical and extended ranges with inclusive end-day and stable paging', async () => {
    const h = harness([row('2026-12345', '2026-12-31')], 3);
    const result = await h.service.getCommentDeadlineCalendar({ ...input, page: 2, limit: 1 });
    expect(h.tx.federalRegisterDocument.findMany.mock.calls[0][0]).toMatchObject({
      where: { commentEndDate: { gte: new Date('2026-09-01'), lt: new Date('2027-01-01') } },
      orderBy: [{ commentEndDate: 'asc' }, { documentNumber: 'asc' }], skip: 1, take: 1,
    });
    expect(h.tx.federalRegisterDocument.count.mock.calls[0][0].where)
      .toEqual(h.tx.federalRegisterDocument.findMany.mock.calls[0][0].where);
    expect(result.data[0]).toMatchObject({ documentNumber: '2026-12345', date: '2026-12-31',
      dateKind: 'comment_deadline', precision: 'date', provenance: { sourceField: 'comments_close_on' } });
    expect(result.pagination).toEqual({ totalCandidates: 3, returned: 1,
      excludedOnPage: 0, hasMoreCandidates: true });
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
  });
  it.each([
    { dateFrom: '2026-02-30' }, { dateFrom: '2027-01-01' }, { dateTo: '2028-01-01' },
    { dateFrom: '2026-09-01T00:00:00Z' }, { page: 0 }, { page: 10001 }, { page: 1.5 },
    { limit: 0 }, { limit: 101 }, { limit: Number.NaN },
  ])('refuses invalid dates or unbounded paging before any source read: %p', async (change) => {
    const h = harness();
    await expect(h.service.getCommentDeadlineCalendar({ ...input, ...change })).rejects.toThrow();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('never substitutes publication/effective dates or invents a date from a cached instant', async () => {
    const h = harness([row('missing', null), row('instant', '2026-10-01T18:00:00Z'),
      row('outside', '2027-01-01')], 4);
    const result = await h.service.getCommentDeadlineCalendar({ ...input, limit: 3 });
    expect(result.data).toEqual([]);
    expect(result.pagination).toMatchObject({ totalCandidates: 4, excludedOnPage: 3,
      hasMoreCandidates: true });
  });
  it('reports cache-only coverage even when the latest ingestion succeeded', async () => {
    const h = harness();
    h.tx.syncRun.findFirst.mockResolvedValue({ source: 'sync-federal-register', status: 'success' });
    const result = await h.service.getCommentDeadlineCalendar(input);
    expect(result.coverage).toMatchObject({ complete: false, allFederalDocuments: false,
      latestIngestion: { status: 'success' } });
    expect(h.tx.syncRun.findFirst.mock.calls[0][0].where).toEqual({ source: 'sync-federal-register' });
  });
  it('keeps an empty cache distinct from complete publisher coverage', async () => {
    const result = await harness([], 0).service.getCommentDeadlineCalendar(input);
    expect(result.data).toEqual([]);
    expect(result.pagination.hasMoreCandidates).toBe(false);
    expect(result.coverage.complete).toBe(false);
  });
  it('propagates source/refresh failures rather than fabricating an empty success', async () => {
    const h = harness();
    h.tx.syncRun.findFirst.mockRejectedValue(new Error('Synthetic read failure'));
    await expect(h.service.getCommentDeadlineCalendar(input)).rejects.toThrow('Synthetic read failure');
  });
});
