export type Chamber = 'House' | 'Senate' | 'Governor';
export type Party = 'D' | 'R' | 'I';
export type RelationshipTier = 'Core' | 'Active' | 'Watch';

export interface DirectoryInteraction {
  date: string;
  channel: 'Call' | 'Email' | 'Meeting' | 'Dinner' | 'Briefing';
  summary: string;
}

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
}

export interface DirectoryEntry {
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
  region: 'Northeast' | 'South' | 'Midwest' | 'West';
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
  officialLinks: DirectoryLink[];
  addresses: DirectoryAddress[];
  staff: DirectoryStaffMember[];
  /**
   * Set by contacts search when this office matched the query via one or more
   * staffers rather than the member's own name — so the UI can show "matched via
   * staffer X". Absent on non-search reads.
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
  relationshipTier: RelationshipTier;
  notes: string;
  recentInteractions: DirectoryInteraction[];
}

export interface DirectoryApiResponse {
  sourceId: string;
  contacts: DirectoryEntry[];
  total: number;
  page: number;
  pageSize: number;
  totals: {
    all: number;
    house: number;
    senate: number;
    governors: number;
    staff: number;
  };
  availableStates: string[];
  availableFilters: {
    chambers: Chamber[];
    parties: Array<{ value: Party; label: string }>;
    genders: Array<{ value: 'F' | 'M'; label: string }>;
    leadership: string[];
    committees: string[];
    issues: string[];
    /** Functional staffer roles; value source for the Directory Role filter. */
    roles: string[];
    caucuses: string[];
    states: string[];
    districts: string[];
    educationInstitutions: string[];
  };
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

export interface DirectoryStaffersResponse {
  staffers: DirectoryStaffer[];
  total: number;
  page: number;
  pageSize: number;
}

export type CommitteeChamber = 'House' | 'Senate' | 'Joint';
export type CommitteeKind = 'committee' | 'subcommittee';

export interface CommitteeMemberRef {
  id: string;
  name: string;
}

export interface DirectoryCommittee {
  id: string;
  officeId: number;
  name: string;
  chamber: CommitteeChamber;
  kind: CommitteeKind;
  committeeCode: string | null;
  parentOfficeId: number | null;
  staffCount: number;
  chair: CommitteeMemberRef | null;
  rankingMember: CommitteeMemberRef | null;
  viceChairs: string[];
  phone: string;
  officeLocation: string;
}

export interface DirectoryCommitteeStaffer {
  id: string;
  fullName: string;
  title: string;
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

export interface DirectoryCommitteesResponse {
  committees: DirectoryCommittee[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DirectoryCommitteeStaffResponse {
  committee: DirectoryCommittee | null;
  staff: DirectoryCommitteeStaffer[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DirectoryContactNote {
  id: string;
  directoryContactId: string;
  directoryContactName: string | null;
  body: string;
  createdAt: string;
  createdBy: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
}
