/**
 * Gate D phase d (§4.8, §4.4) — explainable scoring.
 *
 * §6.2 was answered FORWARD-ONLY: the re-weight applies to newly written
 * alerts, existing `intel_alert.score` rows are not recomputed, and the UI says
 * so on the Priority sort. These tests lock the model itself.
 */
import {
  bandOf,
  computeScoreV2,
  computeScore,
  scoreShadowAlert,
  evidenceCoverage,
  weightedRelevance,
  positionMultiplier,
  DUPLICATION_PENALTY,
  SCORE_WEIGHTS_V2,
  SCORE_MODEL_VERSION,
  type ScoreFactorsV2,
} from '../src/intel-alert/alert-scorer.js';
import { relevanceKindsFor, composeWhy } from '../src/tracker/relevance-kinds.js';

const NOW = new Date('2026-03-10T00:00:00Z').getTime();

const factors = (over: Partial<ScoreFactorsV2> = {}): ScoreFactorsV2 => ({
  relevance: 0.5,
  materiality: 0.5,
  urgency: 0.5,
  clientPriority: 0.5,
  targetOpportunity: null,
  evidenceConfidence: 0.5,
  duplicationPenalty: 0,
  ...over,
});

/** d-6 case 1: the contributions must reconcile to the score. */
describe('computeScoreV2 — the breakdown reconciles', () => {
  it.each([
    ['flat mid', factors()],
    ['all high', factors({ relevance: 1, materiality: 1, urgency: 1, clientPriority: 1, evidenceConfidence: 1 })],
    ['all low', factors({ relevance: 0, materiality: 0, urgency: 0, clientPriority: 0, evidenceConfidence: 0 })],
    ['mixed', factors({ relevance: 0.9, materiality: 0.33, urgency: 0.1, clientPriority: 0.85 })],
    ['with penalty', factors({ duplicationPenalty: DUPLICATION_PENALTY })],
  ])('%s: contributions sum to score within 1e-9', (_name, f) => {
    const { score, contributions } = computeScoreV2(f);
    const sum = Object.values(contributions).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - score)).toBeLessThan(1e-9);
  });

  it('every available factor appears in the breakdown; unavailable ones do not', () => {
    const { contributions, unavailable } = computeScoreV2(factors());
    expect(Object.keys(contributions).sort()).toEqual([
      'clientPriority',
      'evidenceConfidence',
      'materiality',
      'relevance',
      'urgency',
    ]);
    expect(unavailable).toEqual(['targetOpportunity']);
    expect(contributions).not.toHaveProperty('targetOpportunity');
  });
});

/**
 * The reason `targetOpportunity` is null rather than 0. Scoring an
 * unavailable factor as a real zero while it still carries weight 0.10 docks
 * EVERY alert a tenth it can never earn, and with bandOf's thresholds frozen
 * that walks the whole corpus down a band.
 */
describe('an unavailable factor is excluded, not scored as zero', () => {
  it('null does not depress the score the way 0 does', () => {
    const excluded = computeScoreV2(factors({ targetOpportunity: null })).score;
    const asZero = computeScoreV2(factors({ targetOpportunity: 0 })).score;
    expect(excluded).toBeGreaterThan(asZero);
    // With every other factor at 0.5, renormalising must give exactly 0.5.
    expect(excluded).toBeCloseTo(0.5, 10);
    // Scored as a real 0 it would be 0.45 — straight through the Med boundary.
    expect(asZero).toBeCloseTo(0.45, 10);
    expect(bandOf(excluded)).toBe('Med');
  });

  it('renormalises over the available weights only', () => {
    // Everything available and at 1.0 → exactly 1.0, regardless of exclusions.
    const all = computeScoreV2(
      factors({ relevance: 1, materiality: 1, urgency: 1, clientPriority: 1, evidenceConfidence: 1 }),
    );
    expect(all.score).toBeCloseTo(1, 10);
  });

  it('the declared weights still sum to 1', () => {
    const total = Object.values(SCORE_WEIGHTS_V2).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

/** d-6 case 2. */
describe('floored', () => {
  it('is true exactly when the phase-a critical floor applied', () => {
    const lowCritical = scoreShadowAlert({
      severity: 'critical',
      materiality: 'low',
      changeType: 'state_bill_deadline_approaching',
      actionDate: null,
      matchedTags: [],
      nowMs: NOW,
    });
    expect(lowCritical.factors.floored).toBe(true);
    expect(lowCritical.band).toBe('High');

    const notCritical = scoreShadowAlert({
      severity: 'notable',
      materiality: 'medium',
      changeType: 'bill_amendment',
      actionDate: new Date(NOW - 3_600_000),
      matchedTags: ['energy'],
      nowMs: NOW,
    });
    expect(notCritical.factors.floored).toBe(false);
  });

  it('is false when a critical alert already scored above the floor on merit', () => {
    const strong = scoreShadowAlert({
      severity: 'critical',
      materiality: 'high',
      changeType: 'bill_enacted',
      actionDate: new Date(NOW - 3_600_000),
      matchedTags: ['energy'],
      clientPriority: 'high',
      position: 'oppose',
      evidenceConfidence: 1,
      matchDetails: [{ weight: 5, confidence: 1 }, { weight: 5, confidence: 1 }],
      nowMs: NOW,
    });
    expect(strong.score).toBeGreaterThanOrEqual(0.66);
    expect(strong.factors.floored).toBe(false);
  });
});

/** d-6 case 5. */
describe('duplicationPenalty', () => {
  it('is applied only when the caller reports a duplicate', () => {
    const base = {
      severity: 'notable' as const,
      materiality: 'medium',
      changeType: 'bill_amendment',
      actionDate: new Date(NOW - 3_600_000),
      matchedTags: ['energy'],
      evidenceConfidence: 0.7,
      nowMs: NOW,
    };
    const clean = scoreShadowAlert(base);
    const dup = scoreShadowAlert({ ...base, duplicate: true });
    expect(clean.factors.duplicationPenalty).toBe(0);
    expect(dup.factors.duplicationPenalty).toBe(DUPLICATION_PENALTY);
    expect(clean.score - dup.score).toBeCloseTo(DUPLICATION_PENALTY, 10);
    expect(dup.factors.contributions.duplicationPenalty).toBe(-DUPLICATION_PENALTY);
  });

  /**
   * D6 — the scorer must stay pure. The duplication penalty needs a query, so
   * the temptation is to reach for Prisma here; it is computed by the caller
   * instead. This asserts the file itself never acquires that dependency.
   */
  it('D6: alert-scorer.ts imports no Prisma, service, or Nest', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/intel-alert/alert-scorer.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0); // the read really found the file
    for (const line of imports) {
      expect(line).not.toMatch(/prisma/i);
      expect(line).not.toMatch(/\.service\.js/);
      expect(line).not.toMatch(/@nestjs/);
    }
  });
});

describe('weightedRelevance replaces the boolean keyword proxy', () => {
  it('scales with the matched terms weight × confidence', () => {
    expect(weightedRelevance([], false)).toBe(0.3);
    expect(weightedRelevance([], true)).toBe(0.5);
    expect(weightedRelevance([{ weight: 5, confidence: 1 }], true)).toBeCloseTo(0.5, 10);
    expect(weightedRelevance([{ weight: 2, confidence: 0.5 }], true)).toBeCloseTo(0.1, 10);
    // Clamped at 1.
    expect(weightedRelevance([{ weight: 50, confidence: 1 }], true)).toBe(1);
  });

  it('a stronger match outranks a weaker one, all else equal', () => {
    const mk = (details: Array<{ weight: number; confidence: number }>) =>
      scoreShadowAlert({
        severity: 'notable',
        materiality: 'medium',
        changeType: 'bill_amendment',
        actionDate: new Date(NOW - 3_600_000),
        matchedTags: ['energy'],
        matchDetails: details,
        nowMs: NOW,
      }).score;
    expect(mk([{ weight: 8, confidence: 1 }])).toBeGreaterThan(mk([{ weight: 2, confidence: 0.5 }]));
  });
});

describe('positionMultiplier folds stance into client priority', () => {
  it('a stated position is higher-stakes than monitoring', () => {
    expect(positionMultiplier('oppose')).toBe(1);
    expect(positionMultiplier('support')).toBe(1);
    expect(positionMultiplier('monitor')).toBe(0.85);
    expect(positionMultiplier(null)).toBe(0.85);
  });
});

describe('evidenceCoverage — ONE definition shared with the packet', () => {
  it('is filled / seven over the canonical alert fields', () => {
    expect(
      evidenceCoverage({
        whatChanged: 'x',
        whyItMatters: 'y',
        clientId: 'c1',
        issueId: 'grid',
        whoActs: null,
        deadline: '2026-03-09',
        sourceType: 'bill',
      }),
    ).toBeCloseTo(6 / 7, 10);
    expect(evidenceCoverage({})).toBe(0);
    // Empty string counts as unfilled, matching the packet's own predicate.
    expect(evidenceCoverage({ whatChanged: '', whyItMatters: 'y' })).toBeCloseTo(1 / 7, 10);
  });

  it('supersedes v1 legCoverage rather than stacking with it', () => {
    // v1's penalty term is gone from the v2 path entirely.
    const f = factors({ evidenceConfidence: 0 });
    const { contributions } = computeScoreV2(f);
    expect(contributions).not.toHaveProperty('legCoverage');
  });
});

describe('SCORE_MODEL_VERSION', () => {
  it('is 2, and v1 remains available for reading historical scores', () => {
    expect(SCORE_MODEL_VERSION).toBe(2);
    // v1 is frozen and still callable — existing rows were written by it.
    expect(
      computeScore({
        relevance: 0.8,
        materiality: 1,
        urgency: 1,
        political: 0,
        clientPriority: 0.66,
        legCoverage: 0.5,
      }),
    ).toBeCloseTo(0.721, 3);
  });

  it('D1: bandOf thresholds are STILL untouched after the re-weight', () => {
    expect(bandOf(0.66)).toBe('High');
    expect(bandOf(0.45)).toBe('Med');
    expect(bandOf(0.4499)).toBe('Low');
  });
});

/** d-6 case 3 — §4.4 relevance kinds. */
describe('relevanceKindsFor is deterministic and never guesses', () => {
  const base = {
    matchedTermTypes: [] as string[],
    position: null as string | null,
    severity: 'notable',
    changeType: 'bill_amendment',
    hasFacilityInJurisdiction: false,
    hasTargetInCommittee: false,
  };

  it.each([
    ['company', 'direct_impact'],
    ['bill', 'direct_impact'],
    ['competitor', 'competitive_impact'],
    ['program_element', 'funding_impact'],
  ])('%s → %s', (termType, kind) => {
    expect(relevanceKindsFor({ ...base, matchedTermTypes: [termType] })).toContain(kind);
  });

  it('risk/opposition language only counts as political risk when the client opposes', () => {
    expect(
      relevanceKindsFor({ ...base, matchedTermTypes: ['risk_phrase'], position: 'oppose' }),
    ).toContain('political_risk');
    expect(
      relevanceKindsFor({ ...base, matchedTermTypes: ['risk_phrase'], position: 'monitor' }),
    ).not.toContain('political_risk');
  });

  it('support language only counts as opportunity when the client supports', () => {
    expect(
      relevanceKindsFor({ ...base, matchedTermTypes: ['support_language'], position: 'support' }),
    ).toContain('strategic_opportunity');
    expect(
      relevanceKindsFor({ ...base, matchedTermTypes: ['support_language'], position: null }),
    ).not.toContain('strategic_opportunity');
  });

  it('critical severity or a deadline change type is procedural urgency', () => {
    expect(relevanceKindsFor({ ...base, severity: 'critical' })).toContain('procedural_urgency');
    expect(
      relevanceKindsFor({ ...base, changeType: 'state_bill_deadline_approaching' }),
    ).toContain('procedural_urgency');
    expect(relevanceKindsFor(base)).not.toContain('procedural_urgency');
  });

  /** §6.6 — the two gated kinds must NEVER be emitted on a guess. */
  it('never emits relationship_opportunity without the backing signal', () => {
    expect(relevanceKindsFor({ ...base, hasTargetInCommittee: false })).not.toContain(
      'relationship_opportunity',
    );
    expect(
      relevanceKindsFor({
        ...base,
        matchedTermTypes: ['company', 'competitor', 'program_element', 'risk_phrase'],
        position: 'oppose',
        severity: 'critical',
        hasTargetInCommittee: false,
      }),
    ).not.toContain('relationship_opportunity');
    expect(relevanceKindsFor({ ...base, hasTargetInCommittee: true })).toContain(
      'relationship_opportunity',
    );
  });

  it('never emits district_impact without a facility in the jurisdiction', () => {
    expect(relevanceKindsFor({ ...base, hasFacilityInJurisdiction: false })).not.toContain(
      'district_impact',
    );
    expect(relevanceKindsFor({ ...base, hasFacilityInJurisdiction: true })).toContain(
      'district_impact',
    );
  });

  it('is order-stable for the same input', () => {
    const input = {
      ...base,
      matchedTermTypes: ['program_element', 'company'],
      severity: 'critical',
      hasFacilityInJurisdiction: true,
    };
    expect(relevanceKindsFor(input)).toEqual(relevanceKindsFor(input));
    expect(relevanceKindsFor(input)).toEqual([
      'direct_impact',
      'funding_impact',
      'district_impact',
      'procedural_urgency',
    ]);
  });
});

/** d-6 case 4 — the existing wording is preserved verbatim as clause one. */
describe('composeWhy keeps the historical first clause byte-identical', () => {
  it('a legacy synonym-only watchlist reads exactly as before', () => {
    const legacy = 'Matches your watchlist term "large-load".';
    // No kinds → completely unchanged.
    expect(composeWhy(legacy, [])).toBe(legacy);
  });

  it('an enriched why still STARTS with the original sentence', () => {
    const legacy = 'Matches your watchlist term "large-load".';
    const out = composeWhy(legacy, ['direct_impact']);
    expect(out!.startsWith(legacy)).toBe(true);
    expect(out).toBe(`${legacy} It names the client directly.`);
  });

  it('a null why stays null — never invented', () => {
    expect(composeWhy(null, ['direct_impact'])).toBeNull();
  });

  it('adds at most one extra clause', () => {
    const out = composeWhy('Base.', ['direct_impact', 'funding_impact', 'procedural_urgency']);
    expect(out!.split('.').filter((s) => s.trim()).length).toBe(2);
  });
});
