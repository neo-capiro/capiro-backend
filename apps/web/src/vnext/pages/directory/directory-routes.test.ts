import { describe, expect, test } from 'vitest';
import {
  DIRECTORY_LEGACY_ROUTE,
  DIRECTORY_PROFILE_ROUTES,
  DIRECTORY_ROUTES,
  DIRECTORY_TABS,
  isDirectoryListPath,
  resolveLegacyDirectoryTarget,
} from './directory-routes.js';
import { VNEXT_ROUTE_GAPS, VNEXT_ROUTE_MANIFEST } from '../../adapters/routes/routeManifest.js';

describe('Directory vNext route contract', () => {
  test('declares the four first-class list routes from the handoff', () => {
    expect(Object.values(DIRECTORY_ROUTES)).toEqual([
      '/directory/congressional-staff',
      '/directory/committee-staff',
      '/directory/department-of-war',
      '/directory/state-legislators',
    ]);
  });

  test('exposes one tab per list route, in screen order', () => {
    expect(DIRECTORY_TABS.map((tab) => tab.path)).toEqual(Object.values(DIRECTORY_ROUTES));
    expect(DIRECTORY_TABS.map((tab) => tab.label)).toEqual([
      'Congressional Staff',
      'Committee Staff',
      'Department of War',
      'State Legislators',
    ]);
  });

  test('legacy /directory resolves to Congressional Staff', () => {
    expect(DIRECTORY_LEGACY_ROUTE).toBe('/directory');
    expect(resolveLegacyDirectoryTarget('')).toBe('/directory/congressional-staff');
  });

  test('resolving legacy /directory preserves the query string', () => {
    expect(resolveLegacyDirectoryTarget('?q=defense&chamber=Senate')).toBe(
      '/directory/congressional-staff?q=defense&chamber=Senate',
    );
    // A bare search (no leading ?) and an empty "?" are both handled.
    expect(resolveLegacyDirectoryTarget('q=defense')).toBe('/directory/congressional-staff?q=defense');
    expect(resolveLegacyDirectoryTarget('?')).toBe('/directory/congressional-staff');
  });

  test('preserves the existing canonical profile destinations', () => {
    // Congressional AND committee staff share one identity and one profile URL:
    // appearing in Committee Staff must never mint a second record.
    expect(DIRECTORY_PROFILE_ROUTES.staff('staff-800')).toBe('/directory/staff/staff-800');
    expect(DIRECTORY_PROFILE_ROUTES.member('m-1')).toBe('/directory/members/m-1');
    expect(DIRECTORY_PROFILE_ROUTES.committee('c-1')).toBe('/directory/committees/c-1');
    expect(DIRECTORY_PROFILE_ROUTES.departmentOfWarPerson('p-9')).toBe(
      '/directory/department-of-war/p-9',
    );
  });

  test('encodes ids that contain a slash into one path segment', () => {
    // OpenStates ids look like "ocd-person/<uuid>".
    expect(DIRECTORY_PROFILE_ROUTES.stateLegislator('ocd-person/abc-123')).toBe(
      '/directory/state-legislators/ocd-person%2Fabc-123',
    );
  });

  test('the state-legislators list path does not swallow its profile path', () => {
    expect(isDirectoryListPath('/directory/state-legislators')).toBe(true);
    expect(isDirectoryListPath('/directory/state-legislators/ocd-person%2Fabc')).toBe(false);
  });
});

describe('vNext route manifest', () => {
  test('no Directory destination is a gap any more', () => {
    const directory = VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'directory');
    expect(directory?.children?.map((child) => child.id)).toEqual([
      'congressional-staff',
      'committee-staff',
      'department-of-war',
      'state-legislators',
    ]);
    for (const child of directory?.children ?? []) {
      expect(child.availability).toBe('existing');
      expect(child.path).not.toBeNull();
    }
    expect(VNEXT_ROUTE_GAPS.some((gap) => gap.id.includes('staff'))).toBe(false);
  });

  test('manifest paths are the same constants the tabs use', () => {
    const directory = VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'directory');
    expect(directory?.children?.map((child) => child.path)).toEqual(DIRECTORY_TABS.map((t) => t.path));
  });
});
