import { describe, expect, test } from 'vitest';
import { adaptWatchlist, watchlistToIntel, type IntelWatchlist } from './intel-tracker-api.js';
import { TERM_TYPES } from './tracker-api.js';

/**
 * P5 — the watchlist adapters must round-trip ALL term types losslessly:
 *  - the three LEGACY implicit types (synonym/entity/risk) map to the chip
 *    inputs and must still render + persist,
 *  - the 11 canonical types + any unknown hearing-native type ride in
 *    `typedTerms` and must survive a get→edit→put cycle unchanged.
 */
describe('adaptWatchlist / watchlistToIntel round-trip', () => {
  test('legacy synonym/entity/risk map to the three chip buckets', () => {
    const intel: IntelWatchlist = {
      clientId: 'c1',
      issueAreas: ['Energy'],
      topics: [
        {
          label: 'data center load',
          issueArea: 'Energy',
          position: 'support',
          priority: 'high',
          terms: [
            { termType: 'synonym', value: 'large-load' },
            { termType: 'entity', value: 'FERC' },
            { termType: 'risk', value: 'moratorium' },
          ],
        },
      ],
    };
    const payload = adaptWatchlist(intel);
    const tag = payload.tags[0]!;
    expect(tag.synonyms).toEqual(['large-load']);
    expect(tag.relatedEntities).toEqual(['FERC']);
    expect(tag.riskTerms).toEqual(['moratorium']);
    expect(tag.typedTerms).toEqual([]);
    expect(tag.position).toBe('support');
    expect(tag.priority).toBe('high');
  });

  test('the 11 canonical types ride in typedTerms and round-trip unchanged', () => {
    const intel: IntelWatchlist = {
      clientId: 'c1',
      issueAreas: [],
      topics: [
        {
          label: 'everything',
          issueArea: null,
          position: 'monitor',
          priority: 'med',
          terms: TERM_TYPES.map((t) => ({ termType: t, value: `${t}-value` })),
        },
      ],
    };
    const payload = adaptWatchlist(intel);
    expect(payload.tags[0]!.typedTerms).toEqual(
      TERM_TYPES.map((t) => ({ termType: t, value: `${t}-value` })),
    );
    // put re-emits exactly the same terms (order: chips then typedTerms — here no chips).
    const body = watchlistToIntel(payload);
    expect(body.topics[0]!.terms).toEqual(
      TERM_TYPES.map((t) => ({ termType: t, value: `${t}-value` })),
    );
  });

  test('an UNKNOWN (hearing-native) term type is preserved, not dropped', () => {
    const intel: IntelWatchlist = {
      clientId: 'c1',
      issueAreas: [],
      topics: [
        {
          label: 'Hearing terms',
          issueArea: null,
          position: 'monitor',
          priority: 'med',
          terms: [{ termType: 'some_future_type', value: 'keep me' }],
        },
      ],
    };
    const payload = adaptWatchlist(intel);
    expect(payload.tags[0]!.typedTerms).toEqual([{ termType: 'some_future_type', value: 'keep me' }]);
    const body = watchlistToIntel(payload);
    expect(body.topics[0]!.terms).toEqual([{ termType: 'some_future_type', value: 'keep me' }]);
  });

  test('a mixed topic (legacy chips + canonical typed terms) round-trips completely', () => {
    const intel: IntelWatchlist = {
      clientId: 'c1',
      issueAreas: ['Defense'],
      topics: [
        {
          label: 'hypersonics',
          issueArea: 'Defense',
          position: 'oppose',
          priority: 'low',
          terms: [
            { termType: 'synonym', value: 'boost-glide' },
            { termType: 'bill', value: '119-hr-1234' },
            { termType: 'agency', value: 'DARPA' },
            { termType: 'risk', value: 'schedule slip' },
          ],
        },
      ],
    };
    const payload = adaptWatchlist(intel);
    const body = watchlistToIntel(payload);
    // Every original term is present after the full cycle (order-independent).
    const sortKey = (t: { termType: string; value: string }) => `${t.termType}:${t.value}`;
    expect(body.topics[0]!.terms.map(sortKey).sort()).toEqual(
      intel.topics[0]!.terms.map(sortKey).sort(),
    );
    expect(body.issueAreas).toEqual(['Defense']);
    expect(body.topics[0]!.position).toBe('oppose');
    expect(body.topics[0]!.priority).toBe('low');
  });

  test('P6: suggestedIssueAreas passes through when present, absent otherwise', () => {
    const cold = adaptWatchlist({
      clientId: 'c1',
      issueAreas: [],
      topics: [],
      suggestedIssueAreas: ['Defense'],
    });
    expect(cold.suggestedIssueAreas).toEqual(['Defense']);

    const configured = adaptWatchlist({ clientId: 'c1', issueAreas: ['Energy'], topics: [] });
    expect(configured.suggestedIssueAreas).toBeUndefined();
  });

  test('S7.2 (DD5): jurisdictions round-trips; absent reads as federal-only (empty), never omitted on write', () => {
    const cold = adaptWatchlist({ clientId: 'c1', issueAreas: [], topics: [] });
    expect(cold.jurisdictions).toEqual([]);

    const withStates = adaptWatchlist({
      clientId: 'c1',
      issueAreas: [],
      topics: [],
      jurisdictions: ['TX', 'FL'],
    });
    expect(withStates.jurisdictions).toEqual(['TX', 'FL']);
    expect(watchlistToIntel(withStates).jurisdictions).toEqual(['TX', 'FL']);
    // Federal-only (empty) still round-trips as an explicit [] — never dropped
    // from the PUT body, so a prior selection can be cleared.
    expect(watchlistToIntel(cold).jurisdictions).toEqual([]);
  });

  test('S5.1: suggestedJurisdictions passes through when present, absent otherwise', () => {
    const cold = adaptWatchlist({
      clientId: 'c1',
      issueAreas: [],
      topics: [],
      suggestedJurisdictions: ['VA'],
    });
    expect(cold.suggestedJurisdictions).toEqual(['VA']);

    const configured = adaptWatchlist({
      clientId: 'c1',
      issueAreas: [],
      topics: [],
      jurisdictions: ['TX'],
    });
    expect(configured.suggestedJurisdictions).toBeUndefined();
  });
});
