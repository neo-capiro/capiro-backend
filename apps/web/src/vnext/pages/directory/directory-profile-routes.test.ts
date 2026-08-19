import { describe, expect, test } from 'vitest';
import { matchDirectoryProfilePath } from './directory-routes.js';
import { isVNextDirectoryPath } from './VNextDirectoryRoutes.js';

/**
 * Route-claim contract for the five deep-linkable directory profile routes
 * (Phase 2 old-UI purge). The matcher must mirror the canonical App.tsx param
 * routes exactly: one non-empty segment per `:param` (two for districts),
 * decoded the same way `useParams` would have decoded them.
 */
describe('matchDirectoryProfilePath', () => {
  test('matches the five canonical profile shapes', () => {
    expect(matchDirectoryProfilePath('/directory/members/member-500')).toEqual({
      kind: 'member',
      memberId: 'member-500',
    });
    expect(matchDirectoryProfilePath('/directory/staff/staff-800')).toEqual({
      kind: 'staff',
      staffId: 'staff-800',
    });
    expect(matchDirectoryProfilePath('/directory/committees/committee-100')).toEqual({
      kind: 'committee',
      committeeId: 'committee-100',
    });
    expect(matchDirectoryProfilePath('/directory/districts/WY/00')).toEqual({
      kind: 'district',
      state: 'WY',
      districtNo: '00',
    });
  });

  test('decodes an OpenStates id back to its raw "ocd-person/…" form, like useParams did', () => {
    expect(matchDirectoryProfilePath('/directory/state-legislators/ocd-person%2Fabc-123')).toEqual({
      kind: 'stateLegislator',
      id: 'ocd-person/abc-123',
    });
  });

  test('does not claim the list surfaces that share the prefix', () => {
    expect(matchDirectoryProfilePath('/directory')).toBeNull();
    expect(matchDirectoryProfilePath('/directory/state-legislators')).toBeNull();
    expect(matchDirectoryProfilePath('/directory/congressional-staff')).toBeNull();
    expect(matchDirectoryProfilePath('/directory/committee-staff')).toBeNull();
    expect(matchDirectoryProfilePath('/directory/department-of-war')).toBeNull();
  });

  test('rejects shapes the canonical :param routes would not have matched', () => {
    // deeper than one segment
    expect(matchDirectoryProfilePath('/directory/members/a/b')).toBeNull();
    // empty param
    expect(matchDirectoryProfilePath('/directory/members/')).toBeNull();
    // districts needs exactly two segments
    expect(matchDirectoryProfilePath('/directory/districts/WY')).toBeNull();
    expect(matchDirectoryProfilePath('/directory/districts/WY/00/x')).toBeNull();
    // unknown section
    expect(matchDirectoryProfilePath('/directory/nonsense/x')).toBeNull();
    // unrelated tree
    expect(matchDirectoryProfilePath('/clients')).toBeNull();
  });

  test('tolerates a trailing slash the way the router does', () => {
    expect(matchDirectoryProfilePath('/directory/members/member-500/')).toEqual({
      kind: 'member',
      memberId: 'member-500',
    });
  });
});

describe('isVNextDirectoryPath (profiles claimed)', () => {
  test('claims all five profile routes on top of the list surfaces', () => {
    for (const path of [
      '/directory',
      '/directory/congressional-staff',
      '/directory/committee-staff',
      '/directory/department-of-war',
      '/directory/state-legislators',
      '/directory/members/member-500',
      '/directory/staff/staff-800',
      '/directory/committees/committee-100',
      '/directory/state-legislators/ocd-person%2Fabc-123',
      '/directory/districts/WY/00',
    ]) {
      expect(isVNextDirectoryPath(path), path).toBe(true);
    }
  });

  test('still falls through for non-directory and unknown directory paths', () => {
    expect(isVNextDirectoryPath('/clients')).toBe(false);
    expect(isVNextDirectoryPath('/directory/nonsense/x')).toBe(false);
  });
});
