/**
 * Deep-linkable member/staff/committee detail + unified-people contracts (Task 12).
 * Every observed LegiStorm person field is exposed through these typed sections —
 * NOT a raw source blob. Null vs. unavailable is kept distinct (see `availability`).
 */
import type { DirectoryCommittee } from './directory.service.js';
import type { DirectoryCommitteeMembership, DirectoryPersonType } from './directory-indexes.js';
import type { DirectoryPhotoRecord, DirectoryPhotoSource } from './directory-photo.js';

export interface DirectoryContactMethod {
  type: string | null;
  value: string;
  updatedAt: string | null;
}

export interface DirectoryMemberOffice {
  officeId: number | null;
  name: string | null;
  officeTypeId: string | null;
  state: string | null;
  district: string | null;
  party: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string | null;
}

export interface DirectoryLeadershipEntry {
  position: string | null;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string | null;
}

export interface DirectoryStaffRoleEntry {
  memberId: number | null;
  roleName: string | null;
  updatedAt: string | null;
}

export interface DirectoryStaffIssueEntry {
  memberId: number | null;
  issueName: string | null;
  updatedAt: string | null;
}

export interface DirectoryStaffPosition {
  officeId: number | null;
  officeName: string | null;
  memberId: number | null;
  title: string | null;
  positionType: string | null;
  isCurrent: boolean;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string | null;
}

export interface DirectoryMemberDetail {
  kind: 'member';
  id: string;
  source: { snapshotId: string; memberId: number; lastUpdatedAt: string | null };
  identity: {
    memberId: number;
    bioguideId: string;
    icpsrId: number | null;
    lisMemberId: string | null;
    firstName: string;
    lastName: string;
    preferredFirstName: string | null;
    preferredLastName: string | null;
    suffix: string | null;
    gender: string | null;
  };
  bioDetails: {
    dob: string | null;
    placeOfBirth: string | null;
    hometown: string | null;
    partyName: string | null;
    occupation: string | null;
    pronunciation: string | null;
    raceName: string | null;
    religionName: string | null;
  };
  photos: DirectoryPhotoRecord[];
  selectedPhotoUrl: string | null;
  photoSource: DirectoryPhotoSource;
  offices: DirectoryMemberOffice[];
  committees: DirectoryCommitteeMembership[];
  leaderships: DirectoryLeadershipEntry[];
  socialContacts: DirectoryContactMethod[];
  staffRoles: DirectoryStaffRoleEntry[];
  staffIssues: DirectoryStaffIssueEntry[];
  enrichments: {
    bioOverlay: boolean;
    pressOverlay: boolean;
  };
}

export interface DirectoryStaffDetail {
  kind: 'staff';
  id: string;
  source: { snapshotId: string; staffId: number; lastUpdatedAt: string | null };
  identity: {
    staffId: number;
    firstName: string;
    lastName: string;
    preferredFirstName: string | null;
    preferredLastName: string | null;
    suffix: string | null;
    gender: string | null;
  };
  bioDetails: {
    dob: string | null;
    partyName: string | null;
    occupation: string | null;
  };
  photoUrl: string | null;
  photoSource: DirectoryPhotoSource;
  emails: DirectoryContactMethod[];
  socialContacts: DirectoryContactMethod[];
  positions: DirectoryStaffPosition[];
  memberAssociations: Array<{ id: string; memberId: number; fullName: string }>;
  committeeAssociations: DirectoryCommitteeMembership[];
  availability: {
    photo: 'available' | 'not_provided';
    socialContacts: 'available' | 'not_provided';
  };
}

export interface DirectoryCommitteeRef {
  id: string;
  officeId: number;
  name: string;
  kind: DirectoryCommittee['kind'];
}

export interface DirectoryCommitteeDetail extends DirectoryCommittee {
  parentCommittee: DirectoryCommitteeRef | null;
  subcommittees: DirectoryCommitteeRef[];
  contacts: DirectoryCommitteeMembership[];
  memberCount: number;
  currentStaffCount: number;
}

export interface DirectoryPersonResult {
  personType: DirectoryPersonType;
  id: string;
  fullName: string;
  title: string;
  photoUrl: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  isCurrent: boolean;
  /** When a committee query matched via this person, the evidence for the match. */
  matchedVia?: { committeeId: string; committeeName: string; role: string | null } | null;
}

export interface DirectoryPeoplePayload {
  people: DirectoryPersonResult[];
  total: number;
  page: number;
  pageSize: number;
}
