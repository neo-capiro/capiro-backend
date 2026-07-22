import { describe, expect, test } from 'vitest';
import {
  chamberCategory,
  normalizeCongress,
  normalizeState,
  partyShort,
  profileHref,
} from './targets-normalize.js';
import type { DirectoryEntry } from '../directory/directoryData.js';
import type { StateLegislatorRow } from '../directory/StateLegislatorDirectory.js';

describe('TargetsTab cross-directory normalization', () => {
  test('partyShort collapses both single-char and full-word parties', () => {
    expect(partyShort('R')).toBe('R');
    expect(partyShort('D')).toBe('D');
    expect(partyShort('Republican')).toBe('R');
    expect(partyShort('Democratic')).toBe('D');
    expect(partyShort('Independent')).toBe('I');
    expect(partyShort('')).toBeNull();
    expect(partyShort(null)).toBeNull();
    expect(partyShort(undefined)).toBeNull();
  });

  test('chamberCategory unifies congress and state chamber vocabularies', () => {
    expect(chamberCategory('House')).toBe('House');
    expect(chamberCategory('Senate')).toBe('Senate');
    expect(chamberCategory('lower')).toBe('House');
    expect(chamberCategory('upper')).toBe('Senate');
    expect(chamberCategory('assembly')).toBe('House');
    expect(chamberCategory(null)).toBeNull();
    expect(chamberCategory('')).toBeNull();
  });

  test('profileHref routes to the correct directory profile (state id slash-encoded)', () => {
    expect(profileHref('congress', 'R000575')).toBe('/directory/members/R000575');
    expect(profileHref('state', 'ocd-person/abc-123')).toBe(
      '/directory/state-legislators/ocd-person%2Fabc-123',
    );
  });

  test('normalizeCongress maps a DirectoryEntry (House district-qualified state)', () => {
    const entry = {
      id: 'R000575',
      fullName: 'Rep. Rogers, Mike',
      party: 'R',
      chamber: 'House',
      state: 'AL',
      district: 'AL-3',
      committees: ['Armed Services'],
      matchedStaff: [{ fullName: 'Grace Hopper', title: 'Staff Director' }],
    } as unknown as DirectoryEntry;
    const n = normalizeCongress(entry);
    expect(n).toMatchObject({
      id: 'R000575',
      sourceDirectory: 'congress',
      name: 'Rep. Rogers, Mike',
      partyShort: 'R',
      stateCode: 'AL',
      stateLabel: 'AL-3',
      chamberLabel: 'House',
      committee: 'Armed Services',
    });
    expect(n.staffMatch).toEqual({ fullName: 'Grace Hopper', title: 'Staff Director' });
  });

  test('normalizeState maps a StateLegislatorRow (full-word party, upper chamber)', () => {
    const row = {
      id: 'ocd-person/xyz',
      name: 'Sen. Ada Smith',
      state: 'CA',
      chamber: 'upper',
      district: '12',
      party: 'Democratic',
      committeeCount: 3,
      billCount: null,
      enactedCount: null,
    } as unknown as StateLegislatorRow;
    const n = normalizeState(row);
    expect(n).toMatchObject({
      id: 'ocd-person/xyz',
      sourceDirectory: 'state',
      name: 'Sen. Ada Smith',
      party: 'Democratic',
      partyShort: 'D',
      stateCode: 'CA',
      stateLabel: 'CA-12',
      chamberLabel: 'Senate',
      committee: null,
      staffMatch: null,
    });
  });

  test('normalizers never throw on sparse/null-heavy rows', () => {
    expect(() => normalizeCongress({ id: 'x' } as unknown as DirectoryEntry)).not.toThrow();
    expect(() => normalizeState({ id: 'y', name: 'Y' } as unknown as StateLegislatorRow)).not.toThrow();
    const sparse = normalizeState({ id: 'z', name: 'Z' } as unknown as StateLegislatorRow);
    expect(sparse.partyShort).toBeNull();
    expect(sparse.chamberLabel).toBeNull();
  });
});
