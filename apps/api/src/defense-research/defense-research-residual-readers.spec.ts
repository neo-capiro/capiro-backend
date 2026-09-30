import { DefenseResearchService } from './defense-research.service.js';

const at = new Date('2026-09-01T00:00:00Z');
// Controlled persisted receipt metadata only; no real object-store/archive qualification is claimed.
const archivedProjectDocument = { id: 'doc', sha256: 'b'.repeat(64), sourceKey: 'fixture',
  supersededByDocumentId: null, pageCount: 20, archiveBucket: 'owned-synthetic-bucket',
  archiveS3Key: 'owned/synthetic/source.pdf', archiveVersionId: 'owned-synthetic-immutable-version', archivedAt: at, retainUntil: new Date('2100-01-01T00:00:00Z') };
const serviceWith = (prisma: Record<string, unknown>) => new DefenseResearchService(prisma as never);
function revision(id: string, identityKey: string, status: string, recordedAt = at) {
  return { id, identityKey, status, recordedAt, sourceSystem: 'synthetic', sourceRecordId: identityKey,
    recordKind: 'notice', parentIdentityKey: null, title: status + ' title', buyerOffice: status + ' office',
    validFrom: null as Date | null, validTo: null as Date | null, raw: {}, contentHash: 'a'.repeat(64), sourceUrl: null, sourceVersion: null };
}
function revisionRepository(rows: ReturnType<typeof revision>[]) {
  const matching = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'AND') return value.every((clause: any) => matching(row, clause));
    if (key === 'OR') return value.some((clause: any) => matching(row, clause));
    if (value === null) return row[key] == null;
    if (typeof value !== 'object') return row[key] === value;
    if (value.in) return value.in.includes(row[key]);
    if (value.contains) return String(row[key]).toLowerCase().includes(String(value.contains).toLowerCase());
    if (value.equals) return String(row[key]).toLowerCase() === String(value.equals).toLowerCase();
    if (value.lte) return row[key] <= value.lte;
    if (value.gte) return row[key] >= value.gte;
    throw new Error('Unsupported bounded fixture predicate ' + key);
  });
  const select = (query: any) => {
    let selected = rows.filter(row => matching(row, query.where));
    const orders = Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy ?? {}];
    selected.sort((a: any, b: any) => {
      for (const order of orders) for (const [key, direction] of Object.entries(order)) {
        const left = a[key] instanceof Date ? a[key].getTime() : a[key];
        const right = b[key] instanceof Date ? b[key].getTime() : b[key];
        if (left !== right) return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      }
      return 0;
    });
    if (query.distinct) selected = selected.filter((row: any, index: number) => selected.findIndex((other: any) => query.distinct.every((key: string) => other[key] === row[key])) === index);
    selected = selected.slice(query.skip ?? 0, query.take == null ? undefined : (query.skip ?? 0) + query.take);
    return query.select ? selected.map((row: any) => Object.fromEntries(Object.keys(query.select).map(key => [key, row[key]]))) : selected;
  };
  return { findMany: jest.fn(async (query: any) => select(query)), groupBy: jest.fn(async (query: any) => [...new Set(rows.filter(row => matching(row, query.where)).map(row => row.identityKey))].map(identityKey => ({ identityKey }))) };
}
function slot(index: number, account: string, edition = 'PB FY2028', detail = 'BA1') {
  return { id: `slot-${index}`, fiscalYear: 2028, authorityTrack: 'appropriations', component: 'ARMY',
    sourceFamily: 'pb_r2', stage: 'request', optional: false, metadata: { account, edition }, observations: [],
    bundleMembers: [{ memberKey: detail, budgetActivity: detail, volume: null, memberStatus: 'missing', sourceDocumentId: null }] };
}
function catalogRepository(slots: ReturnType<typeof slot>[]) {
  return { findMany: jest.fn(async (query: any) => slots.filter(row => {
    if (query.where.AND && !query.where.AND.every((clause: any) => Object.entries(clause).every(([key, value]: [string, any]) => key === 'metadata' && (row.metadata as any)[value.path[0]] === value.equals))) return false;
    if (query.where.bundleMembers && !row.bundleMembers.some((member: any) => query.where.bundleMembers.some.OR.some((clause: any) => Object.entries(clause).every(([key, value]) => member[key] === value)))) return false;
    return true;
  }).slice(0, query.take)) };
}

describe('DefenseResearchService residual narrative, current acquisition and cohort boundaries', () => {
  test('retains narrative values and partial refs without calling them field-qualified', async () => {
    const result = await serviceWith({ programElement: { findUnique: async () => ({ title: 'Synthetic PE', description: 'Mission', raw: { plans: 'Plans' }, sources: [{ id: 'source', docType: 'R', publisher: null, sourceUrl: 'https://example.invalid/source', pageNumber: null, sourceDocumentId: null, observedAt: at }] }) } }).dossier('program_element', '0600000A');
    for (const field of result.fields.filter(row => row.value)) expect(field).toMatchObject({ availability: 'partial', evidence: [{ availability: 'partial' }] });
    expect(result.fields.find(row => row.field === 'plans')?.value).toBe('Plans');
    expect(result.coverage.availableFields).toBe(0);
  });
  test('an exact subject citation cannot qualify unrelated canonical raw fields', async () => {
    const result = await serviceWith({ programElement: { findUnique: async () => ({ title: 'Synthetic PE', raw: { plans: 'Unbound plans' }, sources: [{ id: 'source', docType: 'R', publisher: null, sourceUrl: 'https://example.invalid/source', pageNumber: 7, sourceDocumentId: 'doc', sourceDocument: { sha256: 'a'.repeat(64), sourceKey: 'fixture' }, observedAt: at }] }) } }).dossier('program_element', '0600000A');
    expect(result.fields.find(row => row.field === 'plans')).toMatchObject({ availability: 'partial', value: 'Unbound plans', evidence: [{ availability: 'available' }] });
  });
  test('only direct project mission lineage with archived bytes and positive locator is available', async () => {
    const result = await serviceWith({ programElementProject: { findFirst: async () => ({ id: 'project', title: 'Project', mission: 'Project mission', metadata: { plans: 'Unbound plan' }, sourceUrl: 'https://example.invalid/exhibit', pageNumber: 7, sourceDocumentId: 'doc', sourceDocument: archivedProjectDocument, confidence: 0.95, lastSyncedAt: at }) } }).dossier('project', 'project');
    expect(result.fields.find(row => row.field === 'mission')?.availability).toBe('available');
    expect(result.fields.find(row => row.field === 'plans')?.availability).toBe('partial');
  });
  test('project source with nonpositive locator remains partial', async () => {
    const result = await serviceWith({ programElementProject: { findFirst: async () => ({ id: 'project', title: 'Project', mission: 'Useful mission', metadata: {}, sourceUrl: 'https://example.invalid/exhibit', pageNumber: -1, sourceDocumentId: 'doc', sourceDocument: archivedProjectDocument, confidence: 0.95, lastSyncedAt: at }) } }).dossier('project', 'project');
    expect(result.fields.find(row => row.field === 'mission')).toMatchObject({ availability: 'partial', value: 'Useful mission' });
  });
  test('project mission keeps contextual text partial without a current valid immutable archive receipt', async () => {
    const project = { id: 'project', title: 'Project', mission: 'Retained mission', metadata: {},
      sourceUrl: 'https://example.invalid/exhibit', pageNumber: 7, sourceDocumentId: 'doc', confidence: 0.95, lastSyncedAt: at };
    const cases = [
      { sourceDocument: { ...archivedProjectDocument, archiveBucket: null } },
      { sourceDocument: { ...archivedProjectDocument, archiveS3Key: '' } },
      { sourceDocument: { ...archivedProjectDocument, archiveVersionId: 'null' } },
      { sourceDocument: { ...archivedProjectDocument, archivedAt: null } },
      { sourceDocument: { ...archivedProjectDocument, supersededByDocumentId: 'new-head' } },
      { sourceDocument: { ...archivedProjectDocument, id: 'different-doc' } },
      { sourceDocument: { ...archivedProjectDocument, sha256: 'not-a-sha' } },
      { sourceDocument: archivedProjectDocument, confidence: 0.5 },
      { sourceDocument: archivedProjectDocument, pageNumber: 21 },
    ];
    for (const variant of cases) {
      const result = await serviceWith({ programElementProject: { findFirst: async () => ({ ...project, ...variant }) } }).dossier('project', 'project');
      expect(result.fields.find(row => row.field === 'mission')).toMatchObject({ availability: 'partial', value: 'Retained mission' });
    }
  });
  test.each([
    { label: 'future archive receipt', document: { ...archivedProjectDocument, archivedAt: new Date('2100-01-01T00:00:00Z') } },
    { label: 'expired retention', document: { ...archivedProjectDocument, retainUntil: new Date('2020-01-01T00:00:00Z') } },
    { label: 'nonfinite retention', document: { ...archivedProjectDocument, retainUntil: new Date('invalid-date') } },
    { label: 'non-Date retention', document: { ...archivedProjectDocument, retainUntil: '2100-01-01T00:00:00Z' } },
  ])('$label cannot qualify already archived project mission proof', async ({ document }) => {
    const result = await serviceWith({ programElementProject: { findFirst: async () => ({ id: 'project', title: 'Project', mission: 'Retained mission', metadata: {}, sourceUrl: 'https://example.invalid/exhibit', pageNumber: 7, sourceDocumentId: 'doc', sourceDocument: document, confidence: 0.95, lastSyncedAt: at }) } }).dossier('project', 'project');
    expect(result.fields.find(row => row.field === 'mission')).toMatchObject({ availability: 'partial', value: 'Retained mission' });
  });
  test('status filter never resurrects an older acquisition revision', async () => {
    const repository = revisionRepository([revision('old', 'A', 'open', new Date('2026-08-01')), revision('new', 'A', 'closed')]);
    const result = await serviceWith({ acquisitionRecordRevision: repository, acquisitionCoverageGap: { count: async () => 0 } }).getAcquisitionRecords({ status: 'open' });
    expect(result.items).toEqual([]); expect(result.total).toBe(0);
  });
  test('latest title and buyer filters are applied before pagination and total', async () => {
    const repository = revisionRepository([revision('old', 'A', 'open', new Date('2026-08-01')), revision('new', 'A', 'closed'), revision('B', 'B', 'open'), revision('C', 'C', 'open')]);
    const result = await serviceWith({ acquisitionRecordRevision: repository, acquisitionCoverageGap: { count: async () => 0 } }).getAcquisitionRecords({ q: 'open', buyerOffice: 'open', page: 2, limit: 1 });
    expect(result.total).toBe(2); expect(result.items.map(row => row.identityKey)).toEqual(['C']);
    expect(repository.findMany.mock.calls[0]![0]).toMatchObject({ select: { id: true }, distinct: ['identityKey'] });
  });
  test('activeOn cannot select an older currently-valid revision after a future-dated replacement', async () => {
    const old = { ...revision('old', 'A', 'open', new Date('2026-08-01')), validFrom: new Date('2026-01-01'), validTo: null };
    const current = { ...revision('new', 'A', 'open'), validFrom: new Date('2027-01-01'), validTo: null };
    const result = await serviceWith({ acquisitionRecordRevision: revisionRepository([old, current]), acquisitionCoverageGap: { count: async () => 0 } }).getAcquisitionRecords({ activeOn: '2026-09-28' });
    expect(result.items).toEqual([]); expect(result.total).toBe(0);
  });
  test('latest ties use the same deterministic revision in list and detail', async () => {
    const repository = revisionRepository([revision('a', 'A', 'open'), revision('z', 'A', 'closed')]);
    const service = serviceWith({ acquisitionRecordRevision: repository, acquisitionCoverageGap: { count: async () => 0 }, programAcquisitionRelationship: { findMany: async () => [] } });
    expect((await service.getAcquisitionRecords({})).items[0]?.status).toBe('closed');
    expect((await service.getAcquisitionRecord('A')).status).toBe('closed');
  });
  test('coverage cohort predicates find matching account/edition/detail beyond original 500 slots', async () => {
    const repository = catalogRepository([...Array.from({ length: 500 }, (_, i) => slot(i, 'OTHER')), slot(500, 'TARGET')]);
    const result = await serviceWith({ defenseBudgetExpectedSource: repository }).productCoverage({ account: 'TARGET', edition: 'PB FY2028', detail: 'BA1' });
    expect(result.rows).toHaveLength(1); expect(result.rows[0]?.account).toBe('TARGET');
    expect(repository.findMany.mock.calls[0]![0].where).toMatchObject({ AND: [{ metadata: { path: ['account'], equals: 'TARGET' } }, { metadata: { path: ['edition'], equals: 'PB FY2028' } }], bundleMembers: { some: { OR: [{ budgetActivity: 'BA1' }, { volume: 'BA1' }, { memberKey: 'BA1' }] } } });
    expect(result.denominatorKnown).toBe(false);
  });
  test('more than 500 matching coverage slots is explicitly truncated, never complete', async () => {
    const result = await serviceWith({ defenseBudgetExpectedSource: catalogRepository(Array.from({ length: 501 }, (_, i) => slot(i, 'TARGET'))) }).productCoverage({ account: 'TARGET' });
    expect(result.rows).toHaveLength(500); expect(result.limitations.join(' ')).toContain('additional matching slots are omitted');
    expect(result.rows.every(row => row.outcome === 'unknown')).toBe(true); expect(result.denominatorKnown).toBe(false);
  });
});
