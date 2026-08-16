import { describe, expect, test } from '@jest/globals';
import {
  clampResolutionConfidence,
  normalizeDomain,
  normalizeEntityIdentifier,
  normalizeEntityText,
  normalizeEntityType,
} from './entity-normalization.js';

describe('entity normalization', () => {
  test('normalizes aliases conservatively without dropping meaningful words', () => {
    expect(normalizeEntityText('  RTX Corporation, Inc.  ')).toBe('rtx corporation inc.');
    expect(normalizeEntityText('Raytheon & Technologies')).toBe('raytheon and technologies');
  });

  test('normalizes email and domain identifiers deterministically', () => {
    expect(normalizeEntityIdentifier('email', ' Neo@Capiro.AI ')).toBe('neo@capiro.ai');
    expect(normalizeDomain('https://www.KineticIndustries.com/about')).toBe(
      'kineticindustries.com',
    );
    expect(normalizeEntityIdentifier('official-domain', 'www.CAPIRO.ai')).toBe('capiro.ai');
  });

  test('normalizes authoritative registry identifiers without fuzzy matching', () => {
    expect(normalizeEntityIdentifier('uei', ' abc-12 3 ')).toBe('ABC123');
    expect(normalizeEntityIdentifier('cage', ' 1a2b3 ')).toBe('1A2B3');
    expect(normalizeEntityIdentifier('cik', '101829')).toBe('0000101829');
    expect(normalizeEntityIdentifier('bioguide-id', ' a000360 ')).toBe('A000360');
    expect(
      normalizeEntityIdentifier(
        'openstates-person-id',
        'ocd-person/ABC-123',
      ),
    ).toBe('ocd-person/abc-123');
  });

  test('rejects invalid identifier types, domains, and CIK values', () => {
    expect(() => normalizeEntityIdentifier('bad/type', 'value')).toThrow(
      'Invalid entity identifier type',
    );
    expect(() => normalizeDomain('not-a-domain')).toThrow('Invalid entity domain');
    expect(() => normalizeEntityIdentifier('email', 'not-an-email')).toThrow(
      'Invalid entity email',
    );
    expect(() => normalizeEntityIdentifier('cik', 'not-a-cik')).toThrow(
      'Invalid SEC CIK',
    );
  });

  test('normalizes entity type tokens and validates confidence', () => {
    expect(normalizeEntityType('Program Element')).toBe('program_element');
    expect(clampResolutionConfidence(0.98765)).toBe(0.9877);
    expect(() => clampResolutionConfidence(1.1)).toThrow(
      'Resolution confidence must be between 0 and 1',
    );
  });
});
