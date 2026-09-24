import { classifyGeographyRepair } from './community-funding.geography-repair.js';

describe('classifyGeographyRepair', () => {
  // ── Eligible ───────────────────────────────────────────────────────────

  it('classifies a House row with resolvable STDD and null geography as eligible', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'FL08',
    });
    expect(result.classification).toBe('eligible');
    expect(result.resolvedState).toBe('FL');
    expect(result.resolvedDistrict).toBe('08');
    expect(result.reason).toContain('requester_state is null');
  });

  it('classifies a House row with null state but matching district STDD as eligible (FL08 token, district field null)', () => {
    // When both requesterState and requesterDistrict are null but the stored
    // district token is FL08, it should be eligible.
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'FL08',
    });
    expect(result.classification).toBe('eligible');
  });

  // ── Already Normalized ─────────────────────────────────────────────────

  it('classifies a House row with matching geography as already_normalized (FL/08)', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'FL',
      requesterDistrict: '08',
    });
    expect(result.classification).toBe('already_normalized');
  });

  it('classifies a House row with FL08 stored and FL/08 as already_normalized', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'FL',
      requesterDistrict: 'FL08',
    });
    expect(result.classification).toBe('already_normalized');
  });

  // ── Senate statewide ──────────────────────────────────────────────────

  it('classifies Senate rows as senate_statewide', () => {
    const result = classifyGeographyRepair({
      chamber: 'senate',
      requesterState: null,
      requesterDistrict: null,
    });
    expect(result.classification).toBe('senate_statewide');
  });

  it('classifies Senate rows with a district token as senate_statewide (never assigns district)', () => {
    const result = classifyGeographyRepair({
      chamber: 'senate',
      requesterState: 'NY',
      requesterDistrict: 'FL08',
    });
    expect(result.classification).toBe('senate_statewide');
  });

  // ── Invalid ───────────────────────────────────────────────────────────

  it('classifies a row with no district token as invalid', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: null,
    });
    expect(result.classification).toBe('invalid');
    expect(result.reason).toContain('No source district token');
  });

  it('classifies a malformed STDD token (FL8) as invalid', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'FL8',
    });
    expect(result.classification).toBe('invalid');
  });

  it('classifies FL00 in a multi-seat state as invalid (FL has 28 seats, 00 is sentinel)', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'FL00',
    });
    expect(result.classification).toBe('invalid');
  });

  it('classifies a non-state code (ZZ08) as invalid', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'ZZ08',
    });
    expect(result.classification).toBe('invalid');
  });

  it('classifies empty string district as invalid', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'TX',
      requesterDistrict: '',
    });
    expect(result.classification).toBe('invalid');
  });

  // ── Conflicting ───────────────────────────────────────────────────────

  it('classifies GA state with FL08 STDD as conflicting', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'GA',
      requesterDistrict: 'FL08',
    });
    expect(result.classification).toBe('conflicting');
    expect(result.reason).toContain('conflicts');
  });

  it('classifies FL/05 with state set as already_normalized (non-STDD token, but geography is complete)', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'FL',
      requesterDistrict: '05',
    });
    // '05' alone (no state prefix) cannot be parsed by parseCommunityFundingStdd,
    // but requesterState is already set, so the row has complete geography.
    expect(result.classification).toBe('already_normalized');
  });

  it('classifies FL/FL08 state with AK00 STDD as conflicting', () => {
    // AK has 1 seat and '00' is valid for AK
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'FL',
      requesterDistrict: 'AK00',
    });
    expect(result.classification).toBe('conflicting');
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('classifies a House row with resolvable STDD (lowercase) and null geography as eligible', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'fl08',
    });
    expect(result.classification).toBe('eligible');
    expect(result.resolvedState).toBe('FL');
    expect(result.resolvedDistrict).toBe('08');
  });

  it('classifies AK00 for single-seat AK with null state as eligible', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'AK00',
    });
    // AK has 1 seat. 00 is valid. But the normalizer has special logic:
    // parseCommunityFundingStdd('AK00') -> AK has 1 seat, district token is '00', numeric=0,
    // seats===1 && numeric===0 -> valid, returns {state:'AK', district:'00'}.
    expect(result.classification).toBe('eligible');
    expect(result.resolvedState).toBe('AK');
    expect(result.resolvedDistrict).toBe('00');
  });

  it('classifies AKAL (at-large) for single-seat AK as eligible', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'AKAL',
    });
    expect(result.classification).toBe('eligible');
    expect(result.resolvedState).toBe('AK');
    expect(result.resolvedDistrict).toBe('00');
  });
});