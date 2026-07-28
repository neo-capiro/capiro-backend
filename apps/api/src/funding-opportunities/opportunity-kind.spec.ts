import { describe, expect, test } from '@jest/globals';
import { grantsGovKind, normalizeKindText, samNoticeKind } from './opportunity-kind.js';
import { NON_PURSUABLE_KINDS, OPPORTUNITY_KINDS } from './funding-opportunities.types.js';

describe('SAM notice lifecycle normalization', () => {
  test.each([
    ['Sources Sought', 'sources_sought'],
    ['SOURCES SOUGHT NOTICE', 'sources_sought'],
    ['Presolicitation', 'presolicitation'],
    ['Pre-solicitation', 'presolicitation'],
    ['Solicitation', 'solicitation'],
    ['Combined Synopsis/Solicitation', 'combined_synopsis_solicitation'],
    ['Combined Synopsis / Solicitation', 'combined_synopsis_solicitation'],
    ['COMBINED SYNOPSIS SOLICITATION', 'combined_synopsis_solicitation'],
    ['Special Notice', 'special_notice'],
    ['Justification and Approval (J&A)', 'special_notice'],
    ['Intent to Bundle Requirements (DoD-Funded)', 'special_notice'],
    ['Sale of Surplus Property', 'special_notice'],
    ['Award Notice', 'award_notice'],
    ['Modification/Amendment/Cancel', 'amendment'],
  ])('%s → %s', (raw, expected) => {
    expect(samNoticeKind(raw)).toBe(expected);
  });

  test('"presolicitation" must NOT be read as an open solicitation', () => {
    // Once punctuation is flattened, "presolicitation" contains "solicitation".
    // Ordering inside samNoticeKind is the only thing preventing this, so it is
    // pinned directly: a sources-sought or presolicitation notice presented as an
    // open solicitation is a client told to bid on something with no RFP.
    expect(samNoticeKind('Presolicitation')).not.toBe('solicitation');
    expect(samNoticeKind('Combined Synopsis/Solicitation')).not.toBe('solicitation');
  });

  test('an unrecognized type is `other`, never a guessed solicitation', () => {
    expect(samNoticeKind('Some Brand New SAM Notice Category')).toBe('other');
    expect(samNoticeKind('')).toBe('other');
    expect(samNoticeKind(null)).toBe('other');
  });

  test('every produced kind is in the bounded vocabulary', () => {
    const samples = [
      'Sources Sought',
      'Presolicitation',
      'Solicitation',
      'Combined Synopsis/Solicitation',
      'Special Notice',
      'Award Notice',
      'Modification',
      'gibberish',
      null,
    ];
    for (const s of samples) {
      expect(OPPORTUNITY_KINDS).toContain(samNoticeKind(s));
    }
  });
});

describe('award and special notices are not pursuits', () => {
  test('award_notice and special_notice are non-pursuable', () => {
    expect(NON_PURSUABLE_KINDS.has('award_notice')).toBe(true);
    expect(NON_PURSUABLE_KINDS.has('special_notice')).toBe(true);
  });

  test('every solicitation-family kind IS pursuable', () => {
    for (const k of [
      'sources_sought',
      'presolicitation',
      'solicitation',
      'combined_synopsis_solicitation',
      'grant',
      'cooperative_agreement',
    ] as const) {
      expect(NON_PURSUABLE_KINDS.has(k)).toBe(false);
    }
  });
});

describe('Grants.gov instrument normalization', () => {
  test('a cooperative agreement is not flattened into a grant', () => {
    // The government is a participant in a cooperative agreement, not merely a
    // funder — a materially different instrument to bid for.
    expect(grantsGovKind('Cooperative Agreement')).toBe('cooperative_agreement');
    expect(grantsGovKind('Grant, Cooperative Agreement')).toBe('cooperative_agreement');
  });

  test('a plain grant, and an absent instrument, are both `grant`', () => {
    expect(grantsGovKind('Grant')).toBe('grant');
    // Absent is the common case: fundingInstrument only arrives with detail
    // enrichment, and Grants.gov is a grants portal, so 'grant' is the honest
    // default rather than 'other'.
    expect(grantsGovKind(null)).toBe('grant');
  });

  test('a procurement contract on Grants.gov is `other`, not a grant', () => {
    expect(grantsGovKind('Procurement Contract')).toBe('other');
  });
});

describe('normalizeKindText', () => {
  test('flattens punctuation and case', () => {
    expect(normalizeKindText('Combined Synopsis/Solicitation')).toBe(
      'combined synopsis solicitation',
    );
    expect(normalizeKindText('  Sources   Sought  ')).toBe('sources sought');
  });
});
