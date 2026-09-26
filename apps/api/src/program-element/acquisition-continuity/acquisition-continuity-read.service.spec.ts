import { BadRequestException } from '@nestjs/common';
import {
  AcquisitionContinuityReadService,
  type AcquisitionContinuityCoverage,
  type AcquisitionContinuityReadRepository,
  type AcquisitionContinuityRelationshipRow,
  type AcquisitionContinuityRepositoryPage,
  type AcquisitionContinuityRepositoryQuery,
} from './acquisition-continuity-read.service.js';

const coverage: AcquisitionContinuityCoverage = {
  state: 'complete',
  supportedRelationshipKinds: ['pe_to_program', 'notice_to_vehicle'],
  unsupportedRelationshipKinds: [],
  unresolvedReasons: [],
  sourceFreshness: [{ source: 'sam_gov', sourceAsOf: '2026-09-20', lastObservedAt: '2026-09-21T00:00:00Z', state: 'current' }],
};

function row(
  stableKey: string,
  status: AcquisitionContinuityRelationshipRow['status'] = 'accepted',
  financialFact: AcquisitionContinuityRelationshipRow['financialFact'] = {
    classification: 'reviewed_association',
    reviewState: 'verified',
    sourceAmountUsd: '125.00',
    actionEffect: 'ordinary',
    evidencePresent: true,
  },
): AcquisitionContinuityRelationshipRow {
  return {
    stableKey,
    relationshipId: `rel-${stableKey}`,
    relationshipKind: 'notice_to_vehicle',
    status,
    from: { entityType: 'notice', id: 'notice-1', sourceNativeId: 'SAM-1', label: 'Notice 1' },
    to: { entityType: 'vehicle', id: 'vehicle-1', sourceNativeId: 'PIID-1', label: 'Vehicle 1' },
    sourceNativeIds: { samNoticeId: 'SAM-1', piid: 'PIID-1', orderId: null },
    path: [
      { entityType: 'notice', id: 'notice-1', sourceNativeId: 'SAM-1', label: 'Notice 1' },
      { entityType: 'vehicle', id: 'vehicle-1', sourceNativeId: 'PIID-1', label: 'Vehicle 1' },
    ],
    parent: { entityType: 'vehicle', id: 'vehicle-1', sourceNativeId: 'PIID-1', label: 'Vehicle 1' },
    validity: { validFromFy: 2025, validToFy: null, knownFrom: '2025-01-01T00:00:00.000Z', knownTo: null },
    evidence: [{ kind: 'provider_identifier', sourceUrl: 'https://source.example/1', sourceNativeId: 'SAM-1', sourceVersion: 'v1', pageNumber: null, quote: null, contentHash: 'a'.repeat(64) }],
    unresolvedReasons: [],
    financialFact,
    authoritativeAmountUsd: 'should-not-be-trusted',
  };
}

function makeService(pages: AcquisitionContinuityRepositoryPage[]) {
  const calls: AcquisitionContinuityRepositoryQuery[] = [];
  const repository: AcquisitionContinuityReadRepository = {
    readPage: jest.fn(async (query) => {
      calls.push(query);
      return pages.shift()!;
    }),
  };
  return { service: new AcquisitionContinuityReadService(repository), repository, calls };
}

describe('AcquisitionContinuityReadService', () => {
  test('uses a stable opaque cursor across pages and rejects cursor reuse with different filters', async () => {
    const first = makeService([
      { rows: [row('b'), row('a'), row('c')], coverage },
      { rows: [row('d')], coverage },
    ]);
    const page1 = await first.service.read({ programId: ' prog-1 ', asOfFy: 2027, knownAt: '2026-09-24T12:00:00Z', limit: 2 });
    expect(page1.accepted.map((item) => item.stableKey)).toEqual(['a', 'b']);
    expect(page1.page.hasMore).toBe(true);
    expect(page1.page.nextCursor).toBeTruthy();

    const page2 = await first.service.read({
      programId: 'prog-1',
      asOfFy: 2027,
      limit: 2,
      cursor: page1.page.nextCursor!,
    });
    expect(first.calls[1]!.afterStableKey).toBe('b');
    expect(first.calls[1]!.knownAt.toISOString()).toBe('2026-09-24T12:00:00.000Z');
    expect(page2.accepted.map((item) => item.stableKey)).toEqual(['d']);
    await expect(first.service.read({ programId: 'prog-1', asOfFy: 2026, knownAt: '2026-09-24T12:00:00Z', limit: 2, cursor: page1.page.nextCursor! }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  test('pins an implicit knownAt into the cursor and reuses it when omitted on the next page', async () => {
    const { service, calls } = makeService([
      { rows: [row('a'), row('b')], coverage },
      { rows: [row('c')], coverage },
    ]);
    const first = await service.read({ programId: 'p1', asOfFy: 2027, limit: 1 });
    const second = await service.read({ programId: 'p1', asOfFy: 2027, limit: 1, cursor: first.page.nextCursor! });
    expect(second.knownAt).toBe(first.knownAt);
    expect(calls[1]!.knownAt.toISOString()).toBe(first.knownAt);
  });

  test('forwards the bitemporal selectors, one subject selector, status set, and no tenant identity', async () => {
    const { service, calls } = makeService([{ rows: [], coverage }]);
    const result = await service.read({ peCode: '0604802A', asOfFy: 2026, knownAt: '2026-09-24T10:11:12Z', status: 'candidate' });
    expect(calls[0]).toMatchObject({
      subject: { type: 'pe', id: '0604802A' },
      asOfFy: 2026,
      statuses: ['candidate'],
      afterStableKey: null,
      take: 51,
    });
    expect(calls[0]!.knownAt.toISOString()).toBe('2026-09-24T10:11:12.000Z');
    expect('tenantId' in calls[0]!).toBe(false);
    expect('tenantId' in result).toBe(false);
    expect(Object.keys(result)).not.toContain('tenantId');
  });

  test('returns accepted, candidate, and unresolved rows in separate buckets', async () => {
    const { service } = makeService([{
      rows: [row('a', 'candidate'), row('b', 'accepted'), row('c', 'unresolved')],
      coverage,
    }]);
    const result = await service.read({ procurementLineId: 'blin-123', asOfFy: 2027, knownAt: '2026-09-24T00:00:00Z' });
    expect(result.accepted.map((item) => item.stableKey)).toEqual(['b']);
    expect(result.candidates.map((item) => item.stableKey)).toEqual(['a']);
    expect(result.unresolved.map((item) => item.stableKey)).toEqual(['c']);
  });

  test('preserves partial coverage and unresolved reasons/freshness', async () => {
    const partial: AcquisitionContinuityCoverage = {
      ...coverage,
      state: 'partial',
      unsupportedRelationshipKinds: ['award_to_project'],
      unresolvedReasons: [{ code: 'ambiguous_program_split', count: 2, detail: 'Evidence spans multiple successor programs.' }],
      sourceFreshness: [{ source: 'usaspending', sourceAsOf: null, lastObservedAt: null, state: 'unknown' }],
    };
    const { service } = makeService([{ rows: [row('a', 'unresolved')], coverage: partial }]);
    const result = await service.read({ programId: 'p1', asOfFy: 2027, knownAt: '2026-09-24T00:00:00Z' });
    expect(result.coverage).toEqual(partial);
    expect(result.unresolved[0]!.status).toBe('unresolved');
  });

  test('unsupported allocation stays unallocated with a visible residual reason', async () => {
    const unsupported: AcquisitionContinuityCoverage = {
      ...coverage,
      state: 'unsupported',
      supportedRelationshipKinds: [],
      unsupportedRelationshipKinds: ['award_to_pe_allocation'],
      unresolvedReasons: [{ code: 'allocation_not_supported', count: 1, detail: 'No source-qualified allocation evidence.' }],
    };
    const sourceRow = row('a', 'unresolved', {
      classification: 'unresolved',
      reviewState: 'unreviewed',
      sourceAmountUsd: '7000000.00',
      actionEffect: 'unknown',
      evidencePresent: false,
    });
    const { service } = makeService([{ rows: [sourceRow], coverage: unsupported }]);
    const result = await service.read({ peCode: '0604802A', asOfFy: 2027, knownAt: '2026-09-24T00:00:00Z' });
    expect(result.coverage.state).toBe('unsupported');
    expect(result.coverage.unresolvedReasons[0]!.code).toBe('allocation_not_supported');
    expect(result.unresolved[0]!.authoritativeAmountUsd).toBeNull();
  });

  test.each([
    ['negative action', 'negative_action', 'negative'],
    ['corrected action', 'corrected_action', 'corrected'],
  ] as const)('%s cannot become an authoritative allocation', async (_label, classification, actionEffect) => {
    const { service } = makeService([{ rows: [row('a', 'accepted', {
      classification,
      reviewState: 'verified',
      sourceAmountUsd: '125.00',
      actionEffect,
      evidencePresent: true,
    })], coverage }]);
    const result = await service.read({ programId: 'p1', asOfFy: 2027, knownAt: '2026-09-24T00:00:00Z' });
    expect(result.accepted[0]!.authoritativeAmountUsd).toBeNull();
  });

  test('only verified explicit allocations with evidence and ordinary positive values expose dollars', async () => {
    const { service } = makeService([{ rows: [row('a', 'accepted', {
      classification: 'source_stated_financial_allocation',
      reviewState: 'verified',
      sourceAmountUsd: '125.00',
      actionEffect: 'ordinary',
      evidencePresent: true,
    })], coverage }]);
    const result = await service.read({ programId: 'p1', asOfFy: 2027, knownAt: '2026-09-24T00:00:00Z' });
    expect(result.accepted[0]!.authoritativeAmountUsd).toBe('125.00');
  });
});
