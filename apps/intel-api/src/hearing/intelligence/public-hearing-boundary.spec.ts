import {
  assertPublicHearingBoundary,
  isPublicHearingBoundarySafe,
  PublicHearingBoundaryError,
} from './public-hearing-boundary.js';

describe('public hearing intelligence boundary', () => {
  it('accepts public transcript and insight fields', () => {
    expect(() =>
      assertPublicHearingBoundary({
        hearingId: 'h1',
        committeeName: 'Armed Services',
        insights: [
          {
            insightType: 'BILL_REFERENCE',
            summary: 'H.R. 1 was discussed.',
            entities: [{ entityType: 'BILL', canonicalId: 'HR-1' }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    ['tenantId', { tenantId: 't1' }],
    ['compound clientName', { metadata: { clientName: 'Private Client' } }],
    ['watchlist filters', { result: [{ watchlistTerms: ['autonomy'] }] }],
    ['private user field', { delegatedUserId: 'u1' }],
    ['confidential context', { context: { confidentialNotes: 'private' } }],
  ])('rejects %s anywhere in the global payload', (_label, payload) => {
    expect(() => assertPublicHearingBoundary(payload)).toThrow(PublicHearingBoundaryError);
    expect(isPublicHearingBoundarySafe(payload)).toBe(false);
  });

  it('handles cyclic public structures without looping forever', () => {
    const value: Record<string, unknown> = { hearingId: 'h1' };
    value.self = value;
    expect(() => assertPublicHearingBoundary(value)).not.toThrow();
  });
});
