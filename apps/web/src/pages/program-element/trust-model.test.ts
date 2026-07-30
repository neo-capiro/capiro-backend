import { describe, expect, test } from 'vitest';
import {
  anyEnabledSecondaryFailed,
  buildSourceCoverageSummary,
  filterTabsForLineType,
  formatClaimWithCitation,
  formatPdocSourceLine,
  peSurfaceFailedAsEmpty,
  peWatchQueryEnabled,
  peWatchQueriesForTab,
  proofFingerprintLabel,
  parsePeWatchFy,
  parsePeWatchTab,
  readPeWatchUrlState,
  resolvePeSurfaceState,
  serializePeWatchUrlState,
  sourceFyFromPdocBook,
  yearsHaveStageValue,
} from './trust-model.js';
import type { FundingClaim } from '@capiro/shared/funding-claim';

describe('trust-model URL deep-link', () => {
  test('parses tab + fy and drops defaults on serialize', () => {
    expect(parsePeWatchTab('funding')).toBe('funding');
    expect(parsePeWatchTab('nope')).toBe('overview');
    expect(parsePeWatchFy('2027')).toBe(2027);
    expect(parsePeWatchFy('abc')).toBeNull();
    const qs = serializePeWatchUrlState({ tab: 'overview', fy: null });
    expect(qs).toBe('');
    expect(serializePeWatchUrlState({ tab: 'team', fy: 2026 })).toBe('tab=team&fy=2026');
    const state = readPeWatchUrlState(new URLSearchParams('tab=proof&fy=2025'));
    expect(state).toEqual({ tab: 'proof', fy: 2025 });
  });
});

describe('trust-model lazy tab queries', () => {
  test('initial overview does not enable hidden-tab buckets', () => {
    expect(peWatchQueryEnabled('overview', 'sources', true)).toBe(false);
    expect(peWatchQueryEnabled('overview', 'personnel', true)).toBe(false);
    expect(peWatchQueryEnabled('overview', 'contractors', true)).toBe(false);
    expect(peWatchQueryEnabled('overview', 'provisions', true)).toBe(false);
    expect(peWatchQueryEnabled('overview', 'bills', true)).toBe(true);
    expect(peWatchQueryEnabled('proof', 'sources', true)).toBe(true);
    expect(peWatchQueryEnabled('team', 'personnel', true)).toBe(true);
    expect(peWatchQueriesForTab('funding').has('procurementLines')).toBe(false);
    expect(peWatchQueryEnabled('funding', 'narrative', true)).toBe(true);
    expect(peWatchQueryEnabled('overview', 'narrative', true)).toBe(false);
  });

  test('filterTabsForLineType drops procurement on RDTE', () => {
    const tabs = filterTabsForLineType(
      ['overview', 'procurement', 'incumbents', 'team'],
      'RDTE_PE',
    );
    expect(tabs).toEqual(['overview', 'incumbents', 'team']);
    expect(filterTabsForLineType(['procurement'], 'PROCUREMENT_BLIN')).toEqual(['procurement']);
  });
});

describe('trust-model surface states', () => {
  test('failed is never treated as empty catalog', () => {
    expect(peSurfaceFailedAsEmpty('failed')).toBe(true);
    expect(peSurfaceFailedAsEmpty('not_found')).toBe(true);
    expect(peSurfaceFailedAsEmpty('complete_empty')).toBe(false);
    expect(
      resolvePeSurfaceState({
        peCodePresent: true,
        isLoading: false,
        isError: true,
        errorStatus: 500,
        hasDetail: false,
        yearCount: 0,
      }),
    ).toBe('failed');
    expect(
      resolvePeSurfaceState({
        peCodePresent: true,
        isLoading: false,
        isError: true,
        errorStatus: 404,
        hasDetail: false,
        yearCount: 0,
      }),
    ).toBe('not_found');
    expect(
      resolvePeSurfaceState({
        peCodePresent: true,
        isLoading: false,
        isError: false,
        hasDetail: true,
        yearCount: 0,
      }),
    ).toBe('not_ingested');
  });

  test('years present with all-null stages → complete_empty (reachable)', () => {
    expect(yearsHaveStageValue([{ request: null, enacted: null }])).toBe(false);
    expect(yearsHaveStageValue([{ request: 0, enacted: null }])).toBe(true);
    expect(yearsHaveStageValue([{ request: '12.5', enacted: null }])).toBe(true);
    expect(
      resolvePeSurfaceState({
        peCodePresent: true,
        isLoading: false,
        isError: false,
        hasDetail: true,
        yearCount: 2,
        hasStageValue: false,
      }),
    ).toBe('complete_empty');
    expect(
      resolvePeSurfaceState({
        peCodePresent: true,
        isLoading: false,
        isError: false,
        hasDetail: true,
        yearCount: 2,
        hasStageValue: true,
      }),
    ).toBe('complete_with_data');
    // Explicit $0 is still a real stage → complete_with_data, not empty.
    expect(
      resolvePeSurfaceState({
        peCodePresent: true,
        isLoading: false,
        isError: false,
        hasDetail: true,
        yearCount: 1,
        hasStageValue: yearsHaveStageValue([{ request: 0 }]),
      }),
    ).toBe('complete_with_data');
  });

  test('anyEnabledSecondaryFailed ignores disabled buckets', () => {
    expect(
      anyEnabledSecondaryFailed([
        { enabled: false, isError: true },
        { enabled: true, isError: false },
      ]),
    ).toBe(false);
    expect(
      anyEnabledSecondaryFailed([
        { enabled: true, isError: true },
        { enabled: false, isError: false },
      ]),
    ).toBe(true);
    expect(
      resolvePeSurfaceState({
        peCodePresent: true,
        isLoading: false,
        isError: false,
        hasDetail: true,
        yearCount: 1,
        hasStageValue: true,
        secondaryFailed: true,
      }),
    ).toBe('partial');
  });
});

describe('trust-model claim copy + P-40 source FY', () => {
  test('formatClaimWithCitation keeps zeros and skips null dollars', () => {
    const claim: FundingClaim = {
      value: 0,
      fiscalYear: 2027,
      stage: 'request',
      stageLabel: 'Request',
      legislativeVehicle: 'request',
      cycleClass: 'current',
      isProjection: false,
      unit: 'USD millions',
    };
    const text = formatClaimWithCitation({
      peCode: '0603270A',
      title: 'EW',
      claim,
      citation: 'last verified test',
    });
    expect(text).toContain('$0M');
    expect(text).toContain('Citation: last verified test');
    expect(
      formatClaimWithCitation({
        peCode: 'X',
        claim: { ...claim, value: null },
        citation: 'c',
      }),
    ).toBeNull();
  });

  test('P-40 source line does not hard-code FY2027', () => {
    expect(sourceFyFromPdocBook('Navy_FY2026_P40')).toBe(2026);
    expect(formatPdocSourceLine('Air_Force_P40')).toMatch(/source fiscal year not recorded/i);
    expect(formatPdocSourceLine('FY2025_Army_P40')).toContain('FY2025');
    expect(formatPdocSourceLine('FY2025_Army_P40')).not.toContain('FY2027');
  });

  test('fingerprint label is honest about bytes vs archive', () => {
    const fp = proofFingerprintLabel('abcdef0123456789deadbeef');
    expect(fp?.short).toMatch(/^sha256 /);
    expect(fp?.title).toMatch(/not a substitute for the full source archive/i);
    expect(proofFingerprintLabel(null)).toBeNull();
  });

  test('coverage summary is explicit', () => {
    const chips = buildSourceCoverageSummary({
      yearCount: 3,
      sourceCount: 0,
      billCount: 2,
      hasDescription: true,
    });
    expect(chips.join(' ')).toMatch(/Citations: none/);
    expect(chips.join(' ')).toMatch(/Bills linked: 2/);
  });
});
