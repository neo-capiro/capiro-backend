import { classifyGeographyRepair } from './community-funding.geography-repair.js';

describe('classifyGeographyRepair', () => {
  // ── Eligible ───────────────────────────────────────────────────────────

  it('classifies a House row with resolvable STDD and null geography as eligible', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'FL08',
      projectState: 'FL',
    });
    expect(result.classification).toBe('eligible');
    expect(result.resolvedState).toBe('FL');
    expect(result.resolvedDistrict).toBe('08');
    expect(result.reason).toContain('requester_state is null');
  });

  it('classifies a House row with resolvable STDD lowercase and null geography as eligible', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'fl08',
      projectState: 'FL',
    });
    expect(result.classification).toBe('eligible');
    expect(result.resolvedState).toBe('FL');
    expect(result.resolvedDistrict).toBe('08');
  });

  it('classifies a House row with at-large token (AKAL) as eligible', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'AKAL',
      projectState: 'AK',
    });
    expect(result.classification).toBe('eligible');
    expect(result.resolvedState).toBe('AK');
    expect(result.resolvedDistrict).toBe('00');
  });

  it('classifies AK00 for single-seat AK with null state as eligible', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'AK00',
      projectState: 'AK',
    });
    expect(result.classification).toBe('eligible');
    expect(result.resolvedState).toBe('AK');
    expect(result.resolvedDistrict).toBe('00');
  });

  // ── Already Normalized ─────────────────────────────────────────────────

  it('classifies a House row with matching geography as already_normalized (FL/08)', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'FL',
      requesterDistrict: '08',
      projectState: 'FL',
    });
    expect(result.classification).toBe('already_normalized');
    expect(result.resolvedState).toBe('FL');
    expect(result.resolvedDistrict).toBe('08');
  });

  it('classifies a House row with FL08 stored and FL/08 as already_normalized', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'FL',
      requesterDistrict: 'FL08',
      projectState: 'FL',
    });
    expect(result.classification).toBe('already_normalized');
    expect(result.resolvedState).toBe('FL');
    expect(result.resolvedDistrict).toBe('08');
  });

  it('classifies a non-STDD token (05) with state already set as already_normalized', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'FL',
      requesterDistrict: '05',
      projectState: 'FL',
    });
    expect(result.classification).toBe('already_normalized');
    expect(result.resolvedState).toBe('FL');
    expect(result.resolvedDistrict).toBe('05');
  });

  // ── Senate statewide ──────────────────────────────────────────────────

  it('classifies Senate rows as senate_statewide', () => {
    const result = classifyGeographyRepair({
      chamber: 'senate',
      requesterState: null,
      requesterDistrict: null,
      projectState: 'NY',
    });
    expect(result.classification).toBe('senate_statewide');
  });

  it('classifies Senate rows with a district token as senate_statewide', () => {
    const result = classifyGeographyRepair({
      chamber: 'senate',
      requesterState: 'NY',
      requesterDistrict: 'FL08',
      projectState: 'NY',
    });
    expect(result.classification).toBe('senate_statewide');
  });

  // ── Invalid ───────────────────────────────────────────────────────────

  it('classifies a row with no token and no project state as invalid', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: null,
      projectState: null,
    });
    expect(result.classification).toBe('invalid');
    expect(result.reason).toContain('No source district token');
  });

  it('classifies a malformed STDD token with no projectState as invalid', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'FL8',
      projectState: null,
    });
    expect(result.classification).toBe('invalid');
    expect(result.resolvedState).toBeNull();
  });

  it('classifies a non-state code (ZZ08) with no projectState as invalid', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'ZZ08',
      projectState: null,
    });
    expect(result.classification).toBe('invalid');
    expect(result.resolvedState).toBeNull();
  });

  // ── Conflicting ───────────────────────────────────────────────────────

  it('classifies GA state with FL08 STDD as conflicting (conflictReason)', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'GA',
      requesterDistrict: 'FL08',
      projectState: 'GA',
    });
    expect(result.classification).toBe('conflicting');
    expect(result.reason).toContain('conflicts');
    expect(result.resolvedState).toBeNull();
    expect(result.resolvedDistrict).toBeNull();
  });

  it('classifies FL state with AK00 STDD as conflicting (state mismatch)', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'FL',
      requesterDistrict: 'AK00',
      projectState: 'FL',
    });
    expect(result.classification).toBe('conflicting');
    expect(result.reason).toContain('conflicts');
  });

  // ── Edge cases: normalizer resolves via projectState ──────────────────

  it('classifies a row with a malformed token (FL8) but projectState=FL as invalid (no source-backed token)', () => {
    // FL8 cannot be parsed as STDD. Even though projectState 'FL' provides
    // a state via the normalizer's fallback, product rules forbid inventing
    // attribution — the token itself must resolve.
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'FL8',
      projectState: 'FL',
    });
    expect(result.classification).toBe('invalid');
    expect(result.resolvedState).toBeNull();
    expect(result.reason).toContain('No source-backed district token');
  });

  it('classifies a row with null token but projectState=CA as invalid (no source-backed token)', () => {
    // No district token at all — projectState alone is not a valid source-backed
    // geography. Product rules forbid inventing attribution.
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: null,
      projectState: 'CA',
    });
    expect(result.classification).toBe('invalid');
    expect(result.resolvedState).toBeNull();
    expect(result.reason).toContain('No source-backed district token');
  });

  it('classifies a row with empty token but requesterState set as already_normalized', () => {
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: 'TX',
      requesterDistrict: '',
      projectState: 'TX',
    });
    expect(result.classification).toBe('already_normalized');
    expect(result.resolvedState).toBe('TX');
  });

  // ── FL00 sentinel (multi-seat state) ──────────────────────────────────

  it('classifies FL00 in a multi-seat state with projectState=FL as invalid (no source-backed token)', () => {
    // FL has 28 seats; FL00 is out of range, so parseCommunityFundingStdd returns null.
    // Even though the normalizer fallback can derive state=FL from projectState,
    // the token itself does not resolve — must be invalid.
    const result = classifyGeographyRepair({
      chamber: 'house',
      requesterState: null,
      requesterDistrict: 'FL00',
      projectState: 'FL',
    });
    expect(result.classification).toBe('invalid');
    expect(result.resolvedState).toBeNull();
    expect(result.reason).toContain('No source-backed district token');
  });
});