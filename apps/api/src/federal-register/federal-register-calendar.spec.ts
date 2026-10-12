import { FederalRegisterService } from './federal-register.service.js';
import { FederalRegisterController } from './federal-register.controller.js';
import { buildEffectiveDateEvidence } from './effective-date-evidence.js';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
const now = new Date('2026-10-12T06:00:00Z');
const source = {
  document_number: '2026-12345',
  type: 'Rule',
  publication_date: '2026-10-12',
  effective_on: '2026-11-12',
  pdf_url: 'https://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
  correction_of: null,
  corrections: [],
};
function row(time = now) {
  return {
    documentNumber: source.document_number,
    title: 'Rule',
    agencyNames: [],
    effectiveDate: new Date('2026-11-12'),
    evidence: buildEffectiveDateEvidence(source, time),
    observedAt: time,
  };
}
function harness(rows = [row()]) {
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([{ total: 2n }])
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ rules: 10n, withoutEvidence: 6n, notSupported: 2n }]),
    syncRun: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const prisma = { $transaction: jest.fn((fn: any, _options: any) => fn(tx)) };
  return { service: new FederalRegisterService(prisma as any), tx, prisma };
}
describe('effective date calendar owner', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());
  it('retains authenticated standard user role guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, FederalRegisterController)).toContain(RolesGuard);
    expect(Reflect.getMetadata(ROLES_KEY, FederalRegisterController)).toEqual(['standard_user']);
  });
  it('projects effective provenance and explicit bounded coverage/pagination', async () => {
    const h = harness();
    const output = await h.service.getEffectiveDateCalendar({
      dateFrom: '2026-11-01',
      dateTo: '2026-12-01',
    });
    expect(output.data).toHaveLength(1);
    expect(output.data[0]).toMatchObject({
      date: '2026-11-12',
      dateKind: 'effective',
      provenance: { sourceField: 'effective_on' },
    });
    expect(output.coverage).toMatchObject({
      complete: false,
      allFederalRules: false,
      withoutEvidence: 6,
      latestRefresh: null,
    });
    expect(output.pagination).toMatchObject({ totalCandidates: 2, hasMoreCandidates: true });
    expect(h.prisma.$transaction.mock.calls[0]![1]).toMatchObject({
      isolationLevel: 'RepeatableRead',
    });
  });
  it.each([
    { dateFrom: '2026-02-30', dateTo: '2026-12-01' },
    { dateFrom: '2026-12-01', dateTo: '2026-11-01' },
    { dateFrom: '2026-01-01', dateTo: '2028-01-01' },
    { dateFrom: '2026-11-01', dateTo: '2026-12-01', limit: 101 },
    { dateFrom: '2026-11-01', dateTo: '2026-12-01', page: 0 },
  ])('refuses invalid/broad input before queries %p', async (input) => {
    const h = harness();
    await expect(h.service.getEffectiveDateCalendar(input)).rejects.toThrow();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['legacy', 'stale', 'future', 'mismatch', 'tampered', 'column-time'])(
    'refuses %s evidence',
    async (mode) => {
      let value = row();
      if (mode === 'legacy') value.evidence = null as any;
      if (mode === 'stale') value = row(new Date(now.getTime() - 49 * 3600000));
      if (mode === 'future') value = row(new Date(now.getTime() + 1000));
      if (mode === 'mismatch') value.effectiveDate = new Date('2026-12-01');
      if (mode === 'tampered')
        value.evidence = { ...value.evidence, status: 'supported', date: '2026-12-01' };
      if (mode === 'column-time') value.observedAt = new Date(now.getTime() - 1000);
      const output = await harness([value]).service.getEffectiveDateCalendar({
        dateFrom: '2026-11-01',
        dateTo: '2026-12-01',
      });
      expect(output.data).toEqual([]);
      expect(output.pagination.excludedOnPage).toBe(1);
    },
  );
});
