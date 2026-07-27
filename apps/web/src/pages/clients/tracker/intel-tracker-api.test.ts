import { describe, expect, test } from 'vitest';
import {
  adaptWatchlist,
  changeChipToChange,
  watchlistToIntel,
  type IntelWatchlist,
} from './intel-tracker-api.js';
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

  test('P1-02: version/updatedAt read through and the PUT echoes expectedVersion', () => {
    const cold = adaptWatchlist({ clientId: 'c1', issueAreas: [], topics: [] });
    // A never-configured client is version 0, and 0 must survive (`?? 0`, not `|| 0`).
    expect(cold.version).toBe(0);
    expect(watchlistToIntel(cold).expectedVersion).toBe(0);

    const configured = adaptWatchlist({
      clientId: 'c1',
      issueAreas: [],
      topics: [],
      version: 7,
      updatedByName: 'Neo Martinez',
      updatedAt: '2026-07-26T13:41:00.000Z',
    });
    expect(configured.version).toBe(7);
    expect(configured.updatedAt).toBe('2026-07-26T13:41:00.000Z');
    expect(watchlistToIntel(configured).expectedVersion).toBe(7);
  });

  test('P0-03: renameFrom is sent only when set, and a fresh read never carries one', () => {
    const read = adaptWatchlist({
      clientId: 'c1',
      issueAreas: [],
      topics: [{ label: 'alpha', issueArea: null, position: 'monitor', priority: 'med', terms: [] }],
    });
    // A reload must clear a pending rename, or the next save would rename again.
    expect(read.tags[0]).not.toHaveProperty('renameFrom');
    expect(watchlistToIntel(read).topics[0]).not.toHaveProperty('renameFrom');

    const renamed = { ...read, tags: [{ ...read.tags[0]!, tag: 'beta', renameFrom: 'alpha' }] };
    expect(watchlistToIntel(renamed).topics[0]).toMatchObject({
      label: 'beta',
      renameFrom: 'alpha',
    });
  });
});

/**
 * Gate D phase a (P1-08), a-5 case 8. The web used to derive a card's tone from
 * its OWN copy of a narrow federal change-type list, so a failed governing rule
 * or a state veto rendered 'notable'. It now prefers the server's tone, then the
 * server's severity, and keeps the old list only as a pre-Gate-D fallback.
 */
describe('changeChipToChange — tone comes from the server (P1-08)', () => {
  test('prefers the server tone over everything else', () => {
    expect(
      changeChipToChange({
        label: 'Rule failed — stalled on the floor',
        changeType: 'bill_rule_failed',
        at: '2026-03-10',
        severity: 'critical',
        tone: 'critical',
      })?.tone,
    ).toBe('critical');
    // 'success' is reachable ONLY via tone — severity cannot express it, which
    // is why "Became law" must not look like "Failed / rejected".
    expect(
      changeChipToChange({
        label: 'Became law',
        changeType: 'bill_enacted',
        at: '2026-03-10',
        severity: 'critical',
        tone: 'success',
      })?.tone,
    ).toBe('success');
  });

  test('falls back to severity when tone is absent', () => {
    expect(
      changeChipToChange({
        label: 'Vetoed',
        changeType: 'state_bill_vetoed',
        at: '2026-03-10',
        severity: 'critical',
        tone: null,
      })?.tone,
    ).toBe('critical');
    expect(
      changeChipToChange({
        label: 'Hearing scheduled',
        changeType: 'bill_hearing',
        at: '2026-03-10',
        severity: 'info',
        tone: null,
      })?.tone,
    ).toBe('info');
    expect(
      changeChipToChange({
        label: 'Amended',
        changeType: 'bill_amendment',
        at: '2026-03-10',
        severity: 'notable',
        tone: null,
      })?.tone,
    ).toBe('notable');
  });

  test('falls back to the legacy list for a pre-Gate-D response', () => {
    // A cached board page from before this deploy carries neither field.
    expect(
      changeChipToChange({ label: 'Became law', changeType: 'bill_enacted', at: '2026-03-10' })
        ?.tone,
    ).toBe('critical');
    expect(
      changeChipToChange({ label: 'Amended', changeType: 'bill_amendment', at: '2026-03-10' })
        ?.tone,
    ).toBe('notable');
  });

  test('the REGRESSION this fixes: state veto / failed rule are no longer notable', () => {
    // Pre-Gate-D these hit the legacy list, missed, and rendered 'notable'.
    for (const changeType of [
      'bill_rule_failed',
      'state_bill_vetoed',
      'state_bill_failed',
      'state_bill_dead_by_deadline',
    ]) {
      expect(
        changeChipToChange({ label: 'x', changeType, at: '2026-03-10', severity: 'critical' })
          ?.tone,
      ).toBe('critical');
    }
  });

  test('null chip stays null; an unknown type with no server fields is notable', () => {
    expect(changeChipToChange(null)).toBeNull();
    expect(
      changeChipToChange({ label: 'x', changeType: 'something_new', at: '2026-03-10' })?.tone,
    ).toBe('notable');
  });
});
