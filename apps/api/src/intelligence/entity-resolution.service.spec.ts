import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateDecision } from './entity-resolution.service.js';

describe('candidateDecision', () => {
  /**
   * The UNTIERED path — the sources that compute no identity tier (lda, sec,
   * fec_employer, fara, lobby_intel). Kept because that path still exists and
   * still governs those five sources.
   *
   * 'contracting' no longer reaches it: matchContractor always attaches a tier
   * now, so every production contracting decision goes through the tiered branch
   * below. The case is expressed with a source that genuinely still uses it,
   * rather than left asserting a route production has stopped taking.
   */
  test('a clear-winner, high-confidence untiered candidate auto-confirms', () => {
    expect(
      candidateDecision({ source: 'lda', confidence: 0.9, isTopForSource: true, runnerUpConfidence: null }),
    ).toBe('auto_confirm');
  });

  describe('tiered sources (contracting): the tier decides, not the score', () => {
    test('an unambiguous tier-1 identifier match auto-confirms', () => {
      expect(
        candidateDecision({
          source: 'contracting',
          confidence: 0.98,
          isTopForSource: true,
          runnerUpConfidence: null,
          matchTier: 1,
          autoConfirmEligible: true,
        }),
      ).toBe('auto_confirm');
    });

    test('an EXACT LEGAL NAME match (tier 2) routes to review however confident', () => {
      // The behaviour this pins is a deliberate tightening: a multi-token exact
      // fingerprint used to score 0.9 and auto-confirm, i.e. a NAME became a
      // confirmed corporate identity. A parent and a subsidiary can share a
      // registered name, and a confirmed identity drives award attribution.
      expect(
        candidateDecision({
          source: 'contracting',
          confidence: 0.9,
          isTopForSource: true,
          runnerUpConfidence: null,
          matchTier: 2,
          autoConfirmEligible: false,
        }),
      ).toBe('review');
    });

    test('a FUZZY NAME match (tier 4) never auto-confirms', () => {
      expect(
        candidateDecision({
          source: 'contracting',
          confidence: 0.99,
          isTopForSource: true,
          runnerUpConfidence: null,
          matchTier: 4,
          autoConfirmEligible: false,
        }),
      ).toBe('review');
    });

    test('a tier-1 match the policy called ambiguous does NOT auto-confirm', () => {
      expect(
        candidateDecision({
          source: 'contracting',
          confidence: 0.98,
          isTopForSource: true,
          runnerUpConfidence: null,
          matchTier: 1,
          autoConfirmEligible: false,
        }),
      ).toBe('review');
    });

    test('a tier-1 match with a near-tied runner-up does NOT auto-confirm', () => {
      expect(
        candidateDecision({
          source: 'contracting',
          confidence: 0.98,
          isTopForSource: true,
          runnerUpConfidence: 0.97,
          matchTier: 1,
          autoConfirmEligible: true,
        }),
      ).toBe('review');
    });

    test('a tiered candidate below the write floor is skipped, same as any other source', () => {
      expect(
        candidateDecision({
          source: 'contracting',
          confidence: 0.2,
          isTopForSource: true,
          runnerUpConfidence: null,
          matchTier: 4,
          autoConfirmEligible: false,
        }),
      ).toBe('skip');
    });
  });

  test('fec_committee never auto-confirms, even with a clear high-confidence winner (regression)', () => {
    expect(
      candidateDecision({ source: 'fec_committee', confidence: 0.99, isTopForSource: true, runnerUpConfidence: null }),
    ).toBe('review');
  });

  test('assistance_recipient never auto-confirms, even with a clear high-confidence winner', () => {
    expect(
      candidateDecision({
        source: 'assistance_recipient',
        confidence: 0.99,
        isTopForSource: true,
        runnerUpConfidence: null,
      }),
    ).toBe('review');
  });

  test('assistance_recipient still writes a below-threshold candidate as review, not skip, when it clears the write floor', () => {
    expect(
      candidateDecision({ source: 'assistance_recipient', confidence: 0.5, isTopForSource: true, runnerUpConfidence: null }),
    ).toBe('review');
  });

  test('assistance_recipient below the write floor is skipped, same as any other source', () => {
    expect(
      candidateDecision({ source: 'assistance_recipient', confidence: 0.2, isTopForSource: true, runnerUpConfidence: null }),
    ).toBe('skip');
  });
});

// Structural regression gates for the database-facing parts of the identity
// resolver. The decision engine above is pure; these assertions pin the query
// ordering and persistence semantics that previously bypassed it.
describe('contractor identity persistence boundaries', () => {
  const source = readFileSync(join(__dirname, 'entity-resolution.service.ts'), 'utf8');

  test('an exact UEI candidate is ordered ahead of fuzzy-name candidates before LIMIT', () => {
    const queryStart = source.indexOf('private async matchContractor');
    const queryEnd = source.indexOf('const candidates:', queryStart);
    const query = source.slice(queryStart, queryEnd);
    expect(query).toMatch(
      /ORDER BY[\s\S]*CASE WHEN[\s\S]*uei = [\s\S]*THEN 0 ELSE 1 END[\s\S]*similarity DESC[\s\S]*LIMIT 50/,
    );
  });

  test('a tier-1 upgrade repairs self identity and award roll-up on existing rows', () => {
    const persistStart = source.indexOf('private async persistSourceCandidates');
    const persistEnd = source.indexOf('// ── Stage A:', persistStart);
    const persist = source.slice(persistStart, persistEnd);
    expect(persist).toMatch(/autoConfirm[\s\S]*relationshipType:\s*'self'/);
    expect(persist).toMatch(/autoConfirm[\s\S]*rollUpAwards:\s*true/);
    expect(persist).toMatch(/reviewStatus:\s*'confirmed'/);
  });

  test('a durable rejection is preserved unless verified identifier evidence changes', () => {
    expect(source).toContain("reviewStatus === 'rejected'");
    expect(source).toContain("matchBasis === 'exact_uei'");
    expect(source).toMatch(
      /reviewStatus === 'rejected'[\s\S]*matchTier === 1[\s\S]*matchBasis === 'exact_uei'/,
    );
  });
});
