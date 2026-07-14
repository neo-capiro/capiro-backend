import { describe, expect, test } from '@jest/globals';
import memberPage from './__fixtures__/member-page.json';
import officePage from './__fixtures__/office-page.json';
import retiredIds from './__fixtures__/retired-ids.json';
import staffPage from './__fixtures__/staff-page.json';
import {
  getLegiStormMemberId,
  getLegiStormOfficeId,
  getLegiStormStaffId,
  hasRequiredMemberIdentity,
  hasRequiredOfficeIdentity,
  hasRequiredStaffIdentity,
  retainVendorRecord,
} from './legistorm-types.js';

const memberRecord = memberPage[0]!;
const staffRecord = staffPage[0]!;
const officeRecord = officePage[0]!;

describe('LegiStorm source contract', () => {
  test('extracts stable numeric keys from live-shaped records', () => {
    expect(getLegiStormMemberId(memberRecord)).toBe(900001);
    expect(getLegiStormStaffId(staffRecord)).toBe(800001);
    expect(getLegiStormOfficeId(officeRecord)).toBe(970001);
  });

  test('rejects missing, string, non-integer, and non-positive stable keys', () => {
    expect(getLegiStormMemberId({ member: { member_id: '900001' } })).toBeNull();
    expect(getLegiStormStaffId({ staff: { id: 1.25 } })).toBeNull();
    expect(getLegiStormOfficeId({ office: { office_id: 0 } })).toBeNull();
    expect(getLegiStormMemberId({ member: { member_id: Number.MAX_SAFE_INTEGER + 1 } })).toBeNull();
    expect(getLegiStormMemberId({})).toBeNull();
  });

  test('requires member id, live bioguide_id spelling, and profile', () => {
    expect(hasRequiredMemberIdentity(memberRecord)).toBe(true);
    expect(
      hasRequiredMemberIdentity({
        member: { member_id: 1, biogude_id: 'X000001', profile: {} },
      }),
    ).toBe(false);
    expect(hasRequiredMemberIdentity({ member: { member_id: 1, bioguide_id: 'X000001' } })).toBe(
      false,
    );
  });

  test('guards required staff and office identity without narrowing optional vendor data', () => {
    expect(hasRequiredStaffIdentity(staffRecord)).toBe(true);
    expect(hasRequiredStaffIdentity({ staff: { id: 1 } })).toBe(false);
    expect(hasRequiredOfficeIdentity(officeRecord)).toBe(true);
    expect(hasRequiredOfficeIdentity({ office: { office_id: 1 } })).toBe(false);
  });

  test('models the combined office file as an array with optional source sections', () => {
    expect(Array.isArray(officePage)).toBe(true);
    expect(officeRecord).toHaveProperty('contacts');
    expect(officeRecord).toHaveProperty('leadership_offices');
    expect(officeRecord).toHaveProperty('roster_snapshot');
    expect(memberRecord).toHaveProperty('leaderships');
  });

  test('accepts valid records when optional source sections are omitted', () => {
    const { leaderships: _leaderships, ...memberWithoutLeaderships } = memberRecord;
    const {
      contacts: _contacts,
      leadership_offices: _leadershipOffices,
      roster_snapshot: _rosterSnapshot,
      ...officeWithoutOptionalSections
    } = officeRecord;

    expect(hasRequiredMemberIdentity(memberWithoutLeaderships)).toBe(true);
    expect(hasRequiredOfficeIdentity(officeWithoutOptionalSections)).toBe(true);
  });

  test('identity guards narrow validated nested fields for downstream code', () => {
    const memberCandidate: unknown = memberRecord;
    const staffCandidate: unknown = staffRecord;
    const officeCandidate: unknown = officeRecord;

    if (!hasRequiredMemberIdentity(memberCandidate)) throw new Error('member fixture is invalid');
    if (!hasRequiredStaffIdentity(staffCandidate)) throw new Error('staff fixture is invalid');
    if (!hasRequiredOfficeIdentity(officeCandidate)) throw new Error('office fixture is invalid');

    const memberId: number = memberCandidate.member.member_id;
    const bioguideId: string = memberCandidate.member.bioguide_id;
    const staffId: number = staffCandidate.staff.id;
    const officeId: number = officeCandidate.office.office_id;

    expect({ memberId, bioguideId, staffId, officeId }).toEqual({
      memberId: 900001,
      bioguideId: 'X000001',
      staffId: 800001,
      officeId: 970001,
    });
  });

  test('retains unknown nested fields and money-like strings without coercion', () => {
    const retained = retainVendorRecord(memberRecord);
    expect(retained).toEqual(memberRecord);
    expect(retained).toBe(memberRecord);
    expect(
      (retained.future_vendor_extension as { money_like_string: unknown }).money_like_string,
    ).toBe('100.00');
  });

  test('represents retired IDs as positive numeric identifiers', () => {
    expect(retiredIds).toEqual([700001, 700002]);
    expect(retiredIds.every((id) => Number.isInteger(id) && id > 0)).toBe(true);
  });
});
