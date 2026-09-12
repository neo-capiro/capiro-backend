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
  stateCommittees: '/directory/state-committees',
} as const;

/** Legacy entry point; resolves to Congressional Staff. */
export const DIRECTORY_LEGACY_ROUTE = '/directory';

export const DIRECTORY_PROFILE_ROUTES = {
  staff: (staffId: string) => `/directory/staff/${encodeURIComponent(staffId)}`,
  member: (memberId: string) => `/directory/members/${encodeURIComponent(memberId)}`,
  committee: (committeeId: string) => `/directory/committees/${encodeURIComponent(committeeId)}`,
  stateLegislator: (id: string) => `/directory/state-legislators/${encodeURIComponent(id)}`,
  stateCommittee: (id: string) => `/directory/state-committees/${encodeURIComponent(id)}`,
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
  {
    id: 'congressional-staff',
    label: 'Congressional Staff',
    path: DIRECTORY_ROUTES.congressionalStaff,
  },
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
  const normalized =
    search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : '';
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

/**
 * A matched deep-linkable directory profile path. Mirrors the canonical
 * App.tsx route params exactly:
 *   /directory/members/:memberId
 *   /directory/staff/:staffId
 *   /directory/committees/:committeeId
 *   /directory/state-legislators/:id       (OpenStates "ocd-person/…", encoded)
 *   /directory/districts/:state/:districtNo
 */
export type DirectoryProfileMatch =
  | { kind: 'member'; memberId: string }
  | { kind: 'staff'; staffId: string }
  | { kind: 'committee'; committeeId: string }
  | { kind: 'stateLegislator'; id: string }
  | { kind: 'stateCommittee'; id: string }
  | { kind: 'district'; state: string; districtNo: string };

/**
 * `useParams` decodes URI components; VNextRouter intercepts ABOVE the
 * canonical param `<Route>`s, so the module must decode the raw pathname
 * segments itself to hand pages the same values canonical pages saw. A
 * malformed escape sequence falls back to the raw segment rather than
 * throwing.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Extract the profile params from a directory profile pathname, or null when
 * the path is not a claimable profile. Canonical `:param` routes match exactly
 * one non-empty segment, so anything shallower or deeper returns null and
 * falls through to canonical routing (the 404 page, exactly as before).
 */
export function matchDirectoryProfilePath(pathname: string): DirectoryProfileMatch | null {
  if (!pathname.startsWith(`${DIRECTORY_LEGACY_ROUTE}/`)) return null;
  // Ignore React Router's tolerated trailing slash so `/members/x/` ≡ `/members/x`.
  const segments = pathname
    .slice(DIRECTORY_LEGACY_ROUTE.length + 1)
    .replace(/\/+$/, '')
    .split('/');
  const [section, ...params] = segments;
  if (!section || params.some((p) => p === '')) return null;

  if (params.length === 1 && params[0]) {
    const param = decodeSegment(params[0]);
    // Preserve older member-profile URLs; new links use the canonical route.
    if (section === 'members' || section === 'people') return { kind: 'member', memberId: param };
    if (section === 'staff') return { kind: 'staff', staffId: param };
    if (section === 'committees') return { kind: 'committee', committeeId: param };
    if (section === 'state-legislators') return { kind: 'stateLegislator', id: param };
    if (section === 'state-committees') return { kind: 'stateCommittee', id: param };
  }
  if (section === 'districts' && params.length === 2 && params[0] && params[1]) {
    return {
      kind: 'district',
      state: decodeSegment(params[0]),
      districtNo: decodeSegment(params[1]),
    };
  }
  return null;
}
