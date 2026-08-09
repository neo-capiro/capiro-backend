import {
  createManualTargetLocator,
  createResolvedTargetRefV1,
} from '../../capabilities/targets/outreach-target.contract.js';
import type { TargetCriteriaV1 } from '../state/outreach-campaign-spec.v1.js';
import { deriveOutreachTargetCoverage } from './outreach-target-coverage.service.js';

function target(input: {
  id: string;
  email?: string | null;
  roleStatus?: 'current' | 'historical' | 'unknown';
  profileStatus?: 'complete' | 'limited' | 'unavailable';
  source?: 'manual' | 'directory_staff';
  chamber?: string | null;
  state?: string | null;
  committees?: string[];
}) {
  const locator =
    input.source === 'directory_staff'
      ? ({ source: 'directory_staff', id: `staff-${input.id}` } as const)
      : createManualTargetLocator({
          id: input.id,
          name: `Person ${input.id}`,
          email: input.email ?? null,
        });
  return createResolvedTargetRefV1({
    locator,
    displayName: `Person ${input.id}`,
    email: input.email ?? null,
    phone: null,
    title: input.source === 'directory_staff' ? 'Professional Staff Member' : 'Member',
    organization: 'Example Office',
    clientId: null,
    jurisdiction: {
      governmentLevel: input.source === 'directory_staff' ? 'federal' : 'unknown',
      chamber: input.chamber ?? null,
      state: input.state ?? null,
      district: null,
      committees: input.committees ?? [],
      issueAreas: [],
    },
    roleStatus: input.roleStatus ?? 'current',
    emailStatus: input.email ? 'available' : 'missing',
    profileStatus: input.profileStatus ?? 'complete',
    sourceSnapshot: {
      system: input.source === 'directory_staff' ? 'capiro_directory' : 'user_supplied',
      version: 'v1',
      lastVerifiedAt: '2026-08-08T00:00:00.000Z',
    },
  });
}

const criteria: TargetCriteriaV1 = {
  notes: null,
  governmentLevels: ['federal'],
  chambers: ['house'],
  committees: ['Armed Services'],
  agencies: [],
  states: ['VA'],
  relationshipPreference: 'any',
  includeStaff: true,
  includePrincipals: true,
};

describe('deriveOutreachTargetCoverage', () => {
  it('returns an explicit empty-state coverage result', () => {
    const result = deriveOutreachTargetCoverage(criteria, []);
    expect(result.status).toBe('empty');
    expect(result.selectedCount).toBe(0);
    expect(result.gaps.map((gap) => gap.code)).toEqual([
      'CHAMBER_COVERAGE_MISSING',
      'COMMITTEE_COVERAGE_MISSING',
      'NO_TARGETS',
      'PRINCIPAL_COVERAGE_MISSING',
      'STAFF_COVERAGE_MISSING',
      'STATE_COVERAGE_MISSING',
    ]);
  });

  it('marks missing email and historical role as non-sendable', () => {
    const result = deriveOutreachTargetCoverage(null, [
      target({
        id: '00000000-0000-4000-8000-000000000001',
        email: null,
        roleStatus: 'historical',
      }),
    ]);
    expect(result.health[0]).toMatchObject({
      readyForDrafting: false,
      readyForSending: false,
      healthCodes: ['EMAIL_MISSING', 'ROLE_HISTORICAL'],
    });
  });

  it('surfaces duplicate email identities instead of silently merging them', () => {
    const one = target({
      id: '00000000-0000-4000-8000-000000000002',
      email: 'same@example.test',
    });
    const two = target({
      id: '00000000-0000-4000-8000-000000000003',
      email: 'same@example.test',
    });
    const result = deriveOutreachTargetCoverage(null, [one, two]);
    expect(result.duplicateEmailGroups).toEqual([
      { email: 'same@example.test', targetKeys: [one.targetKey, two.targetKey] },
    ]);
    expect(result.health.every((entry) => entry.healthCodes.includes('DUPLICATE_EMAIL'))).toBe(true);
    expect(result.sendReadyCount).toBe(0);
  });

  it('recognizes staff, principal, chamber, committee and state coverage', () => {
    const result = deriveOutreachTargetCoverage(criteria, [
      target({
        id: '00000000-0000-4000-8000-000000000004',
        email: 'member@example.test',
        chamber: 'House',
        state: 'VA',
        committees: ['House Armed Services Committee'],
      }),
      target({
        id: 'staff-1',
        email: 'staff@example.test',
        source: 'directory_staff',
        chamber: 'House',
        state: 'VA',
        committees: ['Armed Services'],
      }),
    ]);
    expect(result.status).toBe('complete');
    expect(result.staffCount).toBe(1);
    expect(result.principalCount).toBe(1);
    expect(result.gaps).toEqual([]);
    expect(result.sendReadyCount).toBe(2);
  });

  it('does not claim an existing relationship without live relationship analysis', () => {
    const relationshipCriteria: TargetCriteriaV1 = {
      ...criteria,
      relationshipPreference: 'existing',
      includeStaff: false,
    };
    const result = deriveOutreachTargetCoverage(relationshipCriteria, [
      target({
        id: '00000000-0000-4000-8000-000000000005',
        email: 'member@example.test',
        chamber: 'House',
        state: 'VA',
        committees: ['Armed Services'],
      }),
    ]);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ code: 'EXISTING_RELATIONSHIP_NOT_PROVEN' }),
    );
  });
});
