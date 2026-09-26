import { BadRequestException } from '@nestjs/common';
import { DefenseResearchService } from './defense-research.service.js';

function serviceWith(prisma: Record<string, unknown>) {
  return new DefenseResearchService(prisma as never);
}

describe('DefenseResearchService', () => {
  test('returns every dossier field and makes gaps explicit', async () => {
    const prisma = {
      programElement: {
        findUnique: jest.fn().mockResolvedValue({
          peCode: '0600000A', title: 'Test PE', description: 'Mission text',
          raw: { plans: 'Plan text' }, sources: [],
        }),
      },
    };
    const dossier = await serviceWith(prisma).dossier('program_element', '0600000A');
    expect(dossier.fields).toHaveLength(8);
    expect(dossier.fields.find((field) => field.field === 'mission')).toMatchObject({ availability: 'partial', value: 'Mission text' });
    expect(dossier.fields.find((field) => field.field === 'accomplishments')).toMatchObject({ availability: 'unavailable', value: null });
    expect(dossier.coverage).toEqual({ state: 'partial', expectedFields: 8, availableFields: 0, partialFields: 2, unavailableFields: 6 });
  });

  test('filters project milestones by the exact project identity and preserves time precision', async () => {
    const period = (id: string, projectCode: string, rawText: string) => ({
      id, metadata: { projectCode }, periodRole: 'planned', rawText,
      periodKind: 'fiscal_quarter', exactDate: null, rangeStart: null, rangeEnd: null,
      fiscalYear: 2028, fiscalQuarter: 2, calendarQuarter: null,
      sourceUrl: 'https://example.mil/r2a.pdf', pageNumber: 8, sourceDocumentId: 'doc-1',
      sourceDocument: { sha256: 'a'.repeat(64), title: 'FY28 R-2A', sourceKey: 'pb-fy28', ingestedAt: new Date('2027-03-01T00:00:00Z') },
      createdAt: new Date('2027-03-01T00:00:00Z'),
    });
    const prisma = {
      programElementProject: { findFirst: jest.fn().mockResolvedValue({ id: 'project-id', peCode: '0600000A', projectCode: 'AA1', title: 'Exact project' }) },
      programElement: { findUnique: jest.fn().mockResolvedValue({
        title: 'Parent PE',
        milestones: [
          { id: 'keep', milestoneType: 'Development complete', status: 'planned', notes: null, lastSyncedAt: new Date('2027-03-01T00:00:00Z'), schedulePeriods: [period('p1', 'AA1', '2Q FY2028')] },
          { id: 'drop', milestoneType: 'Testing', status: 'planned', notes: null, lastSyncedAt: new Date('2027-03-01T00:00:00Z'), schedulePeriods: [period('p2', 'BB2', '3Q FY2028')] },
        ],
      }) },
    };
    const result = await serviceWith(prisma).milestones('project', '0600000A:AA1');
    expect(result.subject).toEqual({ type: 'project', id: 'project-id', label: 'Exact project' });
    expect(result.milestones).toHaveLength(1);
    expect(result.milestones[0]?.periods[0]).toMatchObject({ rawText: '2Q FY2028', precision: 'fiscal_quarter', fiscalYear: 2028, quarter: 2 });
  });

  test('distinguishes an observed zero from a missing funding cell', async () => {
    const source = {
      id: 'src-1', sourceDocumentId: 'doc-1', sourceUrl: 'https://example.mil/p40.pdf', pageNumber: 4,
      sourceDocument: { sha256: 'b'.repeat(64), title: 'P-40', sourceKey: 'pb-fy28', ingestedAt: new Date('2027-03-01T00:00:00Z') },
    };
    const prisma = {
      procurementLine: { findUnique: jest.fn()
        .mockResolvedValueOnce({ title: 'Procurement line' })
        .mockResolvedValueOnce({ id: 'line-1', years: [{ id: 'year-1', fy: 2028, request: { toString: () => '0' }, hascMark: null, sascMark: null, hacDMark: null, sacDMark: null, conference: null, enacted: null, actuals: null, sources: [source] }] }) },
    };
    const matrix = await serviceWith(prisma).fundingMatrix('budget_line', 'line-1');
    expect(matrix.cells.find((cell) => cell.basis.stage === 'request')).toMatchObject({ value: '0', disposition: 'observed' });
    expect(matrix.cells.find((cell) => cell.basis.stage === 'hascMark')).toMatchObject({ value: null, disposition: 'missing' });
    expect(matrix.supported).toMatchObject({ fiscalYears: [2028], editions: ['pb-fy28'], knownAt: false });
    await expect(serviceWith(prisma).fundingMatrix('budget_line', 'line-1', '2026-01-01')).rejects.toBeInstanceOf(BadRequestException);
  });

  test('applies publisher and status filters to live transcript and hearing adapters', async () => {
    const prisma = {
      defenseContextDocument: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      officialHearingTranscript: { findMany: jest.fn().mockResolvedValue([{ id: 'T1', hearingId: 'H1', title: 'Official transcript', congress: 119, committeeName: 'HASC', publishedAt: null, date: new Date('2026-09-01T00:00:00Z'), sourceUrl: 'https://govinfo.gov/t1' }]), count: jest.fn().mockResolvedValue(1) },
      committeeHearing: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      federalRegisterDocument: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const result = await serviceWith(prisma).listContextDocuments({ publisher: 'govinfo', status: 'published' });
    expect(result.items.map((item) => item.id)).toEqual(['transcript:T1']);
    expect(result.denominator).toEqual({ eligible: 1, observed: 1, qualified: 1, available: 1, partial: 0, unavailable: 0 });
  });

  test('reports real denominators independently from the returned page limit', async () => {
    const row = { id: 'doc-1', family: 'policy_manual', publisher: 'DoD', title: 'Policy', congress: null, committee: null, publishedAt: new Date('2026-01-01T00:00:00Z'), status: 'published', currentRevisionId: null, transcriptAvailability: 'not_applicable', coverage: 'available', sourceUrl: null };
    const count = jest.fn(async ({ where }: any) => {
      if (where.coverage === 'available') return 1;
      if (where.coverage === 'partial') return 1;
      if (where.coverage === 'unavailable') return 1;
      if (where.eligible === true) return 2;
      if (where.qualification === 'qualified') return 2;
      return 3;
    });
    const prisma = { defenseContextDocument: { findMany: jest.fn().mockResolvedValue([row]), count } };
    const result = await serviceWith(prisma).listContextDocuments({ family: 'policy_manual', limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.denominator).toEqual({ eligible: 2, observed: 3, qualified: 2, available: 1, partial: 1, unavailable: 1 });
  });

  test('adapts an official policy family with partial coverage and exact CFR occurrences', async () => {
    const rule = {
      documentNumber: '2026-12345', type: 'RULE', title: 'Defense acquisition rule', abstract: 'This final rule updates acquisition requirements.',
      agencyNames: ['Department of Defense'], publicationDate: new Date('2026-08-20T00:00:00Z'),
      cfrReferences: ['48 CFR 225.872'], htmlUrl: 'https://federalregister.gov/d/2026-12345', pdfUrl: null,
      syncedAt: new Date('2026-08-21T00:00:00Z'),
    };
    const prisma = {
      federalRegisterDocument: { findUnique: jest.fn().mockResolvedValue(rule) },
    };
    const service = serviceWith(prisma);
    const detail = await service.contextDocument('federal-register:2026-12345');
    const refs = await service.references('federal-register:2026-12345');
    expect(detail).toMatchObject({ family: 'federal_register_rule', publisher: 'Department of Defense', coverage: 'partial', transcriptAvailability: 'not_applicable' });
    expect(detail.sections[0]).toMatchObject({ nativeLocator: '2026-12345', textAvailability: 'partial' });
    expect(refs[0]).toMatchObject({ exactSpan: '48 CFR 225.872', originalWording: '48 CFR 225.872', referenceType: 'cfr_reference', disposition: 'unresolved' });
    expect(refs[0]?.evidenceRef).toMatchObject({ sourceRevisionId: 'federal-register:2026-12345:v1', nativeLocator: { section: '2026-12345' } });
  });

  test('represents a hearing without a qualified transcript as an honest unavailable case', async () => {
    const prisma = { committeeHearing: { findUnique: jest.fn().mockResolvedValue({
      id: 'H2', title: 'Hearing without transcript', congress: 119, committeeName: 'SASC',
      date: new Date('2026-09-02T00:00:00Z'), eventStatus: 'completed', url: 'https://armed-services.senate.gov/h2',
    }) } };
    const detail = await serviceWith(prisma).contextDocument('hearing:H2');
    expect(detail).toMatchObject({ coverage: 'unavailable', transcriptAvailability: 'unavailable', currentRevisionId: null, coverageReason: expect.stringContaining('No qualified official transcript') });
    expect(detail.revisions).toEqual([]);
    expect(detail.sections).toEqual([]);
  });

  test('filters the office directory through accepted program and capability relationships', async () => {
    const prisma = {
      programOffice: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([{
          id: 'office-1', name: 'PEO Ground Combat Systems', officeType: 'peo', service: 'ARMY',
          parentOfficeId: null, parentOffice: null, status: 'active', validFrom: null, validTo: null,
          sourceUrl: 'https://army.mil/peo-gcs', metadata: { acronym: 'PEO GCS', aliases: ['GCS'] },
          createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z'),
        }]),
      },
    };
    const result = await serviceWith(prisma).listOffices({ component: 'ARMY', program: 'Abrams', capability: 'ground combat', q: 'PEO GCS' });
    expect(result.items[0]).toMatchObject({ name: 'PEO Ground Combat Systems', aliases: ['GCS'], availability: 'available' });
    const where = (prisma.programOffice.findMany.mock.calls[0]?.[0] as any).where;
    expect(JSON.stringify(where)).toContain('Abrams');
    expect(JSON.stringify(where)).toContain('ground combat');
    expect(JSON.stringify(where)).toContain('PEO GCS');
  });

  test('composes approved temporal office relationships without inventing financial allocation', async () => {
    const at = new Date('2026-08-01T00:00:00Z');
    const prisma = {
      programOffice: { findMany: jest.fn().mockResolvedValue([{
        id: 'office-1', name: 'PEO GCS', service: 'ARMY', status: 'active', validTo: null,
        sourceUrl: 'https://army.mil/peo-gcs', updatedAt: at, parentOffice: null,
        programLinks: [{
          id: 'link-1', relation: 'manages', reviewStatus: 'accepted', sourceUrl: 'https://army.mil/abrams',
          evidence: [], derivedBy: null, updatedAt: at,
          program: { id: 'program-1', canonicalName: 'Abrams', component: 'ARMY', acquisitionPathway: 'MDAP' },
        }],
        roles: [{
          id: 'role-1', roleType: 'pm', reviewStatus: 'accepted', source: 'official_directory',
          sourceUrl: 'https://army.mil/leader', observedAt: at, effectiveEnd: null,
          person: { id: 'person-1', fullName: 'Program Manager' }, program: null,
        }],
      }]) },
    };
    const result = await serviceWith(prisma).getRelationships({});
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'manages', sourceStated: true, inferred: false, reviewStatus: 'accepted' }),
      expect.objectContaining({ relation: 'holds_role', from: expect.objectContaining({ id: 'person-1' }) }),
      expect.objectContaining({ relation: 'acquisition_path', supersessionImpact: expect.stringContaining('no allocation') }),
    ]));
    expect(result.items.some((edge) => edge.relation === 'allocates')).toBe(false);
  });

  test('keeps speculative office links disabled unless explicitly requested', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = serviceWith({ programOffice: { findMany } });
    await service.getRelationships({});
    expect(findMany.mock.calls[0]?.[0]?.include.programLinks.where.reviewStatus.in).toEqual(['accepted']);
    await service.getRelationships({ includeSpeculative: true });
    expect(findMany.mock.calls[1]?.[0]?.include.programLinks.where.reviewStatus.in).toEqual(['accepted', 'candidate']);
  });

  test('lists only the newest acquisition revision for each source-qualified identity', async () => {
    const recordedAt = new Date('2026-09-01T00:00:00Z');
    const prisma = {
      acquisitionRecordRevision: {
        groupBy: jest.fn()
          .mockResolvedValueOnce([{ identityKey: 'sam.gov:notice:N1' }])
          .mockResolvedValueOnce([{ identityKey: 'sam.gov:notice:N1:A1' }]),
        findMany: jest.fn().mockResolvedValue([{
          id: 'revision-new', identityKey: 'sam.gov:notice:N1', sourceSystem: 'sam.gov', sourceRecordId: 'N1',
          recordKind: 'notice', parentIdentityKey: null, title: 'Sources sought', status: 'active', buyerOffice: 'ACC',
          postedAt: recordedAt, responseDeadline: new Date('2026-10-01T00:00:00Z'), validFrom: null, validTo: null,
          contentHash: 'a'.repeat(64), sourceUrl: 'https://sam.gov/opp/N1', sourceVersion: '2',
          sourceObservedAt: recordedAt, recordedAt, raw: { description: 'Exact source text' },
        }]),
      },
      acquisitionCoverageGap: { count: jest.fn().mockResolvedValue(2) },
    };
    const result = await serviceWith(prisma).getAcquisitionRecords({ recordKind: 'notice', q: 'N1' });
    expect(prisma.acquisitionRecordRevision.findMany).toHaveBeenCalledWith(expect.objectContaining({
      distinct: ['identityKey'],
      orderBy: [{ identityKey: 'asc' }, { recordedAt: 'desc' }, { id: 'desc' }],
    }));
    expect(result).toMatchObject({ total: 1, items: [{ identityKey: 'sam.gov:notice:N1', recordKind: 'notice', amendmentCount: 1, openCoverageGaps: 2, textAvailability: 'partial' }] });
  });

  test('returns revisioned acquisition detail while gating candidates and financial attribution', async () => {
    const at = new Date('2026-09-01T00:00:00Z');
    const revision = {
      id: 'rev-2', identityKey: 'usaspending:award:A1', sourceSystem: 'usaspending', sourceRecordId: 'A1',
      recordKind: 'award', parentIdentityKey: null, title: 'Vehicle award', status: 'active', buyerOffice: 'Army',
      postedAt: at, responseDeadline: null, validFrom: null, validTo: null, contentHash: 'b'.repeat(64),
      sourceUrl: 'https://usaspending.gov/award/A1', sourceVersion: '2', sourceObservedAt: at, recordedAt: at,
      raw: { placeOfPerformance: { state: 'VA' }, naicsCode: '541512', pscCode: 'D302' },
    };
    const findMany = jest.fn()
      .mockResolvedValueOnce([revision])
      .mockResolvedValueOnce([{ identityKey: 'usaspending:order:O1' }, { identityKey: 'usaspending:amendment:M1' }])
      .mockResolvedValueOnce([{ identityKey: 'usaspending:amendment:M1' }])
      .mockResolvedValueOnce([revision])
      .mockResolvedValueOnce([{ identityKey: 'usaspending:order:O1' }, { identityKey: 'usaspending:amendment:M1' }])
      .mockResolvedValueOnce([{ identityKey: 'usaspending:amendment:M1' }]);
    const relationshipFindMany = jest.fn().mockResolvedValue([
      { id: 'r1', logicalKey: 'l1', relationshipClass: 'reviewed_association', subjectKind: 'program', subjectKey: 'p1', validFromFy: 2026, validToFy: null, allocatedAmountUsd: { toString: () => '900.00' }, sourceUrl: 'https://source', sourceObservedAt: at, reviewStatus: 'accepted' },
      { id: 'r2', logicalKey: 'l2', relationshipClass: 'source_stated_financial_allocation', subjectKind: 'program', subjectKey: 'p1', validFromFy: 2026, validToFy: null, allocatedAmountUsd: { toString: () => '125.50' }, sourceUrl: 'https://source', sourceObservedAt: at, reviewStatus: 'accepted' },
    ]);
    const service = serviceWith({
      acquisitionRecordRevision: { findMany },
      programAcquisitionRelationship: { findMany: relationshipFindMany },
      acquisitionCoverageGap: { count: jest.fn().mockResolvedValue(0) },
    });
    const detail = await service.getAcquisitionRecord('usaspending:award:A1');
    expect(relationshipFindMany.mock.calls[0]?.[0]?.where.reviewStatus).toBe('accepted');
    expect(detail.extractedFields).toEqual({ geography: ['VA'], naics: ['541512'], psc: ['D302'] });
    expect(detail.associations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationshipClass: 'reviewed_association', allocatedAmountUsd: null }),
      expect.objectContaining({ relationshipClass: 'source_stated_financial_allocation', allocatedAmountUsd: '125.50' }),
    ]));
    await service.getAcquisitionRecord('usaspending:award:A1', true);
    expect(relationshipFindMany.mock.calls[1]?.[0]?.where.reviewStatus).toEqual({ in: ['accepted', 'candidate'] });
  });

  test('keeps corrected award actions distinct and preserves signed deltas', async () => {
    const at = new Date('2026-09-03T00:00:00Z');
    const findMany = jest.fn().mockResolvedValue([{
      id: 'action-rev-2', transactionIdentityKey: 'fpds:transaction:T1', awardIdentityKey: 'fpds:award:A1',
      parentAwardIdentityKey: 'fpds:vehicle:V1', sourceSystem: 'fpds', sourceTransactionId: 'T1', piid: 'A1',
      modificationNumber: 'P00002', actionDate: at, signedObligationDelta: { toString: () => '-42.50' },
      signedOutlayDelta: null, correctsIdentityKey: 'fpds:transaction:T1:old', supersedesId: 'action-rev-1',
      sourceUrl: 'https://fpds.gov/T1', sourceObservedAt: at, recordedAt: at, raw: {},
    }]);
    const result = await serviceWith({ acquisitionAwardTransactionRevision: { findMany } }).getAcquisitionActions('fpds:award:A1');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ distinct: ['transactionIdentityKey'] }));
    expect(result[0]).toMatchObject({ modificationNumber: 'P00002', signedObligationDelta: '-42.50', correctsIdentityKey: 'fpds:transaction:T1:old' });
  });

  test('returns open acquisition coverage gaps as gaps rather than fabricated zeros', async () => {
    const at = new Date('2026-09-04T00:00:00Z');
    const findMany = jest.fn().mockResolvedValue([{
      id: 'gap-1', subjectKind: 'program', subjectKey: 'program-1', sourceSystem: 'fpds', relationshipKind: 'award',
      reason: 'delayed_source', detail: 'Provider is 48 hours behind.', coverageState: 'partial', sourceAsOf: at,
      firstObservedAt: at, lastObservedAt: at, resolvedAt: null,
    }]);
    const result = await serviceWith({ acquisitionCoverageGap: { findMany } }).getAcquisitionCoverage('program', 'program-1');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { subjectKind: 'program', subjectKey: 'program-1', resolvedAt: null } }));
    expect(result).toMatchObject({ total: 1, items: [{ reason: 'delayed_source', coverageState: 'partial' }] });
    expect(JSON.stringify(result)).not.toContain('allocatedAmountUsd');
  });
});
