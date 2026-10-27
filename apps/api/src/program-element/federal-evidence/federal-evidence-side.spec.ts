import { federalEvidenceSide } from './federal-evidence-side.js';
import { FederalEvidenceReadService } from './federal-evidence-read.service.js';

const id = '00000000-0000-4000-8000-000000000001';
const next = '00000000-0000-4000-8000-000000000002';
const snapshot = {
  qualificationState: 'qualified',
  evidence: 'exact excerpt',
  locator: 'characters:2-8',
  languageHash: 'c'.repeat(64),
};
const revision = {
  id,
  sourceKey: 'source',
  contentHash: 'a'.repeat(64),
  extractionHash: 'b'.repeat(64),
  sourceUrl: 'https://example.invalid/exact.xml',
};

describe('federal lifecycle independent evidence sides', () => {
  it('returns an exact qualified historical side and its retained span', () => {
    expect(federalEvidenceSide(snapshot, revision, id, 'source')).toMatchObject({
      availability: 'available',
      revisionId: id,
      contentHash: revision.contentHash,
      textSpan: { start: 2, end: 8 },
      evidence: 'exact excerpt',
    });
  });
  it.each([
    ['missing side', null, revision, id],
    ['wrong revision', snapshot, revision, next],
    ['wrong source', snapshot, { ...revision, sourceKey: 'foreign' }, id],
    ['pending qualification', { ...snapshot, qualificationState: 'pending' }, revision, id],
    ['bad hash', snapshot, { ...revision, contentHash: 'invalid' }, id],
    ['unsafe URL', snapshot, { ...revision, sourceUrl: 'javascript:alert(1)' }, id],
  ])('withholds %s', (_label, stored, source, expected) => {
    expect(federalEvidenceSide(stored, source, expected, 'source')).toMatchObject({
      availability: 'unavailable',
      evidence: null,
      locator: null,
    });
  });
  it('does not borrow an available after side for an absent before side or expose internal join objects', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id,
        sourceKey: 'source',
        previousRevisionId: null,
        currentRevisionId: next,
        before: null,
        after: snapshot,
        beforeRevision: null,
        afterRevision: { ...revision, id: next },
        createdAt: new Date(),
      },
    ]);
    const result = await new FederalEvidenceReadService({
      $queryRawUnsafe: query,
    } as never).lifecycleTimeline({ peCode: '0600000A' });
    expect(result.items[0]?.beforeEvidence).toMatchObject({
      availability: 'unavailable',
      evidence: null,
    });
    expect(result.items[0]?.afterEvidence).toMatchObject({
      availability: 'available',
      revisionId: next,
    });
    expect(result.items[0]).not.toHaveProperty('afterRevision');
    expect(query.mock.calls[0]?.[0]).toContain('previous_revision.id = e.previous_revision_id');
    expect(query.mock.calls[0]?.[0]).toContain('current_revision.id = e.current_revision_id');
  });
});
