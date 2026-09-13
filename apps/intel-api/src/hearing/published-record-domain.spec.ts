import {
  assessRecordClaim,
  validateRecordClaims,
  sourcePassage,
  type RecordClaim,
  type PublishedRecord,
} from './published-record-domain.js';
const record: PublishedRecord = {
  id: 'r1',
  billId: 'fl-2026-hb1',
  kind: 'vote',
  hash: 'a'.repeat(64),
  identity: 'vote-1',
  date: '2026-03-01',
  observedAt: '2026-03-02T12:00:00Z',
  association: 'explicit_event',
  evidence: {
    chamber: 'H',
    motion: 'Favorable recommendation',
    yeas: 7,
    nays: 2,
    passed: true,
    members: [{ providerPersonId: 1, voteCast: 'Yea' }],
  },
};
const claim: RecordClaim = {
  id: 'c1',
  text: 'The committee vote recorded seven yeas.',
  kind: 'fact',
  scope: 'hearing_event',
  billId: record.billId,
  references: [{ id: record.id, hash: record.hash, locator: 'record' }],
  proposition: {
    field: 'yeas',
    expected: 7,
    body: 'H',
    motion: 'Favorable recommendation',
    date: '2026-03-01',
  },
};
describe('published-record labeled qualification corpus', () => {
  it('supports an exact tally and requires review of an incompatible tally', () => {
    expect(assessRecordClaim(claim, [record], 'available')).toMatchObject({
      outcome: 'supported',
      requiresReview: false,
    });
    expect(
      assessRecordClaim(
        { ...claim, proposition: { ...claim.proposition!, expected: 9 } },
        [record],
        'available',
      ),
    ).toMatchObject({ outcome: 'contradicted', requiresReview: true });
  });
  it.each(['pending', 'failed', 'available'])(
    'missing evidence is never a contradiction (%s)',
    (availability) =>
      expect(assessRecordClaim({ ...claim, references: [] }, [], availability).outcome).not.toBe(
        'contradicted',
      ),
  );
  it('keeps a same-day agenda bill and a different motion unresolved', () => {
    expect(
      assessRecordClaim(claim, [{ ...record, association: 'bill_context_only' }], 'available')
        .outcome,
    ).toBe('needs_review');
    expect(
      assessRecordClaim(
        claim,
        [{ ...record, evidence: { ...record.evidence, motion: 'Final passage' } }],
        'available',
      ).outcome,
    ).toBe('needs_review');
  });
  it('requires conflict review rather than choosing the last source', () => {
    const other = {
      ...record,
      id: 'r2',
      hash: 'b'.repeat(64),
      evidence: { ...record.evidence, yeas: 9 },
    };
    expect(
      assessRecordClaim(
        {
          ...claim,
          references: [...claim.references, { id: other.id, hash: other.hash, locator: 'record' }],
        },
        [record, other],
        'available',
      ).outcome,
    ).toBe('needs_review');
  });
  it('distinguishes analysis and missing disposition from legislative outcomes', () => {
    expect(
      assessRecordClaim({ ...claim, kind: 'analysis', references: [] }, [], 'failed').outcome,
    ).toBe('capiro_analysis');
    expect(
      assessRecordClaim(
        { ...claim, proposition: { ...claim.proposition!, field: 'adopted', expected: false } },
        [{ ...record, evidence: { ...record.evidence, adopted: null } }],
        'available',
      ).outcome,
    ).toBe('needs_review');
    expect(
      assessRecordClaim(
        { ...claim, proposition: { ...claim.proposition!, field: 'adopted', expected: true } },
        [
          {
            ...record,
            kind: 'amendment',
            evidence: { ...record.evidence, adopted: false, disposition: 'not_marked_adopted' },
          },
        ],
        'available',
      ).outcome,
    ).toBe('needs_review');
  });
  it('rejects wrong bill, changed hash, unknown member and altered quotations', () => {
    for (const invalid of [
      { ...claim, billId: 'fl-2025-hb1' },
      { ...claim, references: [{ ...claim.references[0]!, hash: 'b' }] },
      { ...claim, references: [{ ...claim.references[0]!, locator: 'member:999' }] },
      { ...claim, kind: 'quote' as const, text: 'The bill was enacted.' },
    ])
      expect(() => validateRecordClaims([invalid], [record])).toThrow();
  });
  it('returns exact member locators without inferring absent people', () => {
    expect(sourcePassage(record, 'member:1')).toContain('Yea');
    expect(sourcePassage(record, 'member:2')).toBeNull();
  });
});
