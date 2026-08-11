/**
 * Directory vNext route contract (Figma `941:2860`).
 *
 * Four first-class list routes plus the Department of War person profile. The
 * legacy `/directory` URL stays a backward-compatible Congressional Staff entry
 * point, and resolving it must preserve the query string so existing links,
 * bookmarks and shared searches keep working.
 *
 * Profile destinations are unchanged canonical routes — Congressional *and*
 * committee staff both resolve to `/directory/staff/:staffId`, because a person
 * appearing in Committee Staff is the same identity, not a copy.
 */
export const DIRECTORY_ROUTES = {
  congressionalStaff: '/directory/congressional-staff',
  committeeStaff: '/directory/committee-staff',
  departmentOfWar: '/directory/department-of-war',
  stateLegislators: '/directory/state-legislators',
} as const;

/** Legacy entry point; resolves to Congressional Staff. */
export const DIRECTORY_LEGACY_ROUTE = '/directory';

export const DIRECTORY_PROFILE_ROUTES = {
  staff: (staffId: string) => `/directory/staff/${encodeURIComponent(staffId)}`,
  member: (memberId: string) => `/directory/members/${encodeURIComponent(memberId)}`,
  committee: (committeeId: string) => `/directory/committees/${encodeURIComponent(committeeId)}`,
  stateLegislator: (id: string) => `/directory/state-legislators/${encodeURIComponent(id)}`,
  departmentOfWarPerson: (personId: string) =>
    `/directory/department-of-war/${encodeURIComponent(personId)}`,
} as const;

export interface DirectoryTab {
  id: string;
  label: string;
  path: string;
}

/** Route tabs, in the order the Directory screens render them. */
export const DIRECTORY_TABS: readonly DirectoryTab[] = [
  { id: 'congressional-staff', label: 'Congressional Staff', path: DIRECTORY_ROUTES.congressionalStaff },
  { id: 'committee-staff', label: 'Committee Staff', path: DIRECTORY_ROUTES.committeeStaff },
  { id: 'department-of-war', label: 'Department of War', path: DIRECTORY_ROUTES.departmentOfWar },
  { id: 'state-legislators', label: 'State Legislators', path: DIRECTORY_ROUTES.stateLegislators },
];

/**
 * Target for a legacy `/directory` hit. Returns a path with the original search
 * preserved verbatim — the redirect is an information-architecture change, not a
 * reason to silently drop a caller's filters.
 */
export function resolveLegacyDirectoryTarget(search: string): string {
  const normalized = search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : '';
  return `${DIRECTORY_ROUTES.congressionalStaff}${normalized}`;
}

/**
 * `/directory/state-legislators` is a list route while
 * `/directory/state-legislators/:id` is a profile. They share a prefix, so the
 * list surface must only claim the exact path.
 */
export function isDirectoryListPath(pathname: string): boolean {
  return (Object.values(DIRECTORY_ROUTES) as string[]).includes(pathname);
}
