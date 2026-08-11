import type { DirectoryStaffer } from '../../../pages/directory/directoryData.js';
import type { CongressionalStaffModel } from '../../pages/directory/useCongressionalStaffModel.js';
import { CHAMBER_OPTIONS, CONGRESSIONAL_STAFF_PAGE_SIZE } from '../../pages/directory/useCongressionalStaffModel.js';

/**
 * Congressional Staff visual fixture (Figma `937:2539`).
 *
 * Layout fixture only — these are not real people and no capture taken from
 * this harness is evidence about production data. The rows exist to exercise
 * the geometry the design specifies: two-line cells in every column, a long
 * office string that must not wrap the grid, a row with no phone (so the
 * "No phone" fallback is visible), and one selected row driving the rail.
 *
 * Figma's own fixture carries prototype labels ("6 SAMPLE RECORDS · LAYOUT
 * FIXTURE", "· sample") and a blank COVERAGE header. None of that ships, so
 * none of it is reproduced here.
 */

function staffer(
  id: string,
  fullName: string,
  title: string,
  roles: string[],
  issueAreas: string[],
  email: string,
  phone: string,
  officeLocation: string,
  member: DirectoryStaffer['member'],
): DirectoryStaffer {
  return { id, fullName, title, roles, issueAreas, email, phone, officeLocation, member };
}

function member(
  id: string,
  memberName: string,
  chamber: DirectoryStaffer['member']['chamber'],
  state: string,
  district: string,
  party: DirectoryStaffer['member']['party'],
  partyName: string,
  title: string,
): DirectoryStaffer['member'] {
  return {
    id,
    fullName: memberName,
    memberName,
    chamber,
    state,
    district,
    party,
    partyName,
    photoUrl: '',
    title,
  };
}

/** Held separately because it is also the selected row driving the rail. */
const SELECTED_STAFFER: DirectoryStaffer = staffer(
  'staff-fixture-1',
  'Grace Hopper',
  'Legislative Director',
  ['Military Legislative Assistant'],
  ['Defense', 'Appropriations'],
  'grace.hopper@house.gov',
  '202-555-0142',
  'Personal office',
  member('m-1', 'Elaine Morgan', 'House', 'VA', '10', 'D', 'Democrat', 'Representative'),
);

const STAFFERS: DirectoryStaffer[] = [
  SELECTED_STAFFER,
  staffer(
    'staff-fixture-2',
    'Marcus Ellery',
    'Chief of Staff',
    ['Chief of Staff'],
    ['Trade', 'Tax'],
    'marcus.ellery@senate.gov',
    '202-555-0118',
    'Russell Senate Office Building',
    member('m-2', 'Theodore Vance', 'Senate', 'OH', '', 'R', 'Republican', 'Senator'),
  ),
  staffer(
    'staff-fixture-3',
    'Priya Raghunathan',
    'Senior Policy Advisor',
    ['Policy Advisor', 'Health LA'],
    ['Health', 'Veterans Affairs'],
    'priya.raghunathan@house.gov',
    '',
    'Longworth House Office Building',
    member('m-3', 'Danielle Okafor', 'House', 'CA', '32', 'D', 'Democrat', 'Representative'),
  ),
  staffer(
    'staff-fixture-4',
    'Jonah Whitfield',
    'Legislative Assistant',
    ['Legislative Assistant'],
    ['Energy'],
    'jonah.whitfield@senate.gov',
    '202-555-0177',
    'Personal office',
    member('m-4', 'Robert Callahan', 'Senate', 'WY', '', 'R', 'Republican', 'Senator'),
  ),
  staffer(
    'staff-fixture-5',
    'Amara Osei',
    'Communications Director',
    ['Communications Director'],
    [],
    'amara.osei@house.gov',
    '202-555-0163',
    'Cannon House Office Building',
    member('m-5', 'Steven Brightwater', 'House', 'NY', '7', 'D', 'Democrat', 'Representative'),
  ),
  staffer(
    'staff-fixture-6',
    'Daniel Kestrel',
    'Deputy Chief of Staff',
    ['Deputy Chief of Staff', 'Approps LA'],
    ['Appropriations', 'Transportation'],
    'daniel.kestrel@senate.gov',
    '202-555-0190',
    'Dirksen Senate Office Building',
    member('m-6', 'Margaret Lindqvist', 'Senate', 'MN', '', 'D', 'Democrat', 'Senator'),
  ),
];

const noop = () => undefined;

/**
 * Default capture state: loaded, one row selected so the rail renders its
 * populated form, and the detail contract resolved *without* a `source` — the
 * "Provenance unavailable" line is a real state the design must show, not an
 * error, so the baseline captures it rather than hiding it.
 */
export const CONGRESSIONAL_STAFF_VISUAL_FIXTURE: CongressionalStaffModel = {
  search: { text: '', onChange: noop },
  filters: {
    chamber: [],
    state: [],
    issue: [],
    chamberOptions: CHAMBER_OPTIONS,
    stateOptions: [
      { value: 'CA', label: 'CA' },
      { value: 'MN', label: 'MN' },
      { value: 'NY', label: 'NY' },
      { value: 'OH', label: 'OH' },
      { value: 'VA', label: 'VA' },
      { value: 'WY', label: 'WY' },
    ],
    issueOptions: [
      { value: 'Appropriations', label: 'Appropriations' },
      { value: 'Defense', label: 'Defense' },
      { value: 'Energy', label: 'Energy' },
      { value: 'Health', label: 'Health' },
      { value: 'Tax', label: 'Tax' },
      { value: 'Trade', label: 'Trade' },
      { value: 'Transportation', label: 'Transportation' },
      { value: 'Veterans Affairs', label: 'Veterans Affairs' },
    ],
    hasAny: false,
    onChange: noop,
    onClearAll: noop,
  },
  results: {
    staffers: STAFFERS,
    // Larger than one page on purpose: the pagination row is part of the
    // captured geometry and only renders when total exceeds the page size.
    total: 42,
    isInitialLoading: false,
    isRefetching: false,
    isError: false,
    onRetry: noop,
  },
  pagination: {
    page: 1,
    totalPages: Math.max(1, Math.ceil(42 / CONGRESSIONAL_STAFF_PAGE_SIZE)),
    pageSize: CONGRESSIONAL_STAFF_PAGE_SIZE,
    onPageChange: noop,
  },
  selection: {
    selectedId: SELECTED_STAFFER.id,
    selected: SELECTED_STAFFER,
    onToggle: noop,
    onOpenProfile: noop,
    detail: {
      isLoading: false,
      isError: false,
      committeeNames: 'Ranking Member · Subcommittee Chair',
      sourceSnapshotId: null,
      onRetry: noop,
    },
  },
};

/** Empty-result state, kept alongside so the two can be captured as a pair. */
export const CONGRESSIONAL_STAFF_EMPTY_FIXTURE: CongressionalStaffModel = {
  ...CONGRESSIONAL_STAFF_VISUAL_FIXTURE,
  filters: { ...CONGRESSIONAL_STAFF_VISUAL_FIXTURE.filters, hasAny: true },
  results: {
    ...CONGRESSIONAL_STAFF_VISUAL_FIXTURE.results,
    staffers: [],
    total: 0,
  },
  pagination: { ...CONGRESSIONAL_STAFF_VISUAL_FIXTURE.pagination, totalPages: 1 },
  selection: {
    ...CONGRESSIONAL_STAFF_VISUAL_FIXTURE.selection,
    selectedId: null,
    selected: null,
  },
};
