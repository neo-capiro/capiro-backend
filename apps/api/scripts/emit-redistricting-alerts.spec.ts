import {
  buildDedupeKey,
  classifyEvent,
  isoDate,
  severityFor,
  toFacilityDistrictCode,
  type PriorAlertSnapshot,
} from './emit-redistricting-alerts.js';

describe('toFacilityDistrictCode (bridging LegiStorm district_no -> client_facilities.congressionalDistrict)', () => {
  it('returns "00" for an at-large state, regardless of what raw district_no LegiStorm reports', () => {
    // Live-verified 2026-07-24: LegiStorm reports district_no="1" even for a
    // jurisdiction's sole House seat (DC's non-voting delegate) — there is
    // no vendor-side at-large sentinel. isAtLarge must come from a separate,
    // dynamic count, not from trusting districtNo itself.
    expect(toFacilityDistrictCode('1', true)).toBe('00');
  });

  it('zero-pads a single-digit district for a multi-district state', () => {
    expect(toFacilityDistrictCode('2', false)).toBe('02');
  });

  it('leaves a two-digit district unchanged', () => {
    expect(toFacilityDistrictCode('25', false)).toBe('25');
  });

  it('returns null for a Senate row (no House district code at all)', () => {
    expect(toFacilityDistrictCode(null, false)).toBeNull();
  });
});

describe('severityFor', () => {
  it('is always "notable" — never emit-state-changes.ts\'s "high"/"medium" (a known vocabulary-drift bug)', () => {
    expect(severityFor()).toBe('notable');
    expect(severityFor()).not.toBe('high');
    expect(severityFor()).not.toBe('medium');
  });
});

describe('isoDate', () => {
  it('formats to YYYY-MM-DD', () => {
    expect(isoDate(new Date('2027-01-03T00:00:00Z'))).toBe('2027-01-03');
  });
  it('returns null for a null date', () => {
    expect(isoDate(null)).toBeNull();
  });
});

describe('classifyEvent', () => {
  const snapshot = (overrides: Partial<PriorAlertSnapshot> = {}): PriorAlertSnapshot => ({
    effectiveDate: '2027-01-03',
    enactedDate: '2025-08-28',
    districtNo: '25',
    name: '25th Congressional District of Texas',
    ...overrides,
  });

  it('is a "new map" with changed=true when there is no prior alert for this district', () => {
    const result = classifyEvent(undefined, snapshot());
    expect(result.event).toBe('district_new_map');
    expect(result.changed).toBe(true);
  });

  it('is changed=false on an exact re-run with nothing different — the idempotency-critical case', () => {
    // This is the bug caught while building this script: an earlier design
    // classified purely on "have we seen this district before", which would
    // have relabeled an UNCHANGED district as "boundary_changed" on every
    // single re-run (since a prior alert always exists after the first run),
    // producing a fresh dedupeKey (different changeType) and a duplicate
    // alert each time. changed must be false here, or the whole
    // "re-running twice creates zero duplicates" guarantee breaks.
    const prior = snapshot();
    const current = snapshot();
    const result = classifyEvent(prior, current);
    expect(result.changed).toBe(false);
  });

  it('is "boundary changed" with changed=true when the effective date differs from the prior alert', () => {
    const prior = snapshot({ effectiveDate: '2027-01-03' });
    const current = snapshot({ effectiveDate: '2027-06-01' });
    const result = classifyEvent(prior, current);
    expect(result.event).toBe('district_boundary_changed');
    expect(result.changed).toBe(true);
  });

  it('is "boundary changed" with changed=true when only the name differs', () => {
    const prior = snapshot({ name: '25th Congressional District of Texas' });
    const current = snapshot({ name: '25th Congressional District of Texas (revised)' });
    expect(classifyEvent(prior, current)).toEqual({
      event: 'district_boundary_changed',
      changed: true,
    });
  });
});

describe('buildDedupeKey', () => {
  it('is deterministic and includes state, code, event, and effective date', () => {
    expect(buildDedupeKey('TX', '25', 'district_new_map', '2027-01-03')).toBe(
      'redistricting:TX-25:district_new_map:2027-01-03',
    );
  });

  it('falls back to "unknown" for a null effective date rather than crashing or colliding across dates', () => {
    expect(buildDedupeKey('DC', '00', 'district_new_map', null)).toBe(
      'redistricting:DC-00:district_new_map:unknown',
    );
  });

  it('produces a DIFFERENT key for district_new_map vs district_boundary_changed on the same district', () => {
    const a = buildDedupeKey('TX', '25', 'district_new_map', '2027-01-03');
    const b = buildDedupeKey('TX', '25', 'district_boundary_changed', '2027-06-01');
    expect(a).not.toBe(b);
  });
});
