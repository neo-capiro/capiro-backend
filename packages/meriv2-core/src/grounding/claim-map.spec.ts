import { assembleClaimMap, claimFreshness, type ClaimDraft } from './claim-map';

const d1 = new Date('2026-06-01T00:00:00Z');
const d2 = new Date('2026-06-20T00:00:00Z');

const supported: ClaimDraft = {
  subjectType: 'bill',
  subjectId: 'hr-1234-119',
  statement: 'HR 1234 was referred to the Armed Services Committee',
  confidence: 'high',
  evidence: [
    { sourceType: 'congress_bill', sourceId: 'hr-1234-119', accessedAt: d1 },
    { sourceType: 'congress_action', sourceId: 'act-9', accessedAt: d2 },
  ],
};

const unsupported: ClaimDraft = {
  subjectType: 'bill',
  subjectId: 'hr-9999-119',
  statement: 'HR 9999 will certainly pass',
  confidence: 'low',
  evidence: [],
};

describe('assembleClaimMap', () => {
  it('partitions supported vs unsupported claims and never drops one', () => {
    const map = assembleClaimMap([supported, unsupported]);
    expect(map.supported).toHaveLength(1);
    expect(map.unsupported).toHaveLength(1);
    expect(map.supported[0]?.subjectId).toBe('hr-1234-119');
    expect(map.unsupported[0]?.subjectId).toBe('hr-9999-119');
    // total in == total out (no silent drop)
    expect(map.supported.length + map.unsupported.length).toBe(2);
  });
});

describe('claimFreshness', () => {
  it('returns the freshest evidence date', () => {
    expect(claimFreshness(supported)).toEqual(d2);
  });

  it('returns null when there is no evidence', () => {
    expect(claimFreshness(unsupported)).toBeNull();
  });
});
