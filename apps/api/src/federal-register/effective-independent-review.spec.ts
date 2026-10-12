import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { buildEffectiveDateEvidence, dateOnly, EVIDENCE_MAX_AGE_MS, readEffectiveDateEvidence } from './effective-date-evidence.js';
import { persistFederalRegisterObservation } from './federal-register-observation.js';
import { FederalRegisterService } from './federal-register.service.js';
import { FederalRegisterController } from './federal-register.controller.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { runWithSyncRun } from '../ingestion/sync-run.helper.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
const NOW = new Date('2026-10-12T06:00:00.000Z');
const RULE = {
  document_number: '2026-12345', type: 'Rule', effective_on: '2026-11-12',
  publication_date: '2026-10-12', comments_close_on: '2026-10-31',
  pdf_url: 'https://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
  correction_of: null, corrections: [],
};
const RANGE = { dateFrom: '2026-11-01', dateTo: '2026-12-01' };
function evidence(patch: Record<string, unknown> = {}, at = NOW, previous: unknown = null) {
  return buildEffectiveDateEvidence({ ...RULE, ...patch }, at, previous);
}
function calendarRow(at = NOW) {
  return { documentNumber: RULE.document_number, title: 'Synthetic rule', agencyNames: [],
    effectiveDate: new Date('2026-11-12T00:00:00.000Z'), observedAt: at, evidence: evidence({}, at) };
}
function calendarHarness(rows: any[] = [calendarRow()]) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValueOnce([{ total: BigInt(rows.length) }])
      .mockResolvedValueOnce(rows).mockResolvedValueOnce([{ rules: 99n, withoutEvidence: 7n, notSupported: 4n }]),
    syncRun: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
  };
  const prisma = { $transaction: jest.fn((fn: any, _options?: unknown) => fn(tx)) };
  return { service: new FederalRegisterService(prisma as any), tx, prisma };
}
function observationHarness(prior: unknown = null, at: Date | null = null) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(at ? [{ evidence: prior, observedAt: at }] : []),
    $executeRaw: jest.fn().mockResolvedValue(1),
    federalRegisterDocument: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((fn: any) => fn(tx)) };
  const metadata = { documentNumber: RULE.document_number, type: 'RULE', title: 'Synthetic rule',
    publicationDate: new Date(RULE.publication_date), pdfUrl: RULE.pdf_url,
    agencyNames: [], docketIds: [], cfrReferences: [], topics: [] };
  return { tx, prisma, metadata };
}

describe('independent adversarial effective-date provenance review', () => {
  it.each(['2026-02-29', '2026-11-31', '2026-1-01', ' 2026-11-12', '2026-11-12T00:00:00Z',
    '2026-11-12T00:00:00+05:00', 20261112, undefined])('rejects non-exact date %p', value => {
    expect(dateOnly(value)).toBeNull();
    expect(evidence({ effective_on: value }).status).not.toBe('supported');
  });
  it('accepts a valid leap date and never substitutes publication or comment dates', () => {
    expect(dateOnly('2028-02-29')).toBe('2028-02-29');
    const v = evidence({ effective_on: null });
    expect(v.date).toBeNull(); expect(v.status).toBe('missing_date');
    expect(v.sourceField).toBe('effective_on'); expect(v.dateKind).toBe('effective');
  });
  it.each(['PROPOSED_RULE', 'Proposed Rule', 'Notice', 'PRESIDENTIAL_DOCUMENT'])('excludes %s even with dates', type => {
    expect(evidence({ type }).status).toBe('unsupported_document_type');
  });
  it.each([
    'http://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
    'https://www.govinfo.gov.evil.example/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
    'https://attacker@www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
    'https://www.govinfo.gov:8443/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
    'https://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-99999.pdf',
    'https://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf?redirect=1',
    'https://www.govinfo.gov/content/pkg/FR-2026-99-99/pdf/2026-12345.pdf',
    'https://www.govinfo.gov/content/pkg/FR-2026-10-11/pdf/2026-12345.pdf',
  ])('refuses unqualified official PDF %s', pdf_url => {
    expect(evidence({ pdf_url }).status).toBe('missing_official_pdf');
  });
  it.each([{ correction_of: undefined }, { corrections: undefined }, { corrections: null },
    { correction_of: 'https://www.federalregister.gov/documents/2026-12344' },
    { corrections: ['https://evil.example/api/v1/documents/2026-12344.json'] },
    { corrections: ['https://www.federalregister.gov/api/v1/documents/2026-12344.json?x=1'] }])(
    'rejects incomplete or unsafe correction metadata %p', patch => {
      expect(evidence(patch).status).toBe('incomplete_correction_metadata');
    });
  it('suppresses both corrections and corrected originals rather than treating them as verified', () => {
    const link = 'https://www.federalregister.gov/api/v1/documents/2026-12344.json';
    expect(evidence({ correction_of: link }).status).toBe('correction_requires_review');
    expect(evidence({ corrections: [link] }).status).toBe('correction_requires_review');
  });
  it('refreshes observation without changing revision, and records the corrected transition exactly once', () => {
    const first = evidence(); const later = new Date(NOW.getTime() + 60000);
    const refresh = evidence({}, later, first);
    expect(refresh.revision).toBe(1); expect(refresh.evidenceHash).toBe(first.evidenceHash);
    expect(refresh.changedAt).toBe(first.changedAt); expect(refresh.observedAt).toBe(later.toISOString());
    const correction = evidence({ effective_on: '2026-11-13' }, later, refresh);
    expect(correction.revision).toBe(2);
    expect(correction.previous).toMatchObject({ date: '2026-11-12', revision: 1, observedAt: refresh.observedAt });
    expect(evidence({ effective_on: '2026-11-13' }, new Date(later.getTime() + 60000), correction).previous)
      .toEqual(correction.previous);
  });
  it.each([{ dateKind: 'publication' }, { documentNumber: '2026-99999' }, { sourceField: 'comments_close_on' },
    { sourceUrl: 'https://evil.example' }, { evidenceHash: '0'.repeat(64) }, { date: '2026-12-01' },
    { revision: 0 }, { observedAt: 'invalid' }, { changedAt: 'invalid' },
    { observedAt: '2026-10-12' }, { changedAt: '2026-10-12T06:00:00Z' },
    { changedAt: '2026-10-12T06:00:00.001Z' }])('fails closed on malformed receipts %p', patch => {
      expect(readEffectiveDateEvidence({ ...evidence(), ...patch }, RULE.document_number)).toBeNull();
    });
  it('recomputes the source projection checksum rather than trusting the receipt hash', () => {
    const original = evidence(); const tampered = { ...original, officialPdfUrl: RULE.pdf_url.replace('12345', '99999') };
    expect(readEffectiveDateEvidence(tampered, RULE.document_number)).toBeNull();
    expect(readEffectiveDateEvidence(original, '2026-99999')).toBeNull();
  });
  it('bounds previous snapshots and strips unexpected provenance fields', () => {
    const first = evidence(); const corrected = evidence({ effective_on: '2026-11-13' }, new Date(NOW.getTime() + 60000), first);
    const extra = { ...corrected, arbitrary: 'must not return', previous: { ...corrected.previous, arbitrary: 'must not return' } };
    const read = readEffectiveDateEvidence(extra, RULE.document_number);
    expect(read).toEqual(corrected);
    expect(readEffectiveDateEvidence({ ...corrected, previous: { ...corrected.previous, revision: corrected.revision } }, RULE.document_number)).toBeNull();
    expect(readEffectiveDateEvidence({ ...corrected, previous: { ...corrected.previous, observedAt: '2026-10-12T06:01:00.001Z' } }, RULE.document_number)).toBeNull();
  });
});

describe('independent observation ordering review (synthetic transaction only)', () => {
  it.each([0, -1, -60000])('makes equal/older observation a write-free replay (%sms)', async delta => {
    const h = observationHarness(evidence(), NOW);
    await expect(persistFederalRegisterObservation(h.prisma as any, RULE, new Date(NOW.getTime() + delta), h.metadata))
      .resolves.toBe('stale');
    expect(h.tx.federalRegisterDocument.upsert).not.toHaveBeenCalled(); expect(h.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('locks identity before loading and writes evidence and canonical metadata in one transaction', async () => {
    const h = observationHarness(evidence(), NOW); const at = new Date(NOW.getTime() + 60000);
    await expect(persistFederalRegisterObservation(h.prisma as any, { ...RULE, effective_on: '2026-11-13' }, at, h.metadata))
      .resolves.toBe('updated');
    const calls = h.tx.$queryRaw.mock.calls;
    expect(calls[0][0].join('')).toContain('pg_advisory_xact_lock');
    expect(calls[0][1]).toBe(`fr-document:${RULE.document_number}`);
    expect(calls[1][0].join('')).toContain('FOR UPDATE');
    expect(h.tx.federalRegisterDocument.upsert.mock.calls[0][0].update.effectiveDate.toISOString())
      .toBe('2026-11-13T00:00:00.000Z');
    const persisted = JSON.parse(h.tx.$executeRaw.mock.calls[0][1]);
    expect(persisted).toMatchObject({ revision: 2, date: '2026-11-13', previous: { date: '2026-11-12' } });
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it.each([{ documentNumber: '2026-99999' }, { type: 'NOTICE' },
    { publicationDate: new Date('2026-10-11') }, { pdfUrl: RULE.pdf_url.replace('12345', '99999') }])('rejects metadata/source identity disagreement %p', async patch => {
    const h = observationHarness();
    await expect(persistFederalRegisterObservation(h.prisma as any, RULE, NOW, { ...h.metadata, ...patch }))
      .rejects.toThrow();
    expect(h.tx.federalRegisterDocument.upsert).not.toHaveBeenCalled(); expect(h.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('propagates failed evidence persistence instead of reporting successful observation', async () => {
    const h = observationHarness(); h.tx.$executeRaw.mockRejectedValue(new Error('synthetic write failure'));
    await expect(persistFederalRegisterObservation(h.prisma as any, RULE, NOW, h.metadata)).rejects.toThrow('synthetic write failure');
  });
});

describe('independent calendar authority and coverage review', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW)); afterEach(() => jest.useRealTimers());
  it('keeps fresh evidence and exposes date-kind/provenance plus deliberately incomplete coverage', async () => {
    const h = calendarHarness(); const value = await h.service.getEffectiveDateCalendar(RANGE);
    expect(value.data).toHaveLength(1);
    expect(value.data[0]).toMatchObject({ date: RULE.effective_on, dateKind: 'effective',
      provenance: { sourceField: 'effective_on', documentNumber: RULE.document_number, officialPdfUrl: RULE.pdf_url } });
    expect(value.coverage).toMatchObject({ complete: false, allFederalRules: false,
      parsedFullDatesSection: false, separatelyIssuedCorrectionsResolved: false, refreshRequired: true,
      catalogRules: 99, withoutEvidence: 7, unsupportedEvidence: 4 });
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
  });
  it('selects latest ingestion and refresh independently without a shared history cutoff', async () => {
    const h = calendarHarness();
    const ingestion = { source: 'sync-federal-register', status: 'running' };
    const refresh = { source: 'sync-federal-register-effective-dates', status: 'success_with_errors' };
    h.tx.syncRun.findFirst.mockResolvedValueOnce(ingestion).mockResolvedValueOnce(refresh);
    const value = await h.service.getEffectiveDateCalendar(RANGE);
    expect(value.coverage.latestIngestion).toBe(ingestion);
    expect(value.coverage.latestRefresh).toBe(refresh);
    expect(h.tx.syncRun.findFirst.mock.calls.map((call: any) => call[0].where.source))
      .toEqual(['sync-federal-register', 'sync-federal-register-effective-dates']);
    expect(h.tx.syncRun.findMany).not.toHaveBeenCalled();
  });
  it.each(['count', 'catalog'])('fails when the %s aggregate snapshot is unavailable', async missing => {
    const h = calendarHarness();
    h.tx.$queryRaw.mockReset().mockResolvedValueOnce(missing === 'count' ? [] : [{ total: 1n }])
      .mockResolvedValueOnce([calendarRow()]).mockResolvedValueOnce(missing === 'catalog' ? [] : [{ rules: 1n, withoutEvidence: 0n, notSupported: 0n }]);
    await expect(h.service.getEffectiveDateCalendar(RANGE)).rejects.toThrow('coverage snapshot is unavailable');
  });
  it('includes exact 48h evidence boundary and suppresses even one millisecond older or future evidence', async () => {
    const atBoundary = calendarRow(new Date(NOW.getTime() - EVIDENCE_MAX_AGE_MS));
    const older = calendarRow(new Date(NOW.getTime() - EVIDENCE_MAX_AGE_MS - 1));
    const future = calendarRow(new Date(NOW.getTime() + 1));
    const value = await calendarHarness([atBoundary, older, future]).service.getEffectiveDateCalendar(RANGE);
    expect(value.data).toHaveLength(1); expect(value.pagination.excludedOnPage).toBe(2);
  });
  it.each(['legacy', 'foreign', 'column_date', 'column_observed', 'invalid_hash', 'correction'])('suppresses %s authority', async mode => {
    const row: any = calendarRow();
    if (mode === 'legacy') row.evidence = null;
    if (mode === 'foreign') row.documentNumber = '2026-99999';
    if (mode === 'column_date') row.effectiveDate = new Date('2026-11-13');
    if (mode === 'column_observed') row.observedAt = new Date(NOW.getTime() - 1);
    if (mode === 'invalid_hash') row.evidence.evidenceHash = '0'.repeat(64);
    if (mode === 'correction') row.evidence = evidence({ correction_of: 'https://www.federalregister.gov/api/v1/documents/2026-12344.json' });
    const value = await calendarHarness([row]).service.getEffectiveDateCalendar(RANGE);
    expect(value.data).toEqual([]); expect(value.pagination.excludedOnPage).toBe(1);
  });
  it.each([{ dateFrom: '2026-02-30' }, { dateTo: '2026-10-31' }, { dateTo: '2028-01-01' },
    { page: 10001 }, { page: 1.2 }, { page: NaN }, { limit: 0 }, { limit: 101 }])('rejects range/page abuse %p before DB calls', async patch => {
      const h = calendarHarness();
      await expect(h.service.getEffectiveDateCalendar({ ...RANGE, ...patch })).rejects.toThrow(BadRequestException);
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });
  it('authorizes the actual handler through controller metadata and current RolesGuard', () => {
    const handler = FederalRegisterController.prototype.effectiveDateCalendar;
    expect(Reflect.getMetadata(GUARDS_METADATA, FederalRegisterController)).toContain(RolesGuard);
    expect(new Reflector().getAllAndOverride(ROLES_KEY, [handler, FederalRegisterController])).toEqual(['standard_user']);
    const guard = new RolesGuard(new Reflector());
    function ctx(role?: string): ExecutionContext {
      return { getHandler: () => handler, getClass: () => FederalRegisterController,
        switchToHttp: () => ({ getRequest: () => role ? { tenantContext: { role } } : {} }) } as unknown as ExecutionContext;
    }
    expect(() => guard.canActivate(ctx())).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx('not_a_role'))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx('standard_user'))).toBe(true);
    expect(guard.canActivate(ctx('capiro_admin'))).toBe(true);
  });
});

describe('independent durable coverage receipt review', () => {
  it('persists source-owned coverage stats with partial status instead of advancing success', async () => {
    const syncRun = { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'synthetic-run' }),
      update: jest.fn().mockResolvedValue({}) };
    const stats = { schemaVersion: 1, scope: 'publication_window', observedDocuments: 1, expectedDocuments: 2, allFederalRules: false };
    await runWithSyncRun({ syncRun }, 'sync-federal-register', async () => ({
      inserted: 0, updated: 1, skipped: 0, errors: 0, complete: false, stats,
    }));
    expect(syncRun.update.mock.calls[0][0]).toMatchObject({ where: { id: 'synthetic-run' }, data: { status: 'partial', stats } });
  });
});
