import {
  floridaAliasPlanHash,
  validateFloridaOpenstatesAliasReview,
  validateFloridaOpenstatesAliasRows,
  type FloridaOpenstatesAliasReview,
} from './florida-openstates-alias-review.js';

const review: FloridaOpenstatesAliasReview = {
  repairId: 'fl-openstates-tfc-2026-09-20',
  aliasId: `state-fl-${'a'.repeat(32)}`,
  canonicalId: `state-fl-${'b'.repeat(32)}`,
  externalEventId: 'ocd-event/00000000-0000-4000-8000-000000000001',
  publisherMediaEntryId: '1_abcd1234',
  session: '2026',
  date: '2026-02-04',
  chamber: 'senate',
  stateCommitteeId: 'FL-upper-appropriations-on-higher-education',
  bodySourceKey: 'fl:senate:appropriations-on-higher-education',
  aliasEvidenceUrl: 'https://www.flsenate.gov/media/video/123',
  canonicalEvidenceUrl:
    'https://thefloridachannel.org/videos/2-4-26-senate-appropriations-committee/',
  reason: 'Exact shared publisher media identity reviewed by the operator.',
};

const alias = {
  id: review.aliasId,
  canonicalHearingId: null,
  geographicJurisdiction: 'FL',
  legislativeSession: '2026',
  chamber: 'Senate',
  committeeName: 'Appropriations on Higher Education',
  stateCommitteeId: review.stateCommitteeId,
  bodySourceKey: review.bodySourceKey,
  date: new Date('2026-02-04T00:00:00Z'),
};
const canonical = {
  ...alias,
  id: review.canonicalId,
  committeeName: 'Florida Channel archive',
  stateCommitteeId: null,
  bodySourceKey: 'fl:senate:tfc:video:78389',
};
const committee = {
  id: review.stateCommitteeId,
  state: 'FL',
  chamber: 'upper',
  legislativeSession: '2026',
  officialSourceKey: `FL:2026:${review.bodySourceKey}`,
  name: alias.committeeName,
};

describe('Florida OpenStates alias review', () => {
  it('accepts an exact qualified alias and Florida Channel bridge target', () => {
    expect(() =>
      validateFloridaOpenstatesAliasRows(review, alias, canonical, committee),
    ).not.toThrow();
  });

  it.each([
    ['wrong media id', { publisherMediaEntryId: 'youtube:123' }],
    ['unqualified body', { bodySourceKey: 'unresolved-body:openstates:x' }],
    ['untrusted evidence', { aliasEvidenceUrl: 'https://example.com/video' }],
    ['cross-session date', { date: '2025-02-04' }],
  ])('rejects %s', (_label, changed) => {
    expect(() => validateFloridaOpenstatesAliasReview({ ...review, ...changed })).toThrow(
      'Florida OpenStates alias review refused',
    );
  });

  it('rejects committee and archive identity conflicts', () => {
    expect(() =>
      validateFloridaOpenstatesAliasRows(
        review,
        alias,
        { ...canonical, bodySourceKey: 'fl:senate:other' },
        committee,
      ),
    ).toThrow('canonical target');
    expect(() =>
      validateFloridaOpenstatesAliasRows(review, alias, canonical, {
        ...committee,
        officialSourceKey: 'FL:2026:fl:senate:other',
      }),
    ).toThrow('state committee identity');
  });

  it('hashes key-sorted plans deterministically', () => {
    expect(floridaAliasPlanHash({ b: 2, a: 1 })).toBe(floridaAliasPlanHash({ a: 1, b: 2 }));
  });
});
