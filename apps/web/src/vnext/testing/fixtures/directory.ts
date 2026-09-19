import type { DirectoryEntry, DirectoryStaffMember } from '../../../pages/directory/directoryData.js';
import type {
  CongressionalOfficeRow,
  CongressionalStaffModel,
} from '../../pages/directory/useCongressionalStaffModel.js';
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
 * The list reads member-first with the roster nested beneath, so the fixture
 * covers the states that only a hierarchy has: an expanded office, a collapsed
 * one, an office whose roster is empty, and an office whose roster the filters
 * have narrowed. No fixture member carries a `photoUrl` — the harness is
 * offline and a broken <img> would be captured as design, not as a missing
 * asset; the initials fallback is the honest offline rendering.
 *
 * Figma's own fixture carries prototype labels ("6 SAMPLE RECORDS · LAYOUT
 * FIXTURE", "· sample"). None of that ships, so none of it is reproduced here.
 */

function staff(
  id: string,
  fullName: string,
  title: string,
  roles: string[],
  issueAreas: string[],
  email: string,
  phone: string,
  officeLocation: string,
  isCurrent = true,
): DirectoryStaffMember {
  return { id, fullName, title, roles, issueAreas, email, phone, officeLocation, isCurrent };
}

/** Only the fields this screen reads; the contract is far wider. */
function member(
  id: string,
  fullName: string,
  chamber: DirectoryEntry['chamber'],
  state: string,
  district: string,
  party: DirectoryEntry['party'],
  partyName: string,
  title: string,
  committees: string[],
  roster: DirectoryStaffMember[],
  email: string,
  phone: string,
): DirectoryEntry {
  const memberName = fullName.replace(/^(?:Rep|Sen)\.\s*/, '');
  return {
    id,
    memberId: Number(id.replace(/\D+/g, '')) || 0,
    bioguideId: '',
    fullName,
    memberName,
    honorific: chamber === 'Senate' ? 'Sen.' : 'Rep.',
    photoUrl: '',
    title,
    office: `${memberName} office (${[state, district].filter(Boolean).join('-')})`,
    chamber,
    state,
    district,
    party,
    partyName,
    gender: 'Unknown',
    region: 'South',
    isFreshman: false,
    servingSince: '',
    focusAreas: roster.flatMap((person) => person.issueAreas),
    committees,
    committeeLeadership: [],
    topIssues: [],
    leadershipPositions: [],
    caucuses: [],
    educationInstitutions: [],
    senateClass: null,
    outgoingStatus: null,
    officeLocation: chamber === 'Senate' ? 'Russell Senate Office Building' : 'Cannon House Office Building',
    phone,
    fax: '',
    email,
    contactFormUrl: '',
    officialLinks: [],
    addresses: [],
    staff: roster,
    bio: {
      dob: '',
      hometown: '',
      birthplace: '',
      occupation: '',
      race: '',
      religion: '',
      pronunciation: '',
      narrative: '',
      education: '',
      military: '',
      relatives: '',
    },
    lastTouchpoint: '',
    owner: '',
    relationshipTier: 'Watch',
    notes: '',
    recentInteractions: [],
  };
}

/** Held separately because it is also the selected row driving the rail. */
const SELECTED_STAFFER = staff(
  'staff-fixture-1',
  'Grace Hopper',
  'Legislative Director',
  ['Military Legislative Assistant'],
  ['Defense', 'Appropriations'],
  'grace.hopper@house.gov',
  '202-555-0142',
  'Personal office',
);

const MORGAN = member(
  'member-1',
  'Rep. Elaine Morgan',
  'House',
  'VA',
  '10',
  'D',
  'Democrat',
  'Member of Congress',
  ['House Armed Services', 'House Appropriations'],
  [
    SELECTED_STAFFER,
    staff(
      'staff-fixture-2',
      'Marcus Ellery',
      'Chief of Staff',
      ['Chief of Staff'],
      ['Trade', 'Tax'],
      'marcus.ellery@house.gov',
      '202-555-0118',
      'Longworth House Office Building',
    ),
    staff(
      'staff-fixture-3',
      'Priya Raghunathan',
      'Senior Policy Advisor',
      ['Policy Advisor', 'Health LA'],
      ['Health', 'Veterans Affairs'],
      'priya.raghunathan@house.gov',
      // No phone: the "No phone" fallback has to be visible in a capture.
      '',
      'Longworth House Office Building',
    ),
  ],
  'elaine.morgan@house.gov',
  '202-225-0110',
);

const VANCE = member(
  'member-2',
  'Sen. Theodore Vance',
  'Senate',
  'OH',
  '',
  'R',
  'Republican',
  'Member of Congress',
  ['Senate Finance'],
  [
    staff(
      'staff-fixture-4',
      'Jonah Whitfield',
      'Legislative Assistant',
      ['Legislative Assistant'],
      ['Energy'],
      'jonah.whitfield@senate.gov',
      '202-555-0177',
      'Personal office',
    ),
    staff(
      'staff-fixture-5',
      'Amara Osei',
      'Communications Director',
      ['Communications Director'],
      [],
      'amara.osei@senate.gov',
      '202-555-0163',
      'Russell Senate Office Building',
    ),
  ],
  'contact@vance.senate.gov',
  '202-224-0220',
);

const OKAFOR = member(
  'member-3',
  'Rep. Danielle Okafor',
  'House',
  'CA',
  '32',
  'D',
  'Democrat',
  'Member of Congress',
  [],
  [],
  '',
  '202-225-0320',
);

const LINDQVIST = member(
  'member-4',
  'Sen. Margaret Lindqvist',
  'Senate',
  'MN',
  '',
  'D',
  'Democrat',
  'Member of Congress',
  ['Senate Energy and Natural Resources'],
  [
    staff(
      'staff-fixture-6',
      'Daniel Kestrel',
      'Deputy Chief of Staff',
      ['Deputy Chief of Staff', 'Approps LA'],
      ['Appropriations', 'Transportation'],
      'daniel.kestrel@senate.gov',
      '202-555-0190',
      'Dirksen Senate Office Building',
    ),
    staff(
      'staff-fixture-7',
      'Ruth Alderman',
      'Scheduler',
      ['Scheduler'],
      [],
      'ruth.alderman@senate.gov',
      '202-555-0191',
      'Dirksen Senate Office Building',
    ),
  ],
  'contact@lindqvist.senate.gov',
  '202-224-0440',
);

const OFFICES: CongressionalOfficeRow[] = [
  // Expanded: the roster rows, guide rail and elbows are the point of the capture.
  { member: MORGAN, staff: MORGAN.staff, staffTotal: MORGAN.staff.length, isExpanded: true },
  // Collapsed, so both disclosure states appear in one frame.
  { member: VANCE, staff: VANCE.staff, staffTotal: VANCE.staff.length, isExpanded: false },
  // Expanded with nothing to show — a real state, not an error.
  { member: OKAFOR, staff: [], staffTotal: 0, isExpanded: true },
  // Narrowed by the filters: "1 of 2 staff match" rather than a silent subset.
  { member: LINDQVIST, staff: LINDQVIST.staff.slice(0, 1), staffTotal: 2, isExpanded: true },
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
    role: [],
    committee: [],
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
    roleOptions: [
      { value: 'Chief of Staff', label: 'Chief of Staff' },
      { value: 'Communications Director', label: 'Communications Director' },
      { value: 'Legislative Assistant', label: 'Legislative Assistant' },
      { value: 'Legislative Director', label: 'Legislative Director' },
      { value: 'Policy Advisor', label: 'Policy Advisor' },
    ],
    committeeOptions: [
      { value: 'House Appropriations', label: 'House Appropriations' },
      { value: 'House Armed Services', label: 'House Armed Services' },
      { value: 'Senate Energy and Natural Resources', label: 'Senate Energy and Natural Resources' },
      { value: 'Senate Finance', label: 'Senate Finance' },
    ],
    hasAny: false,
    onChange: noop,
    onClearAll: noop,
  },
  results: {
    offices: OFFICES,
    // Larger than one page on purpose: the pagination row is part of the
    // captured geometry and only renders when total exceeds the page size.
    total: 42,
    staffTotal: 318,
    isInitialLoading: false,
    isRefetching: false,
    isError: false,
    onRetry: noop,
    onToggleExpand: noop,
    onExpandAll: noop,
    onCollapseAll: noop,
    allExpanded: false,
  },
  pagination: {
    page: 1,
    totalPages: Math.max(1, Math.ceil(42 / CONGRESSIONAL_STAFF_PAGE_SIZE)),
    pageSize: CONGRESSIONAL_STAFF_PAGE_SIZE,
    onPageChange: noop,
  },
  selection: {
    selectedId: SELECTED_STAFFER.id,
    selected: { kind: 'staff', id: SELECTED_STAFFER.id, staff: SELECTED_STAFFER, member: MORGAN },
    onToggle: noop,
    onOpenProfile: noop,
    detail: {
      isLoading: false,
      isError: false,
      committeeNames: 'Ranking Member · Subcommittee Chair',
      // Offline harness: a real URL here would capture as a broken image.
      photoUrl: null,
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
    offices: [],
    total: 0,
    staffTotal: 0,
  },
  pagination: { ...CONGRESSIONAL_STAFF_VISUAL_FIXTURE.pagination, totalPages: 1 },
  selection: {
    ...CONGRESSIONAL_STAFF_VISUAL_FIXTURE.selection,
    selectedId: null,
    selected: null,
  },
};


import type { CommitteeStaffModel } from '../../pages/directory/useCommitteeStaffModel.js';
import type { DowModel } from '../../pages/directory/useDowModel.js';
import type { StateLegModel } from '../../pages/directory/useStateLegislatorsModel.js';
import type { DirectoryCommitteeStaffer } from '../../../pages/directory/directoryData.js';
import type { AcquisitionPersonnelListItem } from '../../../pages/program-element/types.js';
import type { StateLegislatorRow } from '../../../pages/directory/StateLegislatorDirectory.js';

/**
 * Committee Staff / Department of War / State Legislators visual fixtures —
 * same disclaimer as CONGRESSIONAL_STAFF_VISUAL_FIXTURE above: these are not
 * real people, offices or programs. Names read as obviously synthetic
 * ("X Fixture"), emails are `@fixture.invalid`, and no fixture carries a
 * photo URL — the harness is offline, so the initials fallback is the honest
 * rendering. The three named committee units (TALF, READY, SEA) and their
 * structure are reused from design-handoff_directory/01-INFORMATION-
 * ARCHITECTURE.md as layout shapes only, not as real HASC data.
 */

const COMMITTEE_DETAIL = { id: 'fixture-hasc', officeId: 9001, name: 'House Armed Services Committee', chamber: 'House' as const, kind: 'committee' as const, committeeCode: 'HASC', parentOfficeId: null, staffCount: 6, phone: '202-555-0100', officeLocation: 'Fixture Capitol office', chair: { id: 'fixture-chair', name: 'Fixture Chair' }, rankingMember: { id: 'fixture-ranking', name: 'Fixture Ranking Member' }, viceChairs: [] };
const COMMITTEE_UNITS = [
  { id: 'fixture-talf', officeId: 9002, name: 'Tactical Air & Land Forces', kind: 'subcommittee' as const },
  { id: 'fixture-ready', officeId: 9003, name: 'Readiness Subcommittee', kind: 'subcommittee' as const },
  { id: 'fixture-sea', officeId: 9004, name: 'Seapower & Projection Forces', kind: 'subcommittee' as const },
];
function committeeStaff(id: string, name: string, title: string, unit: typeof COMMITTEE_UNITS[number]): DirectoryCommitteeStaffer { return { id, fullName: name, title, email: `${id}@fixture.invalid`, phone: '', officeLocation: 'Fixture office', isCurrent: true, committee: { id: unit.id, name: unit.name, chamber: 'House', kind: 'subcommittee' } }; }
const COMMITTEE_GROUPS = COMMITTEE_UNITS.map((unit, index) => ({ committeeId: unit.id, name: unit.name, shortName: unit.name, kind: 'subcommittee' as const, chamber: 'House' as const, staff: index === 0 ? [committeeStaff('fixture-morgan', 'Morgan Fixture', 'Policy Lead', unit), committeeStaff('fixture-nina', 'Nina Fixture', 'Staff Director', unit)] : index === 1 ? [committeeStaff('fixture-sam', 'Sam Fixture', 'Readiness Lead', unit), committeeStaff('fixture-chris', 'Chris Fixture', 'Counsel', unit)] : [committeeStaff('fixture-claire', 'Claire Fixture', 'Seapower Lead', unit), committeeStaff('fixture-avery', 'Avery Fixture', 'Legislative Assistant', unit)], currentCount: 2, formerCount: 0, isLoading: false }));
const COMMITTEE_MODEL: CommitteeStaffModel = { search: { text: '', onChange: noop }, view: { current: 'hierarchy', onChange: noop }, committee: { selectedId: COMMITTEE_DETAIL.id, options: [{ value: COMMITTEE_DETAIL.id, label: COMMITTEE_DETAIL.name }], committees: [{ ...COMMITTEE_DETAIL }], onSelect: noop, detail: COMMITTEE_DETAIL, isLoadingList: false, units: COMMITTEE_UNITS, isLoadingUnits: false }, filters: { chamber: [], chamberOptions: [{ value: 'House', label: 'House' }], hasAny: false, onChange: noop, onClearAll: noop }, results: { staff: COMMITTEE_GROUPS.flatMap((g) => g.staff), total: 6, groups: COMMITTEE_GROUPS, isLoadingGroups: false, isInitialLoading: false, isRefetching: false, isError: false, onRetry: noop }, selection: { selectedId: null, selected: null, onToggle: noop, onOpenProfile: noop } };
export const COMMITTEE_STAFF_VISUAL_FIXTURE = COMMITTEE_MODEL;
export const COMMITTEE_STAFF_EMPTY_FIXTURE: CommitteeStaffModel = { ...COMMITTEE_MODEL, filters: { ...COMMITTEE_MODEL.filters, hasAny: true }, results: { ...COMMITTEE_MODEL.results, staff: [], total: 0, groups: [] } };

function dow(id: string, name: string, aligned: boolean): AcquisitionPersonnelListItem { return { id, fullName: name, service: 'ARMY', organization: aligned ? 'PEO Ground Combat Systems' : 'Fixture Contracting Directorate', title: 'Fixture Program Lead', role: aligned ? 'PEO' : 'KO', pePrimary: aligned ? 'PE-FIX-01' : null, peSecondary: [], emailDomain: 'fixture.invalid', publicProfileUrl: null, headshotUrl: null, confidence: 0, status: 'fixture', firstSeenAt: '', lastSeenAt: '', sourceCount: 0 }; }
const DOW_PERSONS = [dow('fixture-dow-1', 'Alex Fixture', true), dow('fixture-dow-2', 'Jordan Fixture', false)];
const DOW_MODEL: DowModel = { search: { text: '', onChange: noop }, filters: { pe: [], service: [], role: [], org: [], peOptions: [{ value: 'aligned', label: 'PE-aligned' }, { value: 'unaligned', label: 'Unaligned' }], serviceOptions: [], roleOptions: [], orgOptions: [], hasAny: false, onChange: noop, onClearAll: noop }, results: { persons: DOW_PERSONS, total: 2, isInitialLoading: false, isRefetching: false, isError: false, onRetry: noop }, pagination: { page: 1, totalPages: 1, pageSize: 12, onPageChange: noop }, selection: { selectedId: null, selected: null, onToggle: noop, onOpenProfile: noop, detail: { isLoading: false, isError: false, detail: null, onRetry: noop } } };
export const DOW_VISUAL_FIXTURE = DOW_MODEL;
export const DOW_EMPTY_FIXTURE: DowModel = { ...DOW_MODEL, filters: { ...DOW_MODEL.filters, hasAny: true }, results: { ...DOW_MODEL.results, persons: [], total: 0 } };

function legislator(id: string, name: string, billCount: number | null, enactedCount: number | null): StateLegislatorRow { return { id, name, state: 'VA', chamber: 'House', district: 'Fixture district', party: 'Fixture party', email: null, image: null, url: null, committeeCount: 0, billCount, enactedCount }; }
const STATE_PERSONS = [legislator('fixture-state-1', 'Taylor Fixture', 0, 0), legislator('fixture-state-2', 'Casey Fixture', null, null)];
const STATE_MODEL: StateLegModel = { search: { text: '', onChange: noop }, filters: { state: [], chamber: [], party: [], stateOptions: [{ value: 'VA', label: 'VA' }], chamberOptions: [{ value: 'House', label: 'House' }], partyOptions: [{ value: 'Fixture party', label: 'Fixture party' }], hasAny: false, onChange: noop, onClearAll: noop }, results: { legislators: STATE_PERSONS, total: 2, isInitialLoading: false, isRefetching: false, isError: false, onRetry: noop }, pagination: { page: 1, totalPages: 1, pageSize: 12, onPageChange: noop }, selection: { selectedId: null, selected: null, onToggle: noop, onOpenProfile: noop, detail: { isLoading: false, isError: false, detail: null, onRetry: noop } } };
export const STATE_LEGISLATORS_VISUAL_FIXTURE = STATE_MODEL;
export const STATE_LEGISLATORS_EMPTY_FIXTURE: StateLegModel = { ...STATE_MODEL, filters: { ...STATE_MODEL.filters, hasAny: true }, results: { ...STATE_MODEL.results, legislators: [], total: 0 } };
