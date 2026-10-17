/** Directory list, browse, staff and committee contracts. */

export type Chamber = 'House' | 'Senate' | 'Governor';
export type Party = 'D' | 'R' | 'I';
export type Region = 'Northeast' | 'South' | 'Midwest' | 'West';

export type CommitteeChamber = 'House' | 'Senate' | 'Joint';
export type CommitteeKind = 'committee' | 'subcommittee';

export interface DirectoryAddress {
  id: string;
  title: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  fax: string;
  isMain: boolean;
}

export interface DirectoryLink {
  label: string;
  url: string;
  type: string;
}

export interface DirectoryStaffMember {
  id: string;
  fullName: string;
  title: string;
  roles: string[];
  issueAreas: string[];
  email: string;
  phone: string;
  officeLocation: string;
  /** Whether this staffer holds a CURRENT position at this specific office —
   * not whether they're current anywhere on the Hill (see buildMemberStaff). */
  isCurrent: boolean;
}

export interface DirectoryContact {
  id: string;
  memberId: number;
  bioguideId: string;
  fullName: string;
  memberName: string;
  honorific: string;
  photoUrl: string;
  title: string;
  office: string;
  chamber: Chamber;
  state: string;
  district: string;
  party: Party;
  partyName: string;
  gender: 'F' | 'M' | 'Unknown';
  region: Region;
  isFreshman: boolean;
  servingSince: string;
  focusAreas: string[];
  committees: string[];
  committeeLeadership: string[];
  topIssues: Array<{ issue: string; stafferCount: number }>;
  leadershipPositions: string[];
  caucuses: string[];
  educationInstitutions: string[];
  senateClass: number | null;
  outgoingStatus: string | null;
  officeLocation: string;
  phone: string;
  fax: string;
  email: string;
  contactFormUrl: string;
  // Press/RSS overlay (member-press-v1.json, keyed by bioguide_id). Out-of-band
  // overlay merged at read-time — empty string when the member has no entry.
  newsPressUrl: string;
  rssFeedUrl: string;
  rssSource: string;
  officialLinks: DirectoryLink[];
  addresses: DirectoryAddress[];
  staff: DirectoryStaffMember[];
  /**
   * Populated ONLY by contacts search (`GET /contacts?q=…`) when the query
   * matched this office via one or more STAFFERS rather than the member's own
   * name/office — so the UI can explain why an office with a non-matching member
   * name was returned ("matched via staffer X"). Omitted on every other read.
   */
  matchedStaff?: Array<{ fullName: string; title: string }>;
  bio: {
    dob: string;
    hometown: string;
    birthplace: string;
    occupation: string;
    race: string;
    religion: string;
    pronunciation: string;
    narrative: string;
    education: string;
    military: string;
    relatives: string;
  };
  lastTouchpoint: string;
  owner: string;
  relationshipTier: 'Core' | 'Active' | 'Watch';
  notes: string;
  recentInteractions: Array<{
    date: string;
    channel: 'Call' | 'Email' | 'Meeting' | 'Dinner' | 'Briefing';
    summary: string;
  }>;
}

// Press/RSS overlay entry (member-press-v1.json), keyed by bioguide_id.
export interface MemberPressOverlay {
  newsPressUrl?: string;
  rssFeedUrl?: string;
  rssSource?: string;
}

// One press item served from member_press_item (ingested by sync-member-press).
export interface MemberNewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null; // ISO 8601, or null when the feed gave no date
  summary: string; // plain-text excerpt from the feed (NOT the full article)
}

// Payload for GET /directory/contacts/:id/news — the member's stored press items
// (latest first) + their press/RSS URLs. Pre-ingested; no live fetch on read.
export interface MemberNewsPayload {
  contactId: string;
  memberName: string;
  newsPressUrl: string | null;
  rssFeedUrl: string | null;
  rssSource: string | null;
  items: MemberNewsItem[];
  lastSyncedAt: string | null;
  feedError: 'no_feed' | null;
}

export type DirectorySort = 'recent' | 'name-asc' | 'name-desc' | 'state-asc' | 'chamber' | 'party';

export interface DirectoryQuery {
  q?: string;
  freshman?: string;
  chamber?: string;
  party?: string | string[];
  gender?: string;
  leadership?: string | string[];
  caucus?: string | string[];
  committee?: string | string[];
  state?: string | string[];
  district?: string | string[];
  education?: string | string[];
  region?: string;
  /**
   * Staff-derived office filters. A member has no role or issue of their own —
   * an office matches when *any* staffer on its roster does, which is the same
   * predicate `getStaffers` applies to a single staffer row. They exist so a
   * member-first list (Directory vNext Congressional Staff) can carry the Role
   * and Issue Area pills without narrowing to a staffer-first list, and they
   * close the DIR-8 filter gap #918 logged.
   */
  issue?: string | string[];
  role?: string | string[];
  sort?: string;
  page?: string | number;
  pageSize?: string | number;
}

export interface DirectoryTotals {
  all: number;
  house: number;
  senate: number;
  governors: number;
  staff: number;
}

export interface DirectoryStaffer {
  id: string;
  fullName: string;
  title: string;
  roles: string[];
  issueAreas: string[];
  email: string;
  phone: string;
  officeLocation: string;
  member: {
    id: string;
    fullName: string;
    memberName: string;
    chamber: Chamber;
    state: string;
    district: string;
    party: Party;
    partyName: string;
    photoUrl: string;
    title: string;
  };
}

export interface DirectoryStaffersPayload {
  staffers: DirectoryStaffer[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StaffersQuery {
  q?: string;
  chamber?: string;
  state?: string | string[];
  issue?: string | string[];
  page?: string | number;
  pageSize?: string | number;
}

export interface CommitteeMemberRef {
  id: string; // `member-${memberId}`
  name: string;
}

export interface DirectoryCommittee {
  id: string; // `committee-${officeId}`
  officeId: number;
  name: string;
  chamber: CommitteeChamber;
  kind: CommitteeKind;
  committeeCode: string | null;
  parentOfficeId: number | null; // subcommittee -> parent full committee
  staffCount: number; // distinct current staffers
  chair: CommitteeMemberRef | null;
  rankingMember: CommitteeMemberRef | null;
  viceChairs: string[];
  phone: string;
  officeLocation: string;
}

export interface DirectoryCommitteeStaffer {
  id: string; // `staff-${staffId}`
  fullName: string;
  title: string; // the committee position title
  email: string;
  phone: string;
  officeLocation: string;
  isCurrent: boolean;
  committee: {
    id: string;
    name: string;
    chamber: CommitteeChamber;
    kind: CommitteeKind;
  };
}

export interface CommitteesQuery {
  q?: string;
  chamber?: string;
  kind?: string;
  page?: string | number;
  pageSize?: string | number;
}

export interface DirectoryCommitteesPayload {
  committees: DirectoryCommittee[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CommitteeStaffQuery {
  q?: string;
  page?: string | number;
  pageSize?: string | number;
}

export interface DirectoryCommitteeStaffPayload {
  committee: DirectoryCommittee | null;
  staff: DirectoryCommitteeStaffer[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DirectoryAvailableFilters {
  chambers: Chamber[];
  parties: Array<{ value: Party; label: string }>;
  genders: Array<{ value: 'F' | 'M'; label: string }>;
  leadership: string[];
  committees: string[];
  issues: string[];
  /**
   * Functional staffer roles across every office — the value source for the
   * Role filter. Derived the same way `issues` is: a member has no role of
   * their own, so the vocabulary comes from the rosters.
   */
  roles: string[];
  caucuses: string[];
  states: string[];
  districts: string[];
  educationInstitutions: string[];
}

export interface DirectoryPayload {
  sourceId: string;
  contacts: DirectoryContact[];
  total: number;
  page: number;
  pageSize: number;
  totals: DirectoryTotals;
  availableStates: string[];
  availableFilters: DirectoryAvailableFilters;
}

export interface DirectoryEmailMatch {
  attendeeEmail: string;
  matchKind: 'member' | 'staff';
  directoryContactId: string;
  directoryContactName: string;
  member: {
    id: string;
    bioguideId: string;
    fullName: string;
    memberName: string;
    title: string;
    chamber: Chamber;
    state: string;
    district: string;
    partyName: string;
    officeLocation: string;
    phone: string;
    email: string;
    bio: DirectoryContact['bio'];
    committees: string[];
    leadershipPositions: string[];
    focusAreas: string[];
    addresses: DirectoryAddress[];
  };
  staff?: {
    id: string;
    fullName: string;
    title: string;
    email: string;
    phone: string;
    officeLocation: string;
    issueAreas: string[];
    roles: string[];
  };
}

/** Internal-bridge shapes (apps/workspace Hill Day); mirrored in that service. */
export interface DirectoryMemberContext {
  id: string;
  bioguideId: string;
  fullName: string;
  memberName: string;
  honorific: string;
  title: string;
  chamber: Chamber;
  state: string;
  district: string;
  party: Party;
  partyName: string;
  officeLocation: string;
  phone: string;
  email: string;
  bioNarrative: string;
  committees: string[];
  committeesWithRole: Array<{ name: string; role: string | null }>;
  committeeLeadership: string[];
  leadershipPositions: string[];
  focusAreas: string[];
  topIssues: Array<{ issue: string; stafferCount: number }>;
  staff: Array<{
    id: string;
    fullName: string;
    title: string;
    roles: string[];
    issueAreas: string[];
    email: string;
    isCurrent: boolean;
  }>;
}

export interface DirectoryStafferContext {
  id: string;
  fullName: string;
  title: string;
  roles: string[];
  issueAreas: string[];
  email: string;
  officeLocation: string;
  member: DirectoryMemberContext | null;
}

export interface DirectoryCommitteeStaffEmailMatch {
  attendeeEmail: string;
  staff: { id: string; fullName: string; title: string; email: string; isCurrent: boolean };
  committee: { id: string; name: string; chamber: CommitteeChamber; kind: CommitteeKind };
}

/**
 * Trimmed contact row for the internal-bridge Directory browse route (Hill
 * Day's "select a member directly" flow, mirroring Outreach's Directory tab).
 * Drops the CRM/relationship fields (`bio`, `lastTouchpoint`, `owner`,
 * `relationshipTier`, `notes`, `recentInteractions`, `matchedStaff`) that a
 * browse row never shows.
 */
export interface DirectoryBrowseContact {
  id: string;
  fullName: string;
  honorific: string;
  title: string;
  office: string;
  chamber: Chamber;
  state: string;
  district: string;
  party: Party;
  partyName: string;
  email: string;
  phone: string;
  committees: string[];
  leadershipPositions: string[];
  staff: Array<{
    id: string;
    fullName: string;
    title: string;
    roles: string[];
    issueAreas: string[];
    email: string;
    phone: string;
    officeLocation: string;
    isCurrent: boolean;
  }>;
}

export interface DirectoryBrowsePayload {
  contacts: DirectoryBrowseContact[];
  total: number;
  page: number;
  pageSize: number;
  availableStates: string[];
  availableChambers: Chamber[];
}

export interface CreateDirectoryContactNoteInput {
  body: string;
  directoryContactName?: string;
}
