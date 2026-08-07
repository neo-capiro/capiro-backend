import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIT_BANDS,
  FIT_BAND_LABELS,
  explainOpportunity,
  isLabelledSignal,
  labelledSignalKeys,
} from './opportunity-explanation.js';
import { SAM_RELEVANCE_SIGNALS, SAM_SIGNAL_STRENGTH } from './sam-opportunity-relevance.js';
import { RELEVANCE_SIGNALS, SIGNAL_STRENGTH } from '../district-nexus/grant-opportunity-relevance.js';

/**
 * P09 — the explanation vocabulary.
 *
 * The defect was two-part: a raw machine key rendered as itself, and a weak
 * near-tautological word hit looked identical to an exact classification match once
 * both were a bullet in a list. So the tests that matter are (1) every key either
 * rail can emit has a label, and (2) weak evidence cannot read as strong.
 */

const sig = (signal: string, strength: 'strong' | 'moderate' | 'weak', matchedOn: string) => ({
  signal,
  strength,
  matchedOn,
});

// ── Coverage: no key can render as itself ───────────────────────────────────

describe('every signal either scorer can emit has a label', () => {
  test.each([...RELEVANCE_SIGNALS])('grant signal %s is labelled', (key) => {
    // Read from the scorer's OWN list, so adding a signal there without labelling
    // it here fails this test rather than shipping a machine key to a user.
    expect(isLabelledSignal(key)).toBe(true);
  });

  test.each([...SAM_RELEVANCE_SIGNALS])('contract signal %s is labelled', (key) => {
    expect(isLabelledSignal(key)).toBe(true);
  });

  test('the vocabulary has no entries for signals nothing emits', () => {
    // A label for a key no scorer produces is dead copy that will drift out of
    // step with reality unnoticed.
    const emitted = new Set<string>([...RELEVANCE_SIGNALS, ...SAM_RELEVANCE_SIGNALS]);
    for (const labelled of labelledSignalKeys()) {
      expect(emitted.has(labelled)).toBe(true);
    }
  });

  test('no label is a raw camelCase key', () => {
    for (const key of labelledSignalKeys()) {
      const explained = explainOpportunity([sig(key, 'strong', 'X')]);
      expect(explained.strongest!.label).not.toMatch(/[a-z][A-Z]/);
      expect(explained.strongest!.label).not.toBe(key);
    }
  });

  test('every detail sentence NAMES the matched value', () => {
    // The whole point of matchedOn is that an operator can go and check it, so a
    // detail that omits it is a claim with no citation.
    for (const key of labelledSignalKeys()) {
      const explained = explainOpportunity([sig(key, 'moderate', 'VERIFY-ME-1234')]);
      expect(explained.strongest!.detail).toContain('VERIFY-ME-1234');
    }
  });

  test('an unrecognized key says it is unlabelled rather than pretending', () => {
    // Fails loudly-but-safely: it must not render the key as though it were prose.
    const explained = explainOpportunity([sig('someNewSignal', 'strong', 'X')]);
    expect(explained.strongest!.label).toBe('Unrecognized match signal');
    expect(isLabelledSignal('someNewSignal')).toBe(false);
  });
});

// ── Weak evidence cannot read as strong ────────────────────────────────────

describe('a weak generic token can never be described as strong evidence', () => {
  test('genericTopical is weak in the scorer AND says so in its prose', () => {
    // "defense" in a DoD notice corpus is near-tautological. The band alone is not
    // enough — a reader scanning bullets sees the sentence, not the band.
    expect(SAM_SIGNAL_STRENGTH.genericTopical).toBe('weak');
    const explained = explainOpportunity([sig('genericTopical', 'weak', 'defense')]);
    expect(explained.strongest!.detail).toMatch(/common term, not evidence on its own/i);
    expect(explained.fitBand).toBe('weak');
    expect(explained.fitLabel).toBe('Weak fit');
  });

  test('a pile of weak hits is still a weak fit', () => {
    const explained = explainOpportunity([
      sig('genericTopical', 'weak', 'defense'),
      sig('genericTopical', 'weak', 'systems'),
      sig('genericTopical', 'weak', 'services'),
      sig('sector', 'weak', 'DEFENSE'),
    ]);
    expect(explained.fitBand).toBe('weak');
    expect(explained.weakOnly).toBe(true);
  });

  test('the fit band comes from the STRONGEST signal, not from a count', () => {
    // Otherwise five weak hits would out-rank one exact NAICS match.
    const explained = explainOpportunity([
      sig('genericTopical', 'weak', 'defense'),
      sig('genericTopical', 'weak', 'systems'),
      sig('naicsExact', 'strong', '336411'),
    ]);
    expect(explained.fitBand).toBe('strong');
    expect(explained.strongest!.signal).toBe('naicsExact');
  });

  test('two moderate signals clear the floor; one does not', () => {
    const one = explainOpportunity([sig('naicsIndustryGroup', 'moderate', '3364')]);
    const two = explainOpportunity([
      sig('naicsIndustryGroup', 'moderate', '3364'),
      sig('pscCategory', 'moderate', '15'),
    ]);
    expect(one.weakOnly).toBe(true);
    expect(two.weakOnly).toBe(false);
  });

  test('an industry-GROUP match says the full codes differ', () => {
    // The distinction an operator must be able to see: 3364 vs 336411 is a real
    // relationship, but it is not the same code.
    const explained = explainOpportunity([sig('naicsIndustryGroup', 'moderate', '3364')]);
    expect(explained.strongest!.detail).toMatch(/full codes differ/i);
  });
});

// ── Determinism and ordering ────────────────────────────────────────────────

describe('the explanation does not depend on input order', () => {
  test('the leading reason is the same whatever order signals arrive in', () => {
    const a = explainOpportunity([
      sig('genericTopical', 'weak', 'defense'),
      sig('naicsExact', 'strong', '336411'),
      sig('pscCategory', 'moderate', '15'),
    ]);
    const b = explainOpportunity([
      sig('pscCategory', 'moderate', '15'),
      sig('naicsExact', 'strong', '336411'),
      sig('genericTopical', 'weak', 'defense'),
    ]);
    expect(b.strongest).toEqual(a.strongest);
    expect(b.fitBand).toBe(a.fitBand);
  });

  test('signals come back strongest first, so the evidence panel reads top-down', () => {
    const explained = explainOpportunity([
      sig('genericTopical', 'weak', 'defense'),
      sig('pscCategory', 'moderate', '15'),
      sig('naicsExact', 'strong', '336411'),
    ]);
    expect(explained.signals.map((s) => s.strength)).toEqual(['strong', 'moderate', 'weak']);
  });

  test('the same input twice is byte-identical', () => {
    const input = [sig('naicsExact', 'strong', '336411'), sig('sector', 'weak', 'DEFENSE')];
    expect(JSON.stringify(explainOpportunity(input))).toBe(
      JSON.stringify(explainOpportunity(input)),
    );
  });
});

// ── Thin and conflicting profiles ──────────────────────────────────────────

describe('thin and conflicting profiles stay honest', () => {
  test('no signals at all yields no leading reason, not an invented one', () => {
    // Absence produces nothing. It must never produce "no agency history" as
    // though that were a finding — we did not look and fail, we hold nothing.
    const explained = explainOpportunity([]);
    expect(explained.strongest).toBeNull();
    expect(explained.signals).toEqual([]);
    expect(explained.fitBand).toBe('weak');
    expect(explained.weakOnly).toBe(true);
  });

  test('an explanation never asserts the ABSENCE of a signal', () => {
    const explained = explainOpportunity([sig('naicsExact', 'strong', '336411')]);
    for (const s of explained.signals) {
      expect(s.detail).not.toMatch(/\bno prior\b|\bnot found\b|\bnone\b|\bmissing\b/i);
    }
  });

  test('a conflicting profile — strong classification, weak everything else — reads as strong but shows both', () => {
    const explained = explainOpportunity([
      sig('naicsExact', 'strong', '336411'),
      sig('genericTopical', 'weak', 'defense'),
      sig('sector', 'weak', 'DEFENSE'),
    ]);
    expect(explained.fitBand).toBe('strong');
    // The weak hits are NOT hidden: an operator judging the match needs to see
    // that most of the evidence was thin.
    expect(explained.signals).toHaveLength(3);
    expect(explained.signals.filter((s) => s.strength === 'weak')).toHaveLength(2);
  });

  test('the bands and their labels are one-to-one', () => {
    expect(Object.keys(FIT_BAND_LABELS).sort()).toEqual([...FIT_BANDS].sort());
    for (const band of FIT_BANDS) {
      expect(FIT_BAND_LABELS[band]).toMatch(/fit$/i);
    }
  });

  test('grant and contract rails use the SAME three bands', () => {
    // Both scorers already emit the same three-band vocabulary; this asserts the
    // explanation layer did not invent a fourth.
    const bands = new Set<string>([
      ...Object.values(SIGNAL_STRENGTH),
      ...Object.values(SAM_SIGNAL_STRENGTH),
    ]);
    expect([...bands].sort()).toEqual([...FIT_BANDS].sort());
  });
});

// ── The card leads with the recommendation, not a number ───────────────────

describe('the card no longer leads with a machine key or a bare score', () => {
  const card = readFileSync(
    join(__dirname, '../../../web/src/pages/intelligence/opportunities/OpportunityCard.tsx'),
    'utf8',
  );
  const mirror = readFileSync(
    join(__dirname, '../../../web/src/pages/intelligence/opportunities/opportunity-explanations.ts'),
    'utf8',
  );

  test('the web mirror labels every signal the API labels', () => {
    for (const key of labelledSignalKeys()) {
      expect(mirror).toContain(`${key}:`);
    }
  });

  test('the card renders a fit band', () => {
    expect(card).toMatch(/Strong fit|fitLabel|FIT_BAND_LABELS/);
  });

  test('the numeric relevance sits behind a disclosure, not in the headline', () => {
    // Kept, not deleted: an operator auditing a match needs the number. It just
    // must not be the first thing the card says.
    expect(card).toMatch(/Collapse|Panel|evidence/i);
  });
});
